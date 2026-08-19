using System.Security.Cryptography;
using System.Text;
using SignatureKiosk.Models;

namespace SignatureKiosk.Services;

/// <summary>
/// Central auth logic: admin password/cookie and per-device tokens.
/// The admin token is a deterministic hash of the configured password, so it
/// survives restarts without server-side session storage.
/// </summary>
public class TokenAuthService
{
    public const string AdminCookieName = "sk_admin";

    private readonly StorageService _storage;
    private readonly string _adminPassword;
    private readonly string _adminToken;

    public TokenAuthService(StorageService storage, IConfiguration config)
    {
        _storage = storage;
        _adminPassword = config["AdminPassword"] ?? "";
        _adminToken = StorageService.Sha256Hex("sk::" + _adminPassword);
    }

    public string AdminTokenValue => _adminToken;

    public bool CheckPassword(string? password) =>
        password is not null && FixedTimeEquals(password, _adminPassword);

    public bool IsValidAdminCookie(string? value) =>
        value is not null && FixedTimeEquals(value, _adminToken);

    /// <summary>Validate a device token of the form "deviceId.secret". Returns the device if active.</summary>
    public Device? ValidateDeviceToken(string? token)
    {
        if (string.IsNullOrWhiteSpace(token)) return null;
        var dot = token.IndexOf('.');
        if (dot <= 0 || dot >= token.Length - 1) return null;
        var id = token[..dot];
        var secret = token[(dot + 1)..];
        var dev = _storage.GetDevice(id);
        if (dev is null || dev.Status != "active") return null;
        return FixedTimeEquals(StorageService.Sha256Hex(secret), dev.SecretHash) ? dev : null;
    }

    private static bool FixedTimeEquals(string a, string b) =>
        CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(a), Encoding.UTF8.GetBytes(b));
}
