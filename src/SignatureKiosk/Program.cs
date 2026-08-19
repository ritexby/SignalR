using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
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
app.UseForwardedHeaders(forwardedOptions);

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

app.UseDefaultFiles();
app.UseStaticFiles();
app.UseStaticFiles(new StaticFileOptions
{
    FileProvider = new PhysicalFileProvider(storage.ImagesDir),
    RequestPath = "/media"
});

app.MapHub<KioskHub>("/hub/kiosk");

// ==================== Public: tablet enrollment ====================

app.MapPost("/api/kiosk/enroll", (EnrollRequest req) =>
{
    var result = storage.RedeemEnrollment(req?.Code);
    if (result is null)
        return Results.Json(new { error = "invalid or expired code" }, statusCode: StatusCodes.Status400BadRequest);
    var (device, token) = result.Value;
    return Results.Ok(new { deviceId = device.Id, name = device.Name, token });
});

// ==================== Device-authenticated: submit signature ====================

app.MapPost("/api/sign", async (SignatureSubmission sub, HttpContext ctx, KioskCoordinator coord, PdfService pdf) =>
{
    if (sub is null || string.IsNullOrWhiteSpace(sub.Signature))
        return Results.BadRequest(new { error = "signature required" });

    var png = DecodeDataUrlPng(sub.Signature);
    if (png is null)
        return Results.BadRequest(new { error = "invalid signature image" });

    var deviceId = ctx.User.FindFirst("device_id")?.Value;
    var device = deviceId is null ? null : storage.GetDevice(deviceId);
    Workstation? ws = device?.WorkstationId is null
        ? null
        : storage.GetWorkstations().FirstOrDefault(w => w.Id == device.WorkstationId);

    var doc = storage.GetDocument();
    var rec = storage.AddSignature(sub, doc.Title, device, ws, png);

    try { pdf.Generate(rec, doc, png); }
    catch (Exception ex) { app.Logger.LogError(ex, "PDF generation failed for {Id}", rec.Id); }

    await coord.NotifyAdminsSignatureAsync(rec);
    return Results.Ok(new { id = rec.Id });
}).RequireAuthorization("Device");

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
});

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
    var groups = storage.GetGroups().ToDictionary(g => g.Id, g => g.Name);
    var wss = storage.GetWorkstations().ToDictionary(w => w.Id, w => w.Name);
    var devices = storage.GetDevices()
        .OrderBy(d => d.Name)
        .Select(d => new
        {
            d.Id,
            d.Name,
            d.Status,
            d.GroupIds,
            groups = d.GroupIds.Where(groups.ContainsKey).Select(g => groups[g]).ToList(),
            d.WorkstationId,
            workstationName = d.WorkstationId != null && wss.TryGetValue(d.WorkstationId, out var wn) ? wn : null,
            online = online.Contains(d.Id),
            d.LastSeenUtc,
            d.EnrolledUtc
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
    var target = string.IsNullOrWhiteSpace(dto.Target) ? KioskCoordinator.AllTarget : dto.Target!;
    await coord.SaveAndShowSlidesAsync(target, dto.ImageIds ?? new List<string>(), dto.IntervalSec);
    return Results.Ok(new { ok = true });
});

// ---- Document ----
admin.MapGet("/document", () => Results.Ok(storage.GetDocument()));
admin.MapPut("/document", (DocumentConfig doc) => { storage.SaveDocument(doc); return Results.Ok(new { ok = true }); });

admin.MapPost("/show-document", async (TargetDto dto, KioskCoordinator coord) =>
{
    await coord.ShowDocumentAsync(string.IsNullOrWhiteSpace(dto?.Target) ? KioskCoordinator.AllTarget : dto!.Target!);
    return Results.Ok(new { ok = true });
});

admin.MapPost("/show-slides", async (TargetDto dto, KioskCoordinator coord) =>
{
    await coord.ReturnToSlidesAsync(string.IsNullOrWhiteSpace(dto?.Target) ? KioskCoordinator.AllTarget : dto!.Target!);
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

admin.MapGet("/signatures/{id}/pdf", (string id) =>
{
    var path = storage.GetPdfPath(id);
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
    var wss = storage.GetWorkstations().ToDictionary(w => w.Id, w => w);
    var groups = storage.GetGroups().ToDictionary(g => g.Id, g => g.Name);
    return Results.Ok(storage.GetDevices().Select(d => new
    {
        deviceId = d.Id,
        d.Name,
        d.Status,
        online = online.Contains(d.Id),
        d.LastSeenUtc,
        groups = d.GroupIds.Where(groups.ContainsKey).Select(g => groups[g]),
        workstation = d.WorkstationId != null && wss.TryGetValue(d.WorkstationId, out var w)
            ? new { w.Id, w.ExternalId, w.Name, w.Location } : null
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

app.Run();

// ==================== Local helpers ====================

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
