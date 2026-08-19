using System.Security.Claims;
using System.Text.Encodings.Web;
using Microsoft.AspNetCore.Authentication;
using Microsoft.Extensions.Options;
using SignatureKiosk.Services;

namespace SignatureKiosk.Auth;

/// <summary>
/// Single authentication scheme for the app:
///   • the admin page presents its login cookie  → role "admin"
///   • a tablet presents its device token (Bearer header, or access_token query for the
///     SignalR WebSocket handshake)              → role "device" with its id/groups/workstation
/// Anything else is anonymous (NoResult) and is rejected by [Authorize].
/// </summary>
public class SkAuthHandler : AuthenticationHandler<AuthenticationSchemeOptions>
{
    public const string SchemeName = "SK";

    private readonly TokenAuthService _auth;

    public SkAuthHandler(IOptionsMonitor<AuthenticationSchemeOptions> options, ILoggerFactory logger,
        UrlEncoder encoder, TokenAuthService auth) : base(options, logger, encoder)
    {
        _auth = auth;
    }

    protected override Task<AuthenticateResult> HandleAuthenticateAsync()
    {
        // 1) Admin via login cookie.
        if (Request.Cookies.TryGetValue(TokenAuthService.AdminCookieName, out var cookie) && _auth.IsValidAdminCookie(cookie))
        {
            var admin = new ClaimsIdentity(new[]
            {
                new Claim("role", "admin"),
                new Claim(ClaimTypes.Role, "admin")
            }, SchemeName);
            return Task.FromResult(AuthenticateResult.Success(new AuthenticationTicket(new ClaimsPrincipal(admin), SchemeName)));
        }

        // 2) Device via token.
        string? token = null;
        var authz = Request.Headers.Authorization.ToString();
        if (authz.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase))
            token = authz["Bearer ".Length..].Trim();
        // The access_token query fallback exists only for the SignalR WebSocket handshake, which
        // cannot send an Authorization header. Restricting it to the hub path keeps device tokens
        // out of query strings (and proxy access logs) on every other request.
        if (string.IsNullOrEmpty(token) && Request.Path.StartsWithSegments("/hub"))
        {
            var q = Request.Query["access_token"].ToString();
            if (!string.IsNullOrEmpty(q)) token = q;
        }

        if (!string.IsNullOrEmpty(token))
        {
            var dev = _auth.ValidateDeviceToken(token);
            if (dev is not null)
            {
                var claims = new List<Claim>
                {
                    new("role", "device"),
                    new("device_id", dev.Id),
                    new("name", dev.Name)
                };
                if (!string.IsNullOrEmpty(dev.WorkstationId)) claims.Add(new Claim("workstation", dev.WorkstationId));
                foreach (var g in dev.GroupIds) claims.Add(new Claim("group", g));
                var id = new ClaimsIdentity(claims, SchemeName);
                return Task.FromResult(AuthenticateResult.Success(new AuthenticationTicket(new ClaimsPrincipal(id), SchemeName)));
            }
        }

        return Task.FromResult(AuthenticateResult.NoResult());
    }
}
