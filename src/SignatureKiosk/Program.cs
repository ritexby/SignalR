using System.Text.Json;
using System.Threading.RateLimiting;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.HttpOverrides;
using Microsoft.Extensions.FileProviders;
using SignatureKiosk.Auth;
using SignatureKiosk.Hubs;
using SignatureKiosk.Models;
using SignatureKiosk.Services;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddSignalR().AddJsonProtocol(options =>
{
    options.PayloadSerializerOptions.PropertyNamingPolicy = JsonNamingPolicy.CamelCase;
});
builder.Services.AddSingleton<StorageService>();
builder.Services.AddSingleton<DeviceTracker>();
builder.Services.AddSingleton<KioskCoordinator>();
builder.Services.AddSingleton<TokenAuthService>();
builder.Services.AddSingleton<PdfService>();

builder.Services.AddAuthentication(SkAuthHandler.SchemeName)
    .AddScheme<AuthenticationSchemeOptions, SkAuthHandler>(SkAuthHandler.SchemeName, null);
builder.Services.AddAuthorization(options =>
{
    options.AddPolicy("Admin", p => p.RequireClaim("role", "admin"));
    options.AddPolicy("Device", p => p.RequireClaim("role", "device"));
});

// Per-client-IP rate limiting on the unauthenticated / brute-forceable endpoints.
// Fixed-window is sufficient here and keeps memory bounded; partitions are keyed by
// the real client IP (resolved after UseForwardedHeaders).
builder.Services.AddRateLimiter(options =>
{
    options.RejectionStatusCode = StatusCodes.Status429TooManyRequests;

    static Func<HttpContext, RateLimitPartition<string>> Fixed(int permitPerMinute) =>
        httpContext => RateLimitPartition.GetFixedWindowLimiter(
            ClientIp(httpContext),
            _ => new FixedWindowRateLimiterOptions
            {
                Window = TimeSpan.FromMinutes(1),
                PermitLimit = permitPerMinute,
                QueueLimit = 0
            });

    options.AddPolicy("login", Fixed(10));    // admin password guesses
    options.AddPolicy("enroll", Fixed(20));   // activation-code redemption
    options.AddPolicy("sign", Fixed(60));     // signature submissions (bursty by design)
});

var app = builder.Build();

var storage = app.Services.GetRequiredService<StorageService>();
var tracker = app.Services.GetRequiredService<DeviceTracker>();

var adminPassword = app.Configuration["AdminPassword"];
if (string.IsNullOrWhiteSpace(adminPassword) || adminPassword == "admin")
{
    app.Logger.LogCritical(
        "AdminPassword is not configured (or is the insecure default \"admin\"). " +
        "Set a strong AdminPassword (e.g. in /etc/signaturekiosk.env) and restart.");
    throw new InvalidOperationException(
        "AdminPassword must be configured; refusing to start with an empty or default password.");
}
var auth = app.Services.GetRequiredService<TokenAuthService>();

// Behind a reverse proxy (Nginx Proxy Manager), possibly on another host: honour
// X-Forwarded-Proto/For so Request.IsHttps and client IPs reflect the real client.
var forwardedOptions = new ForwardedHeadersOptions
{
    ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto
};
forwardedOptions.KnownIPNetworks.Clear();
forwardedOptions.KnownProxies.Clear();
// If the proxy IP(s) are configured, honour X-Forwarded-* ONLY from them (ForwardLimit = 1).
// This stops a client from spoofing X-Forwarded-For to rotate its per-IP rate-limit bucket.
// When unset, the header is trusted from any caller, which is safe only because the deploy guide
// firewalls the app port so the proxy is the only reachable client (see deploy/README.md).
foreach (var p in (app.Configuration["KnownProxies"] ?? "")
             .Split(new[] { ',', ' ', ';' }, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
    if (System.Net.IPAddress.TryParse(p, out var ip)) forwardedOptions.KnownProxies.Add(ip);
if (forwardedOptions.KnownProxies.Count > 0) forwardedOptions.ForwardLimit = 1;
app.UseForwardedHeaders(forwardedOptions);

// Security response headers. The app serves its own first-party assets only (SignalR +
// signature_pad are vendored under /lib), so a tight CSP is safe. Kept in one place so the
// policy is auditable at a glance.
app.Use(async (context, next) =>
{
    var headers = context.Response.Headers;
    headers["X-Content-Type-Options"] = "nosniff";
    headers["X-Frame-Options"] = "DENY";
    headers["Referrer-Policy"] = "no-referrer";
    headers["Cross-Origin-Opener-Policy"] = "same-origin";
    headers["Content-Security-Policy"] =
        "default-src 'self'; " +
        "base-uri 'self'; " +
        "frame-ancestors 'none'; " +
        "object-src 'none'; " +
        "img-src 'self' data: blob:; " +
        "media-src 'self' blob:; " +
        "connect-src 'self'; " +
        "script-src 'self'; " +
        "style-src 'self' 'unsafe-inline'; " +
        "font-src 'self'";
    if (context.Request.IsHttps)
        headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains";
    await next();
});

// Redirect the bare /admin (no trailing slash) to /admin/ (middleware, not an endpoint,
// so it never shadows the static /admin/ files).
app.Use(async (context, next) =>
{
    if (context.Request.Path.Equals("/admin", StringComparison.OrdinalIgnoreCase))
    {
        context.Response.Redirect("/admin/");
        return;
    }
    await next();
});

app.UseAuthentication();
app.UseAuthorization();
app.UseRateLimiter();

app.UseDefaultFiles();
// Kiosk tablets (Android WebView) and browsers cache JS/CSS aggressively; without this they
// can keep showing an old UI after a deploy. Tell every client to revalidate a cached asset
// before using it, so a new build is always picked up: a 304 when unchanged (ETags are still
// sent, so this stays cheap), the new file when changed.
app.UseStaticFiles(new StaticFileOptions
{
    OnPrepareResponse = ctx => ctx.Context.Response.Headers["Cache-Control"] = "no-cache, must-revalidate"
});
// Uploaded slide images are content-addressed by a GUID file name, so a given URL never
// changes; they may be cached for a long time.
app.UseStaticFiles(new StaticFileOptions
{
    FileProvider = new PhysicalFileProvider(storage.ImagesDir),
    RequestPath = "/media",
    OnPrepareResponse = ctx => ctx.Context.Response.Headers["Cache-Control"] = "public, max-age=604800"
});

app.MapHub<KioskHub>("/hub/kiosk");

// Liveness probe for 24/7 monitoring (systemd, uptime checks). Anonymous, unthrottled.
app.MapGet("/healthz", () => Results.Ok(new { status = "ok" }));

// ==================== Public: tablet enrollment ====================

app.MapPost("/api/kiosk/enroll", (EnrollRequest req) =>
{
    var result = storage.RedeemEnrollment(req?.Code);
    if (result is null)
        return Results.Json(new { error = "invalid or expired code" }, statusCode: StatusCodes.Status400BadRequest);
    var (device, token) = result.Value;
    return Results.Ok(new { deviceId = device.Id, name = device.Name, token });
}).RequireRateLimiting("enroll");

// ==================== Device-authenticated: submit signature ====================

app.MapPost("/api/sign", async (SignatureSubmission sub, HttpContext ctx, KioskCoordinator coord, PdfService pdf) =>
{
    if (sub is null || string.IsNullOrWhiteSpace(sub.Signature))
        return Results.BadRequest(new { error = "signature required" });

    var png = DecodeDataUrlPng(sub.Signature);
    if (png is null || !IsPng(png))
        return Results.BadRequest(new { error = "invalid signature image" });

    var deviceId = ctx.User.FindFirst("device_id")?.Value;
    var device = deviceId is null ? null : storage.GetDevice(deviceId);
    Workstation? ws = device?.WorkstationId is null
        ? null
        : storage.GetWorkstations().FirstOrDefault(w => w.Id == device.WorkstationId);

    // Resolve the document with THIS device's signer data so the PDF and the stored record
    // show the real values, not the {{tags}}.
    var state = deviceId is null ? null : storage.ResolveState(deviceId);
    var fields = state?.Fields is { Count: > 0 } ? state.Fields : null;
    var resolvedDoc = DocumentTemplating.Resolve(storage.GetDocument(), fields, state?.DynamicCheckboxes);
    var rec = storage.AddSignature(sub, resolvedDoc, device, ws, png, fields);

    try { pdf.Generate(rec, resolvedDoc, png); }
    catch (Exception ex) { app.Logger.LogError(ex, "PDF generation failed for {Id}", rec.Id); }

    // Privacy: clear this device's signer data and drop it out of document mode immediately, so a
    // reconnect during the local thank-you screen cannot redisplay the signed data.
    if (deviceId is not null) coord.ClearSignerSession(deviceId);

    await coord.NotifyAdminsSignatureAsync(rec);
    return Results.Ok(new { id = rec.Id });
}).RequireAuthorization("Device").RequireRateLimiting("sign");

// ==================== Admin authentication ====================

app.MapPost("/api/admin/login", (LoginDto dto, HttpContext ctx) =>
{
    if (auth.CheckPassword(dto?.Password))
    {
        ctx.Response.Cookies.Append(TokenAuthService.AdminCookieName, auth.AdminTokenValue, new CookieOptions
        {
            HttpOnly = true,
            SameSite = SameSiteMode.Lax,
            Secure = ctx.Request.IsHttps,
            MaxAge = TimeSpan.FromDays(30),
            Path = "/"
        });
        return Results.Ok(new { ok = true });
    }
    return Results.Json(new { ok = false, error = "wrong password" }, statusCode: StatusCodes.Status401Unauthorized);
}).RequireRateLimiting("login");

app.MapPost("/api/admin/logout", (HttpContext ctx) =>
{
    ctx.Response.Cookies.Delete(TokenAuthService.AdminCookieName);
    return Results.Ok(new { ok = true });
});

app.MapGet("/api/admin/me", (HttpContext ctx) =>
    Results.Ok(new { authenticated = ctx.User.FindFirst("role")?.Value == "admin" }));

// ==================== Admin API ====================

var admin = app.MapGroup("/api/admin").RequireAuthorization("Admin");

// ---- Devices ----
admin.MapGet("/devices", () =>
{
    var online = tracker.OnlineDeviceIds();
    var liveIps = tracker.OnlineIps();
    var groups = storage.GetGroups().ToDictionary(g => g.Id, g => g.Name);
    var wss = storage.GetWorkstations().ToDictionary(w => w.Id, w => w);
    var devices = storage.GetDevices()
        .OrderBy(d => d.Name)
        .Select(d =>
        {
            Workstation? w = d.WorkstationId != null && wss.TryGetValue(d.WorkstationId, out var found) ? found : null;
            bool isOnline = online.Contains(d.Id);
            // For an online tablet show the IP of its live connection; for an offline one, the
            // last IP we saw it from.
            string? ip = isOnline && liveIps.TryGetValue(d.Id, out var live) ? live : d.LastIp;
            return new
            {
                d.Id,
                d.Name,
                d.Status,
                d.GroupIds,
                groups = d.GroupIds.Where(groups.ContainsKey).Select(g => groups[g]).ToList(),
                d.WorkstationId,
                workstationName = w?.Name,
                workstation = w is null ? null : new { w.ExternalId, w.Name, w.Location },
                online = isOnline,
                d.LastSeenUtc,
                lastIp = ip,
                d.EnrolledUtc
            };
        });
    return Results.Ok(devices);
});

admin.MapPost("/devices/enroll", (CreateEnrollmentDto dto) =>
{
    var e = storage.CreateEnrollment(dto?.Name, dto?.WorkstationId, dto?.GroupIds, dto?.TtlMinutes ?? 60);
    return Results.Ok(new { code = e.Code, expiresUtc = e.ExpiresUtc, name = e.Name, workstationId = e.WorkstationId, groupIds = e.GroupIds });
});

admin.MapPut("/devices/{id}", async (string id, DeviceUpdateDto dto, KioskCoordinator coord) =>
{
    if (!storage.UpdateDevice(id, dto?.Name, dto?.GroupIds, dto?.WorkstationId, touchWorkstation: true))
        return Results.NotFound();
    await coord.NotifyAdminsDevicesAsync();
    return Results.Ok(new { ok = true });
});

admin.MapPost("/devices/{id}/revoke", async (string id, KioskCoordinator coord) =>
{
    if (!storage.SetDeviceStatus(id, "revoked")) return Results.NotFound();
    await coord.NotifyAdminsDevicesAsync();
    return Results.Ok(new { ok = true });
});

admin.MapPost("/devices/{id}/unrevoke", async (string id, KioskCoordinator coord) =>
{
    if (!storage.SetDeviceStatus(id, "active")) return Results.NotFound();
    await coord.NotifyAdminsDevicesAsync();
    return Results.Ok(new { ok = true });
});

admin.MapDelete("/devices/{id}", async (string id, KioskCoordinator coord) =>
{
    if (!storage.DeleteDevice(id)) return Results.NotFound();
    await coord.NotifyAdminsDevicesAsync();
    return Results.Ok(new { ok = true });
});

admin.MapPost("/devices/{id}/identify", async (string id, KioskCoordinator coord) =>
{
    var code = await coord.IdentifyAsync(id);
    return Results.Ok(new { code });
});

// ---- Groups ----
admin.MapGet("/groups", () => Results.Ok(storage.GetGroups()));
admin.MapPost("/groups", (GroupDto dto) => Results.Ok(storage.AddGroup(dto?.Name ?? "")));
admin.MapPut("/groups/{id}", (string id, GroupDto dto) =>
    storage.RenameGroup(id, dto?.Name ?? "") ? Results.Ok(new { ok = true }) : Results.NotFound());
admin.MapDelete("/groups/{id}", (string id) =>
    storage.DeleteGroup(id) ? Results.Ok(new { ok = true }) : Results.NotFound());

// ---- Workstations ----
admin.MapGet("/workstations", () => Results.Ok(storage.GetWorkstations()));
admin.MapPost("/workstations", (WorkstationDto dto) =>
    Results.Ok(storage.AddWorkstation(dto?.ExternalId, dto?.Name, dto?.Location)));
admin.MapPut("/workstations/{id}", (string id, WorkstationDto dto) =>
    storage.UpdateWorkstation(id, dto?.ExternalId, dto?.Name, dto?.Location) ? Results.Ok(new { ok = true }) : Results.NotFound());
admin.MapDelete("/workstations/{id}", (string id) =>
    storage.DeleteWorkstation(id) ? Results.Ok(new { ok = true }) : Results.NotFound());

// ---- API keys (external integration) ----
admin.MapGet("/apikeys", () =>
    Results.Ok(storage.GetApiKeys().Select(k => new { k.Id, k.Label, k.CreatedUtc })));
admin.MapPost("/apikeys", (ApiKeyDto dto) =>
{
    var (key, plaintext) = storage.CreateApiKey(dto?.Label);
    return Results.Ok(new { key.Id, key.Label, key = plaintext }); // plaintext returned once
});
admin.MapDelete("/apikeys/{id}", (string id) =>
    storage.DeleteApiKey(id) ? Results.Ok(new { ok = true }) : Results.NotFound());

// ---- Images ----
admin.MapGet("/images", () =>
    Results.Ok(storage.GetImages().Select(i => new { i.Id, i.OriginalName, i.UploadedUtc, url = "/media/" + i.FileName })));

admin.MapPost("/images", async (HttpRequest req) =>
{
    if (!req.HasFormContentType)
        return Results.BadRequest(new { error = "expected multipart/form-data" });
    var form = await req.ReadFormAsync();
    var added = new List<object>();
    foreach (var file in form.Files)
    {
        var ext = ResolveImageExtension(file.FileName, file.ContentType);
        if (ext is null) continue;
        await using var s = file.OpenReadStream();
        var info = storage.AddImage(s, file.FileName, ext);
        added.Add(new { info.Id, info.OriginalName, url = "/media/" + info.FileName });
    }
    return Results.Ok(added);
});

admin.MapDelete("/images/{id}", (string id) =>
    storage.DeleteImage(id) ? Results.Ok(new { ok = true }) : Results.NotFound());

// ---- Playlist / slideshow ----
admin.MapGet("/playlist", (string? target) =>
{
    var t = string.IsNullOrWhiteSpace(target) ? KioskCoordinator.AllTarget : target;
    KioskState state;
    if (t == KioskCoordinator.AllTarget) state = storage.GetStates().Default;
    else if (t.StartsWith("device:", StringComparison.Ordinal)) state = storage.ResolveState(t["device:".Length..]);
    else state = storage.GetStates().Default; // groups share the default view for editing
    return Results.Ok(new { target = t, imageIds = state.PlaylistImageIds, intervalSec = state.IntervalSec, mode = state.Mode });
});

admin.MapPut("/playlist", async (PlaylistSaveDto dto, KioskCoordinator coord) =>
{
    var target = string.IsNullOrWhiteSpace(dto?.Target) ? KioskCoordinator.AllTarget : dto!.Target!;
    await coord.SaveAndShowSlidesAsync(target, dto?.ImageIds ?? new List<string>(), dto?.IntervalSec ?? 8);
    return Results.Ok(new { ok = true });
});

// ---- Document ----
admin.MapGet("/document", () => Results.Ok(storage.GetDocument()));
admin.MapPut("/document", (DocumentConfig? doc) =>
{
    if (doc is null) return Results.BadRequest(new { error = "document required" });
    storage.SaveDocument(doc);
    return Results.Ok(new { ok = true });
});

// Placeholders currently used in the template, so operators and integrators know which
// fields to provide.
admin.MapGet("/document/placeholders", () =>
    Results.Ok(new { placeholders = DocumentTemplating.Placeholders(storage.GetDocument()) }));

// A document is ALWAYS shown on exactly one tablet (never all/group), so the signer's
// personal data can only ever reach that one device.
admin.MapPost("/show-document", async (ShowDocumentDto dto, KioskCoordinator coord) =>
{
    var deviceId = DeviceFromTarget(dto?.Target);
    if (deviceId is null)
        return Results.BadRequest(new { error = "Документ показывается только на один планшет. Выберите планшет." });
    await coord.ShowDocumentAsync(deviceId, dto?.Fields, dto?.Checkboxes);
    var missing = DocumentTemplating.Missing(storage.GetDocument(), dto?.Fields);
    return Results.Ok(new { ok = true, missingPlaceholders = missing });
});

admin.MapPost("/show-slides", async (TargetDto dto, KioskCoordinator coord) =>
{
    var deviceId = DeviceFromTarget(dto?.Target);
    if (deviceId is null)
        return Results.BadRequest(new { error = "Возврат к рекламе выполняется для одного планшета." });
    await coord.ReturnToSlidesAsync(deviceId);
    return Results.Ok(new { ok = true });
});

// ---- Signatures ----
admin.MapGet("/signatures", () =>
    Results.Ok(storage.ListSignatures().Select(r => new
    {
        r.Id, r.CreatedUtc, r.DocumentTitle, r.DeviceId, r.DeviceName, r.WorkstationName,
        checkedCount = r.Items.Count(i => i.Checked), totalCount = r.Items.Count
    })));

admin.MapGet("/signatures/{id}", (string id) =>
{
    var rec = storage.GetSignature(id);
    return rec is null ? Results.NotFound() : Results.Ok(rec);
});

admin.MapGet("/signatures/{id}/image", (string id) =>
{
    var path = storage.GetSignatureImagePath(id);
    return path is null ? Results.NotFound() : Results.File(path, "image/png");
});

admin.MapGet("/signatures/{id}/pdf", (string id, PdfService pdf) =>
{
    var path = storage.GetPdfPath(id);
    if (path is null)
    {
        // The PDF is missing only if generation failed at sign time. Regenerate it on demand
        // from the exact stored record, document and signature image, so a transient failure
        // does not leave a signed record permanently without a downloadable PDF.
        var rec = storage.GetSignature(id);
        var doc = storage.GetSignatureDocument(id);
        var png = storage.GetSignatureImageBytes(id);
        if (rec is not null && doc is not null && png is not null)
        {
            try { path = pdf.Generate(rec, doc, png); }
            catch (Exception ex) { app.Logger.LogError(ex, "On-demand PDF regeneration failed for {Id}", id); }
        }
    }
    return path is null ? Results.NotFound() : Results.File(path, "application/pdf", id + ".pdf");
});

// ==================== External integration API (X-Api-Key) ====================

var ext = app.MapGroup("/api/ext").AddEndpointFilter(async (ctx, next) =>
{
    var key = ctx.HttpContext.Request.Headers["X-Api-Key"].ToString();
    if (!storage.ValidateApiKey(key))
        return Results.Json(new { error = "invalid api key" }, statusCode: StatusCodes.Status401Unauthorized);
    return await next(ctx);
});

ext.MapGet("/devices", () =>
{
    var online = tracker.OnlineDeviceIds();
    var liveIps = tracker.OnlineIps();
    var wss = storage.GetWorkstations().ToDictionary(w => w.Id, w => w);
    var groups = storage.GetGroups().ToDictionary(g => g.Id, g => g.Name);
    return Results.Ok(storage.GetDevices().Select(d =>
    {
        bool isOnline = online.Contains(d.Id);
        return new
        {
            deviceId = d.Id,
            d.Name,
            d.Status,
            online = isOnline,
            d.LastSeenUtc,
            lastIp = isOnline && liveIps.TryGetValue(d.Id, out var live) ? live : d.LastIp,
            groups = d.GroupIds.Where(groups.ContainsKey).Select(g => groups[g]),
            workstation = d.WorkstationId != null && wss.TryGetValue(d.WorkstationId, out var w)
                ? new { w.Id, w.ExternalId, w.Name, w.Location } : null
        };
    }));
});

ext.MapGet("/workstations", () =>
    Results.Ok(storage.GetWorkstations().Select(w => new { w.Id, w.ExternalId, w.Name, w.Location })));

ext.MapPost("/workstations", (WorkstationDto dto) =>
    Results.Ok(storage.AddWorkstation(dto?.ExternalId, dto?.Name, dto?.Location)));

ext.MapPost("/enrollments", (ExtEnrollmentDto dto) =>
{
    string? wsId = null;
    if (!string.IsNullOrWhiteSpace(dto?.WorkstationExternalId))
    {
        var ws = storage.GetWorkstations().FirstOrDefault(w => w.ExternalId == dto!.WorkstationExternalId);
        if (ws is null) return Results.Json(new { error = "unknown workstationExternalId" }, statusCode: StatusCodes.Status404NotFound);
        wsId = ws.Id;
    }
    var e = storage.CreateEnrollment(dto?.Name, wsId, null, 60);
    return Results.Ok(new { code = e.Code, expiresUtc = e.ExpiresUtc });
});

ext.MapPut("/devices/{id}/workstation", (string id, ExtWorkstationAssignDto dto) =>
    storage.AssignWorkstationByExternalId(id, dto?.ExternalId)
        ? Results.Ok(new { ok = true })
        : Results.Json(new { error = "device or workstation not found" }, statusCode: StatusCodes.Status404NotFound));

// Resolve a device by its id, or by the external id of the workstation it is assigned to.
// A document carries the signer's personal data, so this must resolve to exactly ONE device:
// if a workstation has several tablets, we refuse rather than pick one arbitrarily and risk
// showing one client's data on another client's screen. status is 0 on success.
(string? id, int status, string? error) ResolveExtDeviceId(string? deviceId, string? workstationExternalId)
{
    if (!string.IsNullOrWhiteSpace(deviceId))
        return storage.GetDevice(deviceId!) is not null
            ? (deviceId, 0, null)
            : (null, StatusCodes.Status404NotFound, "device not found");
    if (!string.IsNullOrWhiteSpace(workstationExternalId))
    {
        var ws = storage.GetWorkstations().FirstOrDefault(w => w.ExternalId == workstationExternalId);
        if (ws is null) return (null, StatusCodes.Status404NotFound, "workstation not found");
        var matches = storage.GetDevices().Where(d => d.WorkstationId == ws.Id).Select(d => d.Id).ToList();
        if (matches.Count == 0) return (null, StatusCodes.Status404NotFound, "no tablet is assigned to this workstation");
        if (matches.Count > 1) return (null, StatusCodes.Status409Conflict, "several tablets are assigned to this workstation; pass deviceId to choose one");
        return (matches[0], 0, null);
    }
    return (null, StatusCodes.Status400BadRequest, "pass deviceId or workstationExternalId");
}

// A single device id from an admin target ("device:{id}" or a bare id); null for all/group/unknown.
string? DeviceFromTarget(string? target)
{
    if (string.IsNullOrWhiteSpace(target)) return null;
    var id = target.StartsWith("device:", StringComparison.Ordinal) ? target["device:".Length..] : target;
    return storage.GetDevice(id) is not null ? id : null;
}

// Show the signing document on one tablet with per-signer data. Placeholders {{...}} in the
// admin-authored template are filled from `fields`; `checkboxes` add per-signer consent items.
ext.MapPost("/show-document", async (ExtShowDocumentDto dto, KioskCoordinator coord) =>
{
    var (deviceId, status, error) = ResolveExtDeviceId(dto?.DeviceId, dto?.WorkstationExternalId);
    if (deviceId is null)
        return Results.Json(new { error }, statusCode: status);
    await coord.ShowDocumentAsync(deviceId, dto?.Fields, dto?.Checkboxes);
    var missing = DocumentTemplating.Missing(storage.GetDocument(), dto?.Fields);
    return Results.Ok(new { ok = true, deviceId, missingPlaceholders = missing });
});

// Return one tablet to advertising and clear its signer data.
ext.MapPost("/return-slides", async (ExtShowDocumentDto dto, KioskCoordinator coord) =>
{
    var (deviceId, status, error) = ResolveExtDeviceId(dto?.DeviceId, dto?.WorkstationExternalId);
    if (deviceId is null)
        return Results.Json(new { error }, statusCode: status);
    await coord.ReturnToSlidesAsync(deviceId);
    return Results.Ok(new { ok = true, deviceId });
});

app.Run();

// ==================== Local helpers ====================

// Real client IP for rate-limit partitioning, resolved after UseForwardedHeaders has
// applied X-Forwarded-For. Falls back to a constant so a missing IP shares one bucket
// rather than escaping the limiter entirely.
static string ClientIp(HttpContext ctx) =>
    ctx.Connection.RemoteIpAddress?.ToString() ?? "unknown";

static string? ResolveImageExtension(string fileName, string? contentType)
{
    var allowed = new[] { ".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp" };
    var ext = Path.GetExtension(fileName).ToLowerInvariant();
    if (allowed.Contains(ext))
        return ext == ".jpeg" ? ".jpg" : ext;
    return contentType switch
    {
        "image/jpeg" => ".jpg",
        "image/png" => ".png",
        "image/gif" => ".gif",
        "image/webp" => ".webp",
        "image/bmp" => ".bmp",
        _ => null
    };
}

static byte[]? DecodeDataUrlPng(string dataUrl)
{
    var comma = dataUrl.IndexOf(',');
    var payload = comma >= 0 ? dataUrl[(comma + 1)..] : dataUrl;
    try { return Convert.FromBase64String(payload); }
    catch { return null; }
}

// PNG magic number: 89 50 4E 47 0D 0A 1A 0A. Guards against storing non-image bytes.
static bool IsPng(byte[] b) =>
    b.Length > 8 && b[0] == 0x89 && b[1] == 0x50 && b[2] == 0x4E && b[3] == 0x47
    && b[4] == 0x0D && b[5] == 0x0A && b[6] == 0x1A && b[7] == 0x0A;
