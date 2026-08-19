using System.Security.Cryptography;
using System.Text;
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
        Directory.CreateDirectory(PdfDir);
    }

    public string DataDir => _dataDir;
    public string ImagesDir => Path.Combine(_dataDir, "images");
    public string SignaturesDir => Path.Combine(_dataDir, "signatures");
    public string PdfDir => Path.Combine(_dataDir, "pdf");

    public string? GetPdfPath(string id)
    {
        if (!IsSafeId(id)) return null;
        var path = Path.Combine(PdfDir, id + ".pdf");
        return File.Exists(path) ? path : null;
    }
    private string StatesPath => Path.Combine(_dataDir, "states.json");
    private string DevicesPath => Path.Combine(_dataDir, "devices.json");
    private string GroupsPath => Path.Combine(_dataDir, "groups.json");
    private string WorkstationsPath => Path.Combine(_dataDir, "workstations.json");
    private string EnrollmentsPath => Path.Combine(_dataDir, "enrollments.json");
    private string ApiKeysPath => Path.Combine(_dataDir, "apikeys.json");
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

    public List<Device> GetDevices()
    {
        lock (_lock) return ReadOr(DevicesPath, () => new List<Device>());
    }

    public Device? GetDevice(string id)
    {
        lock (_lock) return ReadOr(DevicesPath, () => new List<Device>()).FirstOrDefault(d => d.Id == id);
    }

    public void TouchDevice(string id)
    {
        lock (_lock)
        {
            var list = ReadOr(DevicesPath, () => new List<Device>());
            var dev = list.FirstOrDefault(d => d.Id == id);
            if (dev == null) return;
            dev.LastSeenUtc = DateTime.UtcNow;
            Write(DevicesPath, list);
        }
    }

    public bool UpdateDevice(string id, string? name, List<string>? groupIds, string? workstationId, bool touchWorkstation)
    {
        lock (_lock)
        {
            var list = ReadOr(DevicesPath, () => new List<Device>());
            var dev = list.FirstOrDefault(d => d.Id == id);
            if (dev == null) return false;
            if (!string.IsNullOrWhiteSpace(name)) dev.Name = name!.Trim();
            if (groupIds != null) dev.GroupIds = groupIds;
            if (touchWorkstation) dev.WorkstationId = string.IsNullOrWhiteSpace(workstationId) ? null : workstationId;
            Write(DevicesPath, list);
            return true;
        }
    }

    public bool SetDeviceStatus(string id, string status)
    {
        lock (_lock)
        {
            var list = ReadOr(DevicesPath, () => new List<Device>());
            var dev = list.FirstOrDefault(d => d.Id == id);
            if (dev == null) return false;
            dev.Status = status;
            Write(DevicesPath, list);
            return true;
        }
    }

    public bool DeleteDevice(string id)
    {
        lock (_lock)
        {
            var list = ReadOr(DevicesPath, () => new List<Device>());
            var dev = list.FirstOrDefault(d => d.Id == id);
            if (dev == null) return false;
            list.Remove(dev);
            Write(DevicesPath, list);
            var states = ReadOr(StatesPath, () => new StateStore());
            if (states.Devices.Remove(id)) Write(StatesPath, states);
            return true;
        }
    }

    /// <summary>Assign a device to a workstation identified by the external system's id.</summary>
    public bool AssignWorkstationByExternalId(string deviceId, string? externalId)
    {
        lock (_lock)
        {
            var wsId = (string?)null;
            if (!string.IsNullOrWhiteSpace(externalId))
            {
                var ws = ReadOr(WorkstationsPath, () => new List<Workstation>())
                    .FirstOrDefault(w => w.ExternalId == externalId);
                if (ws == null) return false;
                wsId = ws.Id;
            }
            var list = ReadOr(DevicesPath, () => new List<Device>());
            var dev = list.FirstOrDefault(d => d.Id == deviceId);
            if (dev == null) return false;
            dev.WorkstationId = wsId;
            Write(DevicesPath, list);
            return true;
        }
    }

    // ---------------- Groups ----------------

    public List<DeviceGroup> GetGroups()
    {
        lock (_lock) return ReadOr(GroupsPath, () => new List<DeviceGroup>());
    }

    public DeviceGroup AddGroup(string name)
    {
        lock (_lock)
        {
            var list = ReadOr(GroupsPath, () => new List<DeviceGroup>());
            var g = new DeviceGroup { Id = "grp-" + ShortId(), Name = string.IsNullOrWhiteSpace(name) ? "Группа" : name.Trim() };
            list.Add(g);
            Write(GroupsPath, list);
            return g;
        }
    }

    public bool RenameGroup(string id, string name)
    {
        lock (_lock)
        {
            var list = ReadOr(GroupsPath, () => new List<DeviceGroup>());
            var g = list.FirstOrDefault(x => x.Id == id);
            if (g == null) return false;
            g.Name = string.IsNullOrWhiteSpace(name) ? g.Id : name.Trim();
            Write(GroupsPath, list);
            return true;
        }
    }

    public bool DeleteGroup(string id)
    {
        lock (_lock)
        {
            var list = ReadOr(GroupsPath, () => new List<DeviceGroup>());
            var g = list.FirstOrDefault(x => x.Id == id);
            if (g == null) return false;
            list.Remove(g);
            Write(GroupsPath, list);
            // remove membership from devices
            var devs = ReadOr(DevicesPath, () => new List<Device>());
            bool changed = false;
            foreach (var d in devs) changed |= d.GroupIds.Remove(id);
            if (changed) Write(DevicesPath, devs);
            return true;
        }
    }

    // ---------------- Workstations ----------------

    public List<Workstation> GetWorkstations()
    {
        lock (_lock) return ReadOr(WorkstationsPath, () => new List<Workstation>());
    }

    public Workstation AddWorkstation(string? externalId, string? name, string? location)
    {
        lock (_lock)
        {
            var list = ReadOr(WorkstationsPath, () => new List<Workstation>());
            var w = new Workstation
            {
                Id = "ws-" + ShortId(),
                ExternalId = (externalId ?? "").Trim(),
                Name = string.IsNullOrWhiteSpace(name) ? "Рабочее место" : name!.Trim(),
                Location = (location ?? "").Trim()
            };
            list.Add(w);
            Write(WorkstationsPath, list);
            return w;
        }
    }

    public bool UpdateWorkstation(string id, string? externalId, string? name, string? location)
    {
        lock (_lock)
        {
            var list = ReadOr(WorkstationsPath, () => new List<Workstation>());
            var w = list.FirstOrDefault(x => x.Id == id);
            if (w == null) return false;
            if (externalId != null) w.ExternalId = externalId.Trim();
            if (!string.IsNullOrWhiteSpace(name)) w.Name = name.Trim();
            if (location != null) w.Location = location.Trim();
            Write(WorkstationsPath, list);
            return true;
        }
    }

    public bool DeleteWorkstation(string id)
    {
        lock (_lock)
        {
            var list = ReadOr(WorkstationsPath, () => new List<Workstation>());
            var w = list.FirstOrDefault(x => x.Id == id);
            if (w == null) return false;
            list.Remove(w);
            Write(WorkstationsPath, list);
            var devs = ReadOr(DevicesPath, () => new List<Device>());
            bool changed = false;
            foreach (var d in devs) if (d.WorkstationId == id) { d.WorkstationId = null; changed = true; }
            if (changed) Write(DevicesPath, devs);
            return true;
        }
    }

    // ---------------- Enrollment ----------------

    public Enrollment CreateEnrollment(string? name, string? workstationId, List<string>? groupIds, int ttlMinutes)
    {
        lock (_lock)
        {
            var list = ReadOr(EnrollmentsPath, () => new List<Enrollment>());
            // prune used or long-expired codes to keep the file small
            var now = DateTime.UtcNow;
            list.RemoveAll(e => e.UsedByDeviceId != null || e.ExpiresUtc < now.AddDays(-1));
            var e = new Enrollment
            {
                Code = FriendlyCode(),
                Name = string.IsNullOrWhiteSpace(name) ? null : name!.Trim(),
                WorkstationId = string.IsNullOrWhiteSpace(workstationId) ? null : workstationId,
                GroupIds = groupIds ?? new List<string>(),
                CreatedUtc = now,
                ExpiresUtc = now.AddMinutes(ttlMinutes > 0 ? ttlMinutes : 60)
            };
            list.Add(e);
            Write(EnrollmentsPath, list);
            return e;
        }
    }

    /// <summary>Redeem a code: create a device and return it plus the one-time token (id.secret).</summary>
    public (Device device, string token)? RedeemEnrollment(string? code)
    {
        if (string.IsNullOrWhiteSpace(code)) return null;
        code = code.Trim().ToUpperInvariant();
        lock (_lock)
        {
            var enrolls = ReadOr(EnrollmentsPath, () => new List<Enrollment>());
            var e = enrolls.FirstOrDefault(x => x.Code == code);
            if (e == null || e.UsedByDeviceId != null || e.ExpiresUtc < DateTime.UtcNow) return null;

            var devices = ReadOr(DevicesPath, () => new List<Device>());
            var id = "dev-" + ShortId();
            var secret = RandomToken(24);
            var now = DateTime.UtcNow;
            var dev = new Device
            {
                Id = id,
                Name = string.IsNullOrWhiteSpace(e.Name) ? "Планшет " + id[^4..] : e.Name!,
                SecretHash = Sha256Hex(secret),
                GroupIds = e.GroupIds ?? new List<string>(),
                WorkstationId = e.WorkstationId,
                EnrolledUtc = now,
                LastSeenUtc = now,
                Status = "active"
            };
            devices.Add(dev);
            Write(DevicesPath, devices);

            e.UsedByDeviceId = id;
            Write(EnrollmentsPath, enrolls);

            return (dev, id + "." + secret);
        }
    }

    // ---------------- API keys ----------------

    public List<ApiKey> GetApiKeys()
    {
        lock (_lock) return ReadOr(ApiKeysPath, () => new List<ApiKey>());
    }

    public (ApiKey key, string plaintext) CreateApiKey(string? label)
    {
        lock (_lock)
        {
            var list = ReadOr(ApiKeysPath, () => new List<ApiKey>());
            var plaintext = "sk_" + RandomToken(30);
            var k = new ApiKey
            {
                Id = "key-" + ShortId(),
                KeyHash = Sha256Hex(plaintext),
                Label = string.IsNullOrWhiteSpace(label) ? "API key" : label!.Trim(),
                CreatedUtc = DateTime.UtcNow
            };
            list.Add(k);
            Write(ApiKeysPath, list);
            return (k, plaintext);
        }
    }

    public bool DeleteApiKey(string id)
    {
        lock (_lock)
        {
            var list = ReadOr(ApiKeysPath, () => new List<ApiKey>());
            var k = list.FirstOrDefault(x => x.Id == id);
            if (k == null) return false;
            list.Remove(k);
            Write(ApiKeysPath, list);
            return true;
        }
    }

    public bool ValidateApiKey(string? key)
    {
        if (string.IsNullOrWhiteSpace(key)) return false;
        var hash = Sha256Hex(key);
        lock (_lock)
        {
            return ReadOr(ApiKeysPath, () => new List<ApiKey>()).Any(k => k.KeyHash == hash);
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

    public SignatureRecord AddSignature(SignatureSubmission sub, string documentTitle, Device? device, Workstation? workstation, byte[] pngBytes)
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
                DeviceId = device?.Id,
                DeviceName = device?.Name,
                WorkstationId = workstation?.Id,
                WorkstationName = workstation?.Name,
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

    public static string Sha256Hex(string s) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(s)));

    private static string RandomToken(int bytes)
    {
        var buf = RandomNumberGenerator.GetBytes(bytes);
        return Convert.ToBase64String(buf).Replace("+", "-").Replace("/", "_").TrimEnd('=');
    }

    private static string ShortId() =>
        Convert.ToHexString(RandomNumberGenerator.GetBytes(5)).ToLowerInvariant();

    /// <summary>Human-friendly enrollment code, e.g. "7QF3-K92X" (no ambiguous chars).</summary>
    private static string FriendlyCode()
    {
        const string alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
        var chars = new char[8];
        var rnd = RandomNumberGenerator.GetBytes(8);
        for (int i = 0; i < 8; i++) chars[i] = alphabet[rnd[i] % alphabet.Length];
        return new string(chars, 0, 4) + "-" + new string(chars, 4, 4);
    }

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
                Body = "Вы можете отметить дополнительные пункты по желанию - они не обязательны.",
                Checkboxes = new List<DocCheckbox>
                {
                    new() { Label = "Я хочу получать информационную рассылку", Required = false }
                }
            }
        }
    };
}
