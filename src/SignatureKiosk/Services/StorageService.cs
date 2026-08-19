using System.Text.Json;
using SignatureKiosk.Models;

namespace SignatureKiosk.Services;

/// <summary>
/// File-based persistence for the prototype: JSON documents + image/signature files
/// under a single data directory. No external database required.
/// </summary>
public class StorageService
{
    private readonly string _dataDir;
    private readonly object _lock = new();
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
    {
        WriteIndented = true
    };

    public StorageService(IConfiguration config, IHostEnvironment env)
    {
        var configured = config["DataDir"];
        _dataDir = string.IsNullOrWhiteSpace(configured)
            ? Path.Combine(env.ContentRootPath, "data")
            : configured!;
        Directory.CreateDirectory(_dataDir);
        Directory.CreateDirectory(ImagesDir);
        Directory.CreateDirectory(SignaturesDir);
    }

    public string DataDir => _dataDir;
    public string ImagesDir => Path.Combine(_dataDir, "images");
    public string SignaturesDir => Path.Combine(_dataDir, "signatures");
    private string StatesPath => Path.Combine(_dataDir, "states.json");
    private string DevicesPath => Path.Combine(_dataDir, "devices.json");
    private string DocumentPath => Path.Combine(_dataDir, "document.json");
    private string ImagesIndexPath => Path.Combine(_dataDir, "images.json");

    // ---------------- States ----------------

    public StateStore GetStates()
    {
        lock (_lock) return ReadOr(StatesPath, () => new StateStore());
    }

    public void SaveStates(StateStore states)
    {
        lock (_lock) Write(StatesPath, states);
    }

    /// <summary>Resolve the effective state for a device (its override, or a copy of the default).</summary>
    public KioskState ResolveState(string deviceId)
    {
        lock (_lock)
        {
            var states = ReadOr(StatesPath, () => new StateStore());
            return states.Devices.TryGetValue(deviceId, out var s) ? s.Clone() : states.Default.Clone();
        }
    }

    // ---------------- Devices ----------------

    public List<DeviceInfo> GetDevices()
    {
        lock (_lock) return ReadOr(DevicesPath, () => new List<DeviceInfo>());
    }

    public DeviceInfo UpsertDevice(string id, string? name)
    {
        lock (_lock)
        {
            var list = ReadOr(DevicesPath, () => new List<DeviceInfo>());
            var dev = list.FirstOrDefault(d => d.Id == id);
            var now = DateTime.UtcNow;
            if (dev == null)
            {
                dev = new DeviceInfo
                {
                    Id = id,
                    Name = string.IsNullOrWhiteSpace(name) ? id : name!.Trim(),
                    FirstSeenUtc = now,
                    LastSeenUtc = now
                };
                list.Add(dev);
            }
            else
            {
                dev.LastSeenUtc = now;
                // Adopt a provided name only if the device has no explicit name yet.
                if (!string.IsNullOrWhiteSpace(name) && (string.IsNullOrWhiteSpace(dev.Name) || dev.Name == dev.Id))
                    dev.Name = name!.Trim();
            }
            Write(DevicesPath, list);
            return dev;
        }
    }

    public bool RenameDevice(string id, string name)
    {
        lock (_lock)
        {
            var list = ReadOr(DevicesPath, () => new List<DeviceInfo>());
            var dev = list.FirstOrDefault(d => d.Id == id);
            if (dev == null) return false;
            dev.Name = string.IsNullOrWhiteSpace(name) ? dev.Id : name.Trim();
            Write(DevicesPath, list);
            return true;
        }
    }

    // ---------------- Images ----------------

    public List<ImageInfo> GetImages()
    {
        lock (_lock) return ReadOr(ImagesIndexPath, () => new List<ImageInfo>());
    }

    public ImageInfo AddImage(Stream content, string originalName, string ext)
    {
        lock (_lock)
        {
            var id = Guid.NewGuid().ToString("N");
            ext = ext.StartsWith('.') ? ext : "." + ext;
            var fileName = id + ext;
            using (var fs = File.Create(Path.Combine(ImagesDir, fileName)))
                content.CopyTo(fs);
            var list = ReadOr(ImagesIndexPath, () => new List<ImageInfo>());
            var info = new ImageInfo
            {
                Id = id,
                FileName = fileName,
                OriginalName = originalName,
                UploadedUtc = DateTime.UtcNow
            };
            list.Add(info);
            Write(ImagesIndexPath, list);
            return info;
        }
    }

    public bool DeleteImage(string id)
    {
        lock (_lock)
        {
            var list = ReadOr(ImagesIndexPath, () => new List<ImageInfo>());
            var img = list.FirstOrDefault(i => i.Id == id);
            if (img == null) return false;
            list.Remove(img);
            Write(ImagesIndexPath, list);

            var path = Path.Combine(ImagesDir, img.FileName);
            if (File.Exists(path)) File.Delete(path);

            // Drop the image from every playlist that references it.
            var states = ReadOr(StatesPath, () => new StateStore());
            bool changed = states.Default.PlaylistImageIds.Remove(id);
            foreach (var s in states.Devices.Values)
                changed |= s.PlaylistImageIds.Remove(id);
            if (changed) Write(StatesPath, states);
            return true;
        }
    }

    // ---------------- Document ----------------

    public DocumentConfig GetDocument()
    {
        lock (_lock) return ReadOr(DocumentPath, DefaultDocument);
    }

    public void SaveDocument(DocumentConfig doc)
    {
        lock (_lock) Write(DocumentPath, doc);
    }

    // ---------------- Signatures ----------------

    public SignatureRecord AddSignature(SignatureSubmission sub, string documentTitle, string? deviceName, byte[] pngBytes)
    {
        lock (_lock)
        {
            var id = DateTime.UtcNow.ToString("yyyyMMdd-HHmmss-fff") + "-" + Guid.NewGuid().ToString("N")[..6];
            var dir = Path.Combine(SignaturesDir, id);
            Directory.CreateDirectory(dir);
            var rec = new SignatureRecord
            {
                Id = id,
                CreatedUtc = DateTime.UtcNow,
                DocumentTitle = documentTitle,
                DeviceId = sub.DeviceId,
                DeviceName = deviceName,
                Items = sub.Items
            };
            Write(Path.Combine(dir, "meta.json"), rec);
            File.WriteAllBytes(Path.Combine(dir, "signature.png"), pngBytes);
            return rec;
        }
    }

    public List<SignatureRecord> ListSignatures()
    {
        lock (_lock)
        {
            if (!Directory.Exists(SignaturesDir)) return new List<SignatureRecord>();
            var result = new List<SignatureRecord>();
            foreach (var dir in Directory.GetDirectories(SignaturesDir))
            {
                var meta = Path.Combine(dir, "meta.json");
                if (!File.Exists(meta)) continue;
                try
                {
                    var rec = JsonSerializer.Deserialize<SignatureRecord>(File.ReadAllText(meta), Json);
                    if (rec != null) result.Add(rec);
                }
                catch { /* ignore corrupt records in the prototype */ }
            }
            return result.OrderByDescending(r => r.CreatedUtc).ToList();
        }
    }

    public SignatureRecord? GetSignature(string id)
    {
        if (!IsSafeId(id)) return null;
        lock (_lock)
        {
            var meta = Path.Combine(SignaturesDir, id, "meta.json");
            if (!File.Exists(meta)) return null;
            try { return JsonSerializer.Deserialize<SignatureRecord>(File.ReadAllText(meta), Json); }
            catch { return null; }
        }
    }

    public string? GetSignatureImagePath(string id)
    {
        if (!IsSafeId(id)) return null;
        var path = Path.Combine(SignaturesDir, id, "signature.png");
        return File.Exists(path) ? path : null;
    }

    // ---------------- Helpers ----------------

    public static bool IsSafeId(string id) =>
        !string.IsNullOrEmpty(id) && id.All(c => char.IsLetterOrDigit(c) || c is '-' or '_' or '.');

    private T ReadOr<T>(string path, Func<T> fallback)
    {
        if (!File.Exists(path)) return fallback();
        try
        {
            var v = JsonSerializer.Deserialize<T>(File.ReadAllText(path), Json);
            return v ?? fallback();
        }
        catch { return fallback(); }
    }

    private void Write<T>(string path, T value)
    {
        var tmp = path + ".tmp";
        File.WriteAllText(tmp, JsonSerializer.Serialize(value, Json));
        File.Move(tmp, path, overwrite: true);
    }

    private static DocumentConfig DefaultDocument() => new()
    {
        Title = "Согласие на обработку персональных данных",
        SignPrompt = "Пожалуйста, поставьте вашу подпись в поле ниже",
        ThankYouText = "Спасибо! Ваша подпись принята.",
        Pages = new List<DocPage>
        {
            new()
            {
                Heading = "Шаг 1. Ознакомление",
                Body = "Пожалуйста, внимательно ознакомьтесь с текстом.\n\n" +
                       "Используйте кнопки «Далее» и «Назад» для перехода между разделами. " +
                       "Вы можете вернуться и перечитать любой раздел в любой момент.\n\n" +
                       "Настоящий документ описывает условия предоставления услуги и порядок обработки ваших персональных данных.",
                Checkboxes = new List<DocCheckbox>()
            },
            new()
            {
                Heading = "Шаг 2. Условия и согласие",
                Body = "Оператор обязуется использовать предоставленные данные исключительно в целях оказания услуги " +
                       "и не передавать их третьим лицам без вашего согласия.\n\n" +
                       "Отметьте пункты ниже, чтобы подтвердить согласие. Отмеченные пункты обязательны для продолжения.",
                Checkboxes = new List<DocCheckbox>
                {
                    new() { Label = "Я ознакомился(лась) с условиями предоставления услуги", Required = true },
                    new() { Label = "Я даю согласие на обработку моих персональных данных", Required = true }
                }
            },
            new()
            {
                Heading = "Шаг 3. Дополнительно",
                Body = "Вы можете отметить дополнительные пункты по желанию — они не обязательны.",
                Checkboxes = new List<DocCheckbox>
                {
                    new() { Label = "Я хочу получать информационную рассылку", Required = false }
                }
            }
        }
    };
}
