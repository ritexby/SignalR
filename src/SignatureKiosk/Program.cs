using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.HttpOverrides;
using Microsoft.Extensions.FileProviders;
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
var adminToken = ComputeToken(adminPassword);

const string AdminCookie = "sk_admin";

// Behind a reverse proxy (nginx / Nginx Proxy Manager), possibly on another host:
// honour X-Forwarded-Proto/For so Request.IsHttps and client IPs reflect the real client.
var forwardedOptions = new ForwardedHeadersOptions
{
    ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto
};
// The proxy lives on the LAN (not loopback), so accept forwarded headers from it.
forwardedOptions.KnownNetworks.Clear();
forwardedOptions.KnownProxies.Clear();
app.UseForwardedHeaders(forwardedOptions);

// Redirect the bare /admin (no trailing slash) to /admin/ so its relative assets resolve.
// Implemented as middleware (not an endpoint) so it never shadows the static /admin/ files.
app.Use(async (context, next) =>
{
    if (context.Request.Path.Equals("/admin", StringComparison.OrdinalIgnoreCase))
    {
        context.Response.Redirect("/admin/");
        return;
    }
    await next();
});

// Static files: default document (kiosk index.html) + wwwroot assets.
app.UseDefaultFiles();
app.UseStaticFiles();

// Publicly-served uploaded images.
app.UseStaticFiles(new StaticFileOptions
{
    FileProvider = new PhysicalFileProvider(storage.ImagesDir),
    RequestPath = "/media"
});

app.MapHub<KioskHub>("/hub/kiosk");

// ---------------- Public endpoint: submit signature ----------------

app.MapPost("/api/sign", async (SignatureSubmission sub, KioskCoordinator coord) =>
{
    if (sub is null || string.IsNullOrWhiteSpace(sub.Signature))
        return Results.BadRequest(new { error = "signature required" });

    var png = DecodeDataUrlPng(sub.Signature);
    if (png is null)
        return Results.BadRequest(new { error = "invalid signature image" });

    string? deviceName = null;
    if (!string.IsNullOrWhiteSpace(sub.DeviceId))
        deviceName = storage.GetDevices().FirstOrDefault(d => d.Id == sub.DeviceId)?.Name;

    var doc = storage.GetDocument();
    var rec = storage.AddSignature(sub, doc.Title, deviceName, png);
    await coord.NotifyAdminsSignatureAsync(rec);
    return Results.Ok(new { id = rec.Id });
});

// ---------------- Admin authentication ----------------

app.MapPost("/api/admin/login", (LoginDto dto, HttpContext ctx) =>
{
    if (dto?.Password is not null && FixedTimeEquals(dto.Password, adminPassword))
    {
        ctx.Response.Cookies.Append(AdminCookie, adminToken, new CookieOptions
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
    ctx.Response.Cookies.Delete(AdminCookie);
    return Results.Ok(new { ok = true });
});

app.MapGet("/api/admin/me", (HttpContext ctx) =>
    Results.Ok(new { authenticated = IsAdmin(ctx) }));

// ---------------- Admin API (password protected) ----------------

var admin = app.MapGroup("/api/admin").AddEndpointFilter(async (ctx, next) =>
{
    if (!IsAdmin(ctx.HttpContext))
        return Results.Json(new { error = "unauthorized" }, statusCode: StatusCodes.Status401Unauthorized);
    return await next(ctx);
});

// Devices
admin.MapGet("/devices", () =>
{
    var online = tracker.OnlineDeviceIds();
    var devices = storage.GetDevices()
        .OrderBy(d => d.Name)
        .Select(d => new
        {
            d.Id,
            d.Name,
            d.FirstSeenUtc,
            d.LastSeenUtc,
            online = online.Contains(d.Id)
        });
    return Results.Ok(devices);
});

admin.MapPut("/devices/{id}", (string id, DeviceRenameDto dto) =>
    storage.RenameDevice(id, dto?.Name ?? "") ? Results.Ok(new { ok = true }) : Results.NotFound());

// Images
admin.MapGet("/images", () =>
{
    var imgs = storage.GetImages().Select(i => new
    {
        i.Id,
        i.OriginalName,
        i.UploadedUtc,
        url = "/media/" + i.FileName
    });
    return Results.Ok(imgs);
});

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

// Playlist / slideshow
admin.MapGet("/playlist", (string? target) =>
{
    var t = string.IsNullOrWhiteSpace(target) ? KioskCoordinator.AllTarget : target;
    var state = t == KioskCoordinator.AllTarget
        ? storage.GetStates().Default
        : storage.ResolveState(t);
    return Results.Ok(new { target = t, imageIds = state.PlaylistImageIds, intervalSec = state.IntervalSec, mode = state.Mode });
});

admin.MapPut("/playlist", async (PlaylistSaveDto dto, KioskCoordinator coord) =>
{
    var target = string.IsNullOrWhiteSpace(dto.Target) ? KioskCoordinator.AllTarget : dto.Target!;
    await coord.SaveAndShowSlidesAsync(target, dto.ImageIds ?? new List<string>(), dto.IntervalSec);
    return Results.Ok(new { ok = true });
});

// Document
admin.MapGet("/document", () => Results.Ok(storage.GetDocument()));

admin.MapPut("/document", (DocumentConfig doc) =>
{
    storage.SaveDocument(doc);
    return Results.Ok(new { ok = true });
});

admin.MapPost("/show-document", async (TargetDto dto, KioskCoordinator coord) =>
{
    var target = string.IsNullOrWhiteSpace(dto?.Target) ? KioskCoordinator.AllTarget : dto!.Target!;
    await coord.ShowDocumentAsync(target);
    return Results.Ok(new { ok = true });
});

admin.MapPost("/show-slides", async (TargetDto dto, KioskCoordinator coord) =>
{
    var target = string.IsNullOrWhiteSpace(dto?.Target) ? KioskCoordinator.AllTarget : dto!.Target!;
    await coord.ReturnToSlidesAsync(target);
    return Results.Ok(new { ok = true });
});

// Signatures
admin.MapGet("/signatures", () =>
{
    var list = storage.ListSignatures().Select(r => new
    {
        r.Id,
        r.CreatedUtc,
        r.DocumentTitle,
        r.DeviceId,
        r.DeviceName,
        checkedCount = r.Items.Count(i => i.Checked),
        totalCount = r.Items.Count
    });
    return Results.Ok(list);
});

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

app.Run();

// ---------------- Local helpers ----------------

bool IsAdmin(HttpContext ctx) =>
    ctx.Request.Cookies.TryGetValue(AdminCookie, out var v) && FixedTimeEquals(v, adminToken);

static string ComputeToken(string password)
{
    var bytes = SHA256.HashData(Encoding.UTF8.GetBytes("sk::" + password));
    return Convert.ToHexString(bytes);
}

static bool FixedTimeEquals(string a, string b) =>
    CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(a), Encoding.UTF8.GetBytes(b));

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
