using System.Text;
using System.Text.Json;
using SignatureKiosk.Models;

namespace SignatureKiosk.Services;

/// <summary>
/// Talks to the FreeKiosk app running on a tablet through its local REST API
/// (http://{tablet}:8080, optional X-Api-Key header).
///
/// This only works when the server can reach the tablet directly, i.e. same network or VPN: the
/// normal traffic goes tablet -> server, this goes the other way round. Every call is short-timeout
/// and never throws: a tablet that is off, asleep or on another network is simply "unreachable",
/// which must never disturb signing.
/// </summary>
public class FreeKioskClient
{
    private readonly IHttpClientFactory _http;
    private readonly StorageService _storage;
    private readonly ILogger<FreeKioskClient> _log;

    public FreeKioskClient(IHttpClientFactory http, StorageService storage, ILogger<FreeKioskClient> log)
    {
        _http = http;
        _storage = storage;
        _log = log;
    }

    public record Result(bool Ok, int Status, string? Error, string? Body);

    /// <summary>The tablet's control address, or null when it cannot be determined.</summary>
    public string? BaseUrl(Device device, KioskControlSettings settings)
    {
        var raw = !string.IsNullOrWhiteSpace(device.ControlIp) ? device.ControlIp!.Trim() : device.LastIp;
        if (!IsUsableTabletAddress(raw, out var ip)) return null;
        var port = device.ControlPort is > 0 and < 65536 ? device.ControlPort.Value : settings.Port;
        // IPv6 literals must be bracketed in a URL.
        var host = ip!.AddressFamily == System.Net.Sockets.AddressFamily.InterNetworkV6 ? "[" + ip + "]" : ip.ToString();
        return "http://" + host + ":" + port;
    }

    /// <summary>
    /// A control address must be a plain IP address of a tablet on the network. Only addresses are
    /// accepted (never a host name or a URL fragment), so a stored value can never be turned into a
    /// call to somewhere else, and the server's own loopback is out of reach.
    /// </summary>
    public static bool IsUsableTabletAddress(string? value, out System.Net.IPAddress? ip)
    {
        ip = null;
        if (string.IsNullOrWhiteSpace(value)) return false;
        if (!System.Net.IPAddress.TryParse(value.Trim(), out var parsed)) return false;
        if (System.Net.IPAddress.IsLoopback(parsed)) return false;
        if (parsed.Equals(System.Net.IPAddress.Any) || parsed.Equals(System.Net.IPAddress.IPv6Any)) return false;
        // Broadcast and multicast are not a single tablet.
        if (parsed.ToString() == "255.255.255.255") return false;
        var bytes = parsed.GetAddressBytes();
        if (parsed.AddressFamily == System.Net.Sockets.AddressFamily.InterNetwork && bytes[0] >= 224) return false;
        if (parsed.IsIPv6Multicast) return false;
        ip = parsed;
        return true;
    }

    private HttpClient Client(KioskControlSettings settings)
    {
        var client = _http.CreateClient("freekiosk");
        client.Timeout = TimeSpan.FromSeconds(Math.Clamp(settings.TimeoutSec, 1, 30));
        if (!string.IsNullOrWhiteSpace(settings.ApiKey))
            client.DefaultRequestHeaders.TryAddWithoutValidation("X-Api-Key", settings.ApiKey);
        return client;
    }

    /// <summary>
    /// Send one command to a tablet. `path` is the API path, e.g. "/api/reboot".
    /// Pass <paramref name="settings"/> when calling for many tablets in a row: reading them per
    /// call would take the storage lock once per tablet, and that lock also serves signing.
    /// </summary>
    public async Task<Result> SendAsync(Device device, string path, HttpMethod? method = null,
        object? body = null, KioskControlSettings? settings = null, CancellationToken cancel = default)
    {
        settings ??= _storage.GetKioskControlSettings();
        if (!settings.Enabled) return new Result(false, 0, "Управление планшетами выключено в настройках.", null);

        var baseUrl = BaseUrl(device, settings);
        if (baseUrl is null) return new Result(false, 0, "Адрес планшета неизвестен. Укажите его в карточке планшета.", null);

        try
        {
            using var req = new HttpRequestMessage(method ?? HttpMethod.Post, baseUrl + path);
            if (body is not null)
                req.Content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json");

            using var client = Client(settings);
            using var resp = await client.SendAsync(req, cancel);
            var text = await resp.Content.ReadAsStringAsync(cancel);
            if (!resp.IsSuccessStatusCode)
                return new Result(false, (int)resp.StatusCode, "Планшет ответил ошибкой " + (int)resp.StatusCode, text);
            return new Result(true, (int)resp.StatusCode, null, text);
        }
        catch (TaskCanceledException)
        {
            return new Result(false, 0, "Планшет не ответил вовремя.", null);
        }
        catch (Exception ex)
        {
            // The technical detail goes to the log; the operator gets a sentence in their language.
            _log.LogDebug(ex, "FreeKiosk call {Path} failed for {Device}", path, device.Id);
            return new Result(false, 0, "Планшет не отвечает по сети.", null);
        }
    }

    /// <summary>Fetch binary content (a screenshot or a camera photo).</summary>
    public async Task<(byte[]? bytes, string? contentType, string? error)> GetBytesAsync(
        Device device, string path, CancellationToken cancel = default)
    {
        var settings = _storage.GetKioskControlSettings();
        if (!settings.Enabled) return (null, null, "Управление планшетами выключено в настройках.");
        var baseUrl = BaseUrl(device, settings);
        if (baseUrl is null) return (null, null, "Адрес планшета неизвестен. Укажите его в карточке планшета.");

        try
        {
            using var client = Client(settings);
            using var resp = await client.GetAsync(baseUrl + path, HttpCompletionOption.ResponseHeadersRead, cancel);
            if (!resp.IsSuccessStatusCode) return (null, null, "Планшет ответил ошибкой " + (int)resp.StatusCode);
            if (resp.Content.Headers.ContentLength is > MaxBinaryBytes)
                return (null, null, "Планшет прислал слишком большой файл.");

            using var source = await resp.Content.ReadAsStreamAsync(cancel);
            using var buffer = new MemoryStream();
            var read = await CopyBoundedAsync(source, buffer, cancel);
            if (!read) return (null, null, "Планшет прислал слишком большой файл.");

            // The content type comes from the tablet, so it is not trusted: serving it back verbatim
            // would let a compromised tablet get HTML rendered inside the admin panel. Only known
            // image types are passed through, everything else is refused.
            var type = ImageContentType(resp.Content.Headers.ContentType?.MediaType);
            if (type is null) return (null, null, "Планшет вернул не изображение, а файл другого типа.");
            return (buffer.ToArray(), type, null);
        }
        catch (TaskCanceledException) { return (null, null, "Планшет не ответил вовремя."); }
        catch (Exception ex)
        {
            _log.LogDebug(ex, "FreeKiosk binary call {Path} failed for {Device}", path, device.Id);
            return (null, null, "Планшет не отвечает по сети.");
        }
    }

    // A screenshot is at most a few hundred kilobytes; the cap is there so a broken or hostile
    // tablet cannot stream the server out of memory.
    private const int MaxBinaryBytes = 8 * 1024 * 1024;

    /// <summary>Copy at most <see cref="MaxBinaryBytes"/>. Returns false if the source has more.</summary>
    private static async Task<bool> CopyBoundedAsync(Stream source, Stream target, CancellationToken cancel)
    {
        var chunk = new byte[64 * 1024];
        var total = 0L;
        while (true)
        {
            var n = await source.ReadAsync(chunk, cancel);
            if (n == 0) return true;
            total += n;
            if (total > MaxBinaryBytes) return false;
            await target.WriteAsync(chunk.AsMemory(0, n), cancel);
        }
    }

    private static string? ImageContentType(string? mediaType) => mediaType?.ToLowerInvariant() switch
    {
        "image/png" => "image/png",
        "image/jpeg" or "image/jpg" => "image/jpeg",
        "image/webp" => "image/webp",
        "image/bmp" => "image/bmp",
        // Some builds answer without a content type at all; a screenshot is a PNG there.
        null or "" or "application/octet-stream" => "image/png",
        _ => null
    };

    /// <summary>Read the tablet's health. Never throws; an unreachable tablet returns Reachable=false.</summary>
    public async Task<KioskHealth> GetHealthAsync(Device device, KioskControlSettings? settings = null,
        CancellationToken cancel = default)
    {
        var health = new KioskHealth { CheckedUtc = DateTime.UtcNow };
        var res = await SendAsync(device, "/api/status", HttpMethod.Get, null, settings, cancel);
        if (!res.Ok || string.IsNullOrWhiteSpace(res.Body))
        {
            health.Reachable = false;
            health.Error = res.Error ?? "Пустой ответ.";
            return health;
        }

        health.Reachable = true;
        try
        {
            using var doc = JsonDocument.Parse(res.Body!);
            var root = doc.RootElement;
            health.BatteryPercent = Clamp(FindInt(root, "battery.level", "batteryLevel", "battery.percent", "battery"), 0, 100);
            health.Charging = FindBool(root, "charging", "isCharging", "battery.charging", "battery.isCharging");
            health.WifiSignalPercent = Clamp(FindInt(root, "wifi.signal", "wifiSignal", "wifi.signalStrength", "wifi.level"), 0, 100);
            health.WifiSsid = Short(FindString(root, "wifi.ssid", "ssid", "wifiSsid"));
            health.StorageFreePercent = Clamp(
                FindInt(root, "storage.freePercent", "storageFreePercent", "storage.percentFree")
                ?? Ratio(root, "storage.free", "storage.total") ?? Ratio(root, "storageFree", "storageTotal"), 0, 100);
            health.MemoryFreePercent = Clamp(
                FindInt(root, "memory.freePercent", "memoryFreePercent", "memory.percentFree")
                ?? Ratio(root, "memory.free", "memory.total") ?? Ratio(root, "memoryFree", "memoryTotal"), 0, 100);
            health.BrightnessPercent = Clamp(FindInt(root, "brightness", "screenBrightness", "screen.brightness"), 0, 100);
            health.ScreenOn = FindBool(root, "screenOn", "isScreenOn", "screen.on");
            health.DeviceOwner = FindBool(root, "deviceOwner", "isDeviceOwner", "deviceOwnerEnabled", "device.owner");
            health.AppVersion = Short(FindString(root, "appVersion", "app.version", "version"));
            health.AndroidVersion = Short(FindString(root, "androidVersion", "android", "device.androidVersion", "os.version"));
            health.Model = Short(FindString(root, "model", "deviceModel", "device.model"));
        }
        catch (Exception ex)
        {
            // The tablet answered but not in a shape we recognise: still reachable, just unreadable.
            _log.LogDebug(ex, "FreeKiosk status not understood for {Device}", device.Id);
            health.Error = "Ответ планшета не распознан. Проверьте версию FreeKiosk.";
        }
        return health;
    }

    // The FreeKiosk payload shape varies a little between versions, so each reading lists the paths
    // it may live under. A path is either "name" or "container.name" - resolved exactly, never by
    // scanning, so a "freePercent" belonging to memory can never be reported as free storage.
    private static JsonElement? Find(JsonElement root, params string[] paths)
    {
        foreach (var path in paths)
        {
            var current = root;
            var ok = true;
            foreach (var segment in path.Split('.'))
            {
                if (current.ValueKind != JsonValueKind.Object || !current.TryGetProperty(segment, out var next)) { ok = false; break; }
                current = next;
            }
            // Only a leaf carries a reading; a container means "look at the next candidate path".
            if (ok && current.ValueKind is not JsonValueKind.Object and not JsonValueKind.Array and not JsonValueKind.Null)
                return current;
        }
        return null;
    }

    private static int? Clamp(int? value, int min, int max) => value is null ? null : Math.Clamp(value.Value, min, max);

    private static string? Short(string? value) =>
        string.IsNullOrWhiteSpace(value) ? null : value.Trim().Length <= 64 ? value.Trim() : value.Trim()[..64];

    /// <summary>Free space as a percentage, when the tablet reports raw sizes instead.</summary>
    private static int? Ratio(JsonElement root, string freePath, string totalPath)
    {
        var free = FindDouble(root, freePath);
        var total = FindDouble(root, totalPath);
        if (free is null || total is null or <= 0) return null;
        return (int)Math.Round(free.Value / total.Value * 100);
    }

    private static double? FindDouble(JsonElement root, params string[] paths)
    {
        var el = Find(root, paths);
        if (el is null) return null;
        return el.Value.ValueKind switch
        {
            JsonValueKind.Number => el.Value.GetDouble(),
            JsonValueKind.String when double.TryParse(el.Value.GetString(),
                System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var d) => d,
            _ => null
        };
    }

    private static int? FindInt(JsonElement root, params string[] names)
    {
        var el = Find(root, names);
        if (el is null) return null;
        return el.Value.ValueKind switch
        {
            JsonValueKind.Number when el.Value.TryGetInt32(out var i) => i,
            JsonValueKind.Number => (int?)Math.Round(el.Value.GetDouble()),
            JsonValueKind.String when int.TryParse(el.Value.GetString(), out var s) => s,
            _ => null
        };
    }

    private static bool? FindBool(JsonElement root, params string[] names)
    {
        var el = Find(root, names);
        if (el is null) return null;
        return el.Value.ValueKind switch
        {
            JsonValueKind.True => true,
            JsonValueKind.False => false,
            JsonValueKind.String when bool.TryParse(el.Value.GetString(), out var b) => b,
            _ => null
        };
    }

    private static string? FindString(JsonElement root, params string[] names)
    {
        var el = Find(root, names);
        if (el is null) return null;
        return el.Value.ValueKind == JsonValueKind.String ? el.Value.GetString() : el.Value.ToString();
    }
}
