using Microsoft.AspNetCore.DataProtection;
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
// An integration writes new { urine = true } and sends a real JSON boolean. Without this the whole
// request is rejected before any handler runs, the document never appears, and the caller has
// nothing to go on. Values arrive as strings either way: that is what a template substitutes.
builder.Services.ConfigureHttpJsonOptions(o =>
    o.SerializerOptions.Converters.Add(new LenientStringDictionaryConverter()));
// Ключи защиты данных ASP.NET. Без явной настройки платформа держит их только в памяти и
// пишет об этом три предупреждения при каждом запуске. Складываем их в каталог данных рядом с
// остальным состоянием: он и так принадлежит служебному пользователю и закрыт от посторонних.
// Так ключи переживают перезапуск, а журнал не начинается с пугающих сообщений ни о чём.
builder.Services.AddDataProtection()
    .PersistKeysToFileSystem(new DirectoryInfo(Path.Combine(
        builder.Configuration["DataDir"] is { Length: > 0 } dd ? dd : Path.Combine(builder.Environment.ContentRootPath, "data"),
        "keys")))
    .SetApplicationName("HELIX SignTablet");
builder.Services.AddSingleton<StorageService>();
builder.Services.AddSingleton<DeviceTracker>();
builder.Services.AddSingleton<KioskCoordinator>();
builder.Services.AddSingleton<TokenAuthService>();
builder.Services.AddSingleton<PdfService>();
builder.Services.AddSingleton<ScanBroker>();
builder.Services.AddSingleton<EventLogService>();
builder.Services.AddSingleton<AlertService>();
// Talking to the tablets' own FreeKiosk API (server -> tablet). Kept on its own HttpClient so a
// slow or unreachable tablet cannot tie up anything else.
builder.Services.AddHttpClient("freekiosk", c =>
    {
        // A tablet answers with a small JSON document. Without a cap, one that streams forever
        // would be buffered until the timeout, and this is the process that runs signing.
        c.MaxResponseContentBufferSize = 1024 * 1024;
    })
    .ConfigurePrimaryHttpMessageHandler(() => new SocketsHttpHandler
    {
        // Never follow a redirect. The address is checked before the call, but .NET re-sends our
        // headers to whatever a redirect points at, so one misbehaving tablet could otherwise walk
        // the fleet API key to any host it likes, or turn this into a call to an internal service.
        AllowAutoRedirect = false,
        // Tablets are on the local network; a proxy configured for outbound internet traffic must
        // never see these requests.
        UseProxy = false,
        ConnectTimeout = TimeSpan.FromSeconds(5)
    });
builder.Services.AddSingleton<FreeKioskClient>();
builder.Services.AddSingleton<KioskHealthCache>();
builder.Services.AddHostedService<AlertMonitor>();
// Расписание управления планшетами: включить экраны утром, погасить вечером, перезагрузить ночью.
builder.Services.AddSingleton<ScheduleRunner>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<ScheduleRunner>());
// Mirror server warnings/errors into the operator-visible log ("Логи" tab).
builder.Services.AddSingleton<ILoggerProvider>(sp => new EventLogProvider(sp.GetRequiredService<EventLogService>()));

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
    // Diagnostics get their own budget: a tablet stuck in an error loop must never exhaust the
    // limit that signature submissions depend on (a whole site can share one public IP).
    options.AddPolicy("diag", Fixed(30));
    // External integrations: generous for normal use, but bounded so a runaway caller cannot
    // starve the storage lock that signing depends on.
    options.AddPolicy("ext", Fixed(600));
    // Scanning gets its own budget so a tablet stuck in a scan loop cannot consume the permits
    // that signature submission depends on (a whole site can share one public IP).
    options.AddPolicy("scan", Fixed(60));
});

var app = builder.Build();

var storage = app.Services.GetRequiredService<StorageService>();
var tracker = app.Services.GetRequiredService<DeviceTracker>();
// Resolve the event log now so its ILoggerProvider is live from the very first request, and
// record the restart: for a 24/7 fleet an unexpected restart is itself an operational event.
var eventLog = app.Services.GetRequiredService<EventLogService>();
eventLog.Add("info", "service", "Сервис запущен");
// Повреждённый файл данных откладывается в сторону вместо того, чтобы его затёрло пустым
// значением, и об этом надо сказать сразу: часть настроек в этот момент выглядит так, будто её
// никогда не было. Сначала разбираем то, что накопилось при чтении настроек на старте, потом
// подключаем журнал напрямую, чтобы дальше сообщения шли без задержки.
static string CorruptText(string file, string backup, string reason) =>
    "Файл данных «" + file + "» повреждён и отложен как «" + backup + "» (" + reason + "). " +
    "Его содержимое сейчас пустое. Файл сохранён в каталоге данных, из него можно восстановить записи.";
while (storage.CorruptFiles.TryDequeue(out var corrupt))
    eventLog.Add("error", "storage", CorruptText(corrupt.File, corrupt.Backup, corrupt.Reason));
storage.OnCorrupt = (file, backup, reason) => eventLog.Add("error", "storage", CorruptText(file, backup, reason));
app.Lifetime.ApplicationStopping.Register(() => eventLog.Add("info", "service", "Сервис остановлен"));

// Any unhandled failure returns a JSON body instead of an empty 500, so the admin panel and the
// tablets can show something useful. The failure itself is already mirrored into the event log.
app.UseExceptionHandler(branch => branch.Run(async context =>
{
    context.Response.StatusCode = StatusCodes.Status500InternalServerError;
    context.Response.ContentType = "application/json; charset=utf-8";
    await context.Response.WriteAsJsonAsync(new { error = "Внутренняя ошибка сервера. Подробности во вкладке «Логи»." });
}));

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

// A hand-drawn signature is a few tens of KB; anything far larger is a malformed or hostile
// payload that would otherwise be written to disk and embedded in a PDF.
const int MaxSignaturePngBytes = 2 * 1024 * 1024;
// The same bound expressed on the encoded data URL, checked before decoding.
const int MaxSignatureDataUrlChars = 3 * 1024 * 1024;

// ==================== Device-authenticated: submit signature ====================

app.MapPost("/api/sign", async (SignatureSubmission sub, HttpContext ctx, KioskCoordinator coord, PdfService pdf) =>
{
    if (sub is null || string.IsNullOrWhiteSpace(sub.Signature))
        return Results.BadRequest(new { error = "signature required" });

    // Check the encoded size before decoding: a huge data URL would otherwise be materialised in
    // full (tens of MB) only to be rejected afterwards.
    if (sub.Signature.Length > MaxSignatureDataUrlChars)
        return Results.BadRequest(new { error = "signature image too large" });
    if ((sub.SubmissionId?.Length ?? 0) > 128)
        return Results.BadRequest(new { error = "invalid submissionId" });

    var png = DecodeDataUrlPng(sub.Signature);
    if (png is null || !IsPng(png))
        return Results.BadRequest(new { error = "invalid signature image" });
    if (png.Length > MaxSignaturePngBytes)
        return Results.BadRequest(new { error = "signature image too large" });

    // Reject a malformed item list at the door: a null element used to be stored and then threw on
    // every later read of the signatures list, which no endpoint could repair.
    var items = sub.Items ?? new List<SubmittedItem>();
    if (items.Count > 200 || items.Any(i => i is null || (i.Label?.Length ?? 0) > 2000))
        return Results.BadRequest(new { error = "invalid items" });

    var deviceId = ctx.User.FindFirst("device_id")?.Value;
    if (deviceId is null) return Results.BadRequest(new { error = "device required" });

    var submissionId = sub.SubmissionId?.Trim();
    var cleared = false;
    try
    {
        var state = storage.ResolveState(deviceId);
        var signing = state.Mode == "document";

        // A record already stored for this submission means the signing session that produced it is
        // finished (the session is cleared immediately after storing).
        var existing = string.IsNullOrEmpty(submissionId)
            ? null
            : storage.FindSignatureBySubmissionId(deviceId, submissionId);

        if (existing is not null)
        {
            // The tablet lost the response and retried: hand back the original record. If a NEW
            // document is already on this tablet, this is a stale replay from a previous client:
            // refuse it and leave the current signer's session untouched.
            if (signing)
                return Results.Json(new { error = "stale submission: another document is open" },
                    statusCode: StatusCodes.Status409Conflict);
            cleared = true;                       // nothing to clear: the tablet is on slides
            return Results.Ok(new { id = existing.Id, duplicate = true });
        }

        // A signature only means something while this tablet is actually showing a document. A
        // submit outside that window (a retry after the session was cleared, or a stray call) would
        // otherwise be stored with no signer data and raw {{tags}} in the PDF, which looks like a
        // valid consent record but is worthless.
        if (!signing)
            return Results.Json(new { error = "no document is being signed on this tablet" },
                statusCode: StatusCodes.Status409Conflict);

        var device = storage.GetDevice(deviceId);
        Workstation? ws = device?.WorkstationId is null
            ? null
            : storage.GetWorkstations().FirstOrDefault(w => w.Id == device.WorkstationId);

        // Resolve the document with THIS device's signer data so the PDF and the stored record
        // show the real values, not the {{tags}}.
        var fields = state.Fields is { Count: > 0 } ? state.Fields : null;

        // Условия на состояние чекбокса считаются на планшете, пока клиент их нажимает, поэтому
        // документ пересчитывается здесь заново по тому, что он в итоге отметил. Так в записи и в
        // PDF оказывается ровно то, что человек видел перед собой, и планшету не нужно ничего
        // дополнительно присылать: достаточно самих отметок.
        var finalStates = new Dictionary<string, bool>(StringComparer.OrdinalIgnoreCase);
        foreach (var it in sub.Items ?? new List<SubmittedItem>())
        {
            var k = DocumentTemplating.CleanKey(it?.Key);
            if (k.Length > 0) finalStates[k] = it!.Checked;
        }
        var finalGroups = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var g in sub.Groups ?? new List<SubmittedGroup>())
        {
            var k = DocumentTemplating.CleanKey(g?.Key);
            if (k.Length > 0) finalGroups[k] = DocumentTemplating.CleanKey(g!.Selected);
        }

        var template = storage.GetDocument();
        var resolvedDoc = DocumentTemplating.Resolve(template, fields, state.DynamicCheckboxes,
            finalGroups, finalStates);
        // Блоки, скрытые условием на чекбокс, клиент не видел: их не должно быть и в PDF.
        DocumentTemplating.ApplyLiveConditions(resolvedDoc, finalStates, finalGroups);

        // В запись и в PDF идут только те поля, которые документ действительно использует.
        // Внешняя система вправе прислать вместе с данными подписанта и свои служебные поля
        // (номер заказа, идентификатор в их системе), но человек их не видел и не подписывал,
        // поэтому в подписанном документе им не место, а хранить их незачем.
        var used = DocumentTemplating.UsedFields(template);
        var recordFields = fields is null
            ? null
            : fields.Where(kv => used.Contains(kv.Key)).ToDictionary(kv => kv.Key, kv => kv.Value);
        if (recordFields is { Count: 0 }) recordFields = null;

        var rec = storage.AddSignature(sub, resolvedDoc, device, ws, png, recordFields);

        // The record is safely stored: from here the signer's data may leave the tablet.
        ClearSession();

        try { pdf.Generate(rec, resolvedDoc, png); }
        catch (Exception ex) { app.Logger.LogError(ex, "PDF generation failed for {Id}", rec.Id); }

        await coord.NotifyAdminsSignatureAsync(rec);
        return Results.Ok(new { id = rec.Id });
    }
    finally
    {
        // Privacy above all: whatever happened, the signer's data leaves this tablet. Otherwise a
        // failed submit would leave one client's document there for the next person to see.
        ClearSession();
    }

    void ClearSession()
    {
        if (cleared) return;
        cleared = true;
        try { coord.ClearSignerSession(deviceId); }
        catch (Exception ex) { app.Logger.LogError(ex, "Failed to clear signer session for {Device}", deviceId); }
    }
}).RequireAuthorization("Device").RequireRateLimiting("sign");

// ==================== Device-authenticated: submit a scanned code ====================

app.MapPost("/api/scan", async (ScanSubmission sub, HttpContext ctx, KioskCoordinator coord, ScanBroker broker) =>
{
    var code = (sub?.Code ?? "").Trim();
    if (code.Length == 0) return Results.BadRequest(new { error = "code required" });
    if (code.Length > StorageService.MaxScanCodeLength) return Results.BadRequest(new { error = "code too long" });

    var deviceId = ctx.User.FindFirst("device_id")?.Value;
    var device = deviceId is null ? null : storage.GetDevice(deviceId);
    Workstation? ws = device?.WorkstationId is null
        ? null
        : storage.GetWorkstations().FirstOrDefault(w => w.Id == device.WorkstationId);

    var rec = storage.AddScan(code, (sub?.Format ?? "").Trim(), device, ws);
    // Hand the code to an external caller that asked for it and is waiting right now.
    if (deviceId is not null) broker.Publish(deviceId, rec);
    await coord.NotifyAdminsScanAsync(rec);
    return Results.Ok(new { id = rec.Id });
}).RequireAuthorization("Device").RequireRateLimiting("scan");

// ==================== Device-authenticated: report a tablet-side failure ====================

// A tablet reports its own errors (JS exceptions, camera denied, failed submits) so the operator
// sees fleet problems on the "Логи" tab instead of having to inspect each device.
app.MapPost("/api/log", (ClientLogDto dto, HttpContext ctx, EventLogService logs) =>
{
    var message = (dto?.Message ?? "").Trim();
    if (message.Length == 0) return Results.BadRequest(new { error = "message required" });

    var deviceId = ctx.User.FindFirst("device_id")?.Value;
    var deviceName = ctx.User.FindFirst("name")?.Value;
    var level = (dto?.Level ?? "error").Trim().ToLowerInvariant();
    if (level != "warn" && level != "info") level = "error";

    logs.Add(level, "tablet", message, dto?.Detail, deviceId, deviceName);
    return Results.Ok(new { ok = true });
}).RequireAuthorization("Device").RequireRateLimiting("diag");

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
admin.MapGet("/devices", (KioskHealthCache healthCache) =>
{
    var online = tracker.OnlineDeviceIds();
    var liveIps = tracker.OnlineIps();
    var appVersions = tracker.OnlineAppVersions();
    var healthById = healthCache.All();
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
                d.ControlIp,
                d.ControlPort,
                health = healthById.TryGetValue(d.Id, out var h) ? h : null,
                // Which build of the kiosk page this tablet is actually running. Blank on an old
                // page that does not report it yet, which is itself the answer.
                appVersion = isOnline && appVersions.TryGetValue(d.Id, out var v) ? v : null,
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
    // Same as scanning: the number is drawn by the tablet itself, so an offline tablet shows
    // nothing and the operator would be left staring at a screen that never changes.
    if (!tracker.IsOnline(id))
    {
        var dev = storage.GetDevice(id);
        return Results.Json(new
        {
            error = "Планшет «" + (dev?.Name ?? id) + "» сейчас не на связи, номер на нём не появится."
        }, statusCode: StatusCodes.Status409Conflict);
    }
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
admin.MapGet("/playlist", (string? target, string? ids) =>
{
    var t = string.IsNullOrWhiteSpace(target) ? KioskCoordinator.AllTarget : target;
    KioskState state;
    if (t == KioskCoordinator.AllTarget) state = storage.GetStates().Default;
    else if (t == "devices")
    {
        // Набор планшетов: показываем список первого отмеченного. Сохранение пишет всем
        // отмеченным одно и то же, поэтому это и есть список набора.
        var first = (ids ?? "").Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).FirstOrDefault();
        state = first is null ? storage.GetStates().Default : storage.ResolveState(first);
    }
    else if (t.StartsWith("device:", StringComparison.Ordinal)) state = storage.ResolveState(t["device:".Length..]);
    else if (t.StartsWith("group:", StringComparison.Ordinal))
    {
        // Сохранение для группы пишет плейлист каждому её планшету, поэтому и читать надо оттуда
        // же. Раньше здесь отдавался общий список: оператор сохранял рекламу для группы, заходил
        // снова и видел чужой набор, а следующее сохранение затирало то, что он только что задал.
        var groupId = t["group:".Length..];
        var member = storage.GetDevices().FirstOrDefault(d => d.GroupIds.Contains(groupId));
        state = member is null ? storage.GetStates().Default : storage.ResolveState(member.Id);
    }
    else state = storage.GetStates().Default;
    return Results.Ok(new { target = t, imageIds = state.PlaylistImageIds, intervalSec = state.IntervalSec, mode = state.Mode });
});

admin.MapPut("/playlist", async (PlaylistSaveDto dto, KioskCoordinator coord) =>
{
    var target = string.IsNullOrWhiteSpace(dto?.Target) ? KioskCoordinator.AllTarget : dto!.Target!;
    if (target == "devices" && (dto?.DeviceIds is null || dto.DeviceIds.Count == 0))
        return Results.BadRequest(new { error = "Отметьте хотя бы один планшет." });
    await coord.SaveAndShowSlidesAsync(target, dto?.ImageIds ?? new List<string>(), dto?.IntervalSec ?? 8, dto?.DeviceIds);
    return Results.Ok(new { ok = true });
});

// ---- Document ----
// The tags an integration may send, and the fixed values some of them take. The editor reads this
// instead of keeping its own copy, so adding a tag in one place cannot leave the other behind.
admin.MapGet("/field-schema", () => Results.Ok(new
{
    fields = DocumentTemplating.KnownFields.Select(f => new
    {
        name = f,
        values = FieldSchema.Options.TryGetValue(f, out var v) ? v : null,
        // Подписи для человека там, где значение на проводе и слово на экране это разные вещи:
        // пол уходит как M и F, а оператор выбирает «М (мужской)» и «Ж (женский)».
        valueLabels = FieldSchema.ValueLabels.TryGetValue(f, out var l) ? l : null
    })
}));

admin.MapGet("/document", () => Results.Ok(storage.GetDocument()));
admin.MapPut("/document", (DocumentConfig? doc) =>
{
    if (doc is null) return Results.BadRequest(new { error = "document required" });
    DocumentTemplating.Sanitize(doc);
    var badImages = DocumentTemplating.UnsupportedImages(doc);
    if (badImages.Count > 0)
        return Results.BadRequest(new
        {
            error = "Эти картинки нельзя использовать в документе: их не удастся вложить в PDF. " +
                    "Подойдут PNG, JPG или BMP. Проблемные файлы: " + string.Join(", ", badImages)
        });
    storage.SaveDocument(doc);
    return Results.Ok(new { ok = true });
});

// Preview: resolve the template with operator-supplied test values EXACTLY as a tablet would see
// it (tags substituted, conditions applied, API checkboxes injected), without touching any tablet
// and without storing anything. If a document is posted, the unsaved editor state is previewed.
admin.MapPost("/document/preview", (PreviewDto? dto) =>
{
    var badField = FieldSchema.Validate(dto?.Fields);
    if (badField is not null) return Results.BadRequest(new { error = badField });
    var doc = dto?.Document ?? storage.GetDocument();
    DocumentTemplating.Sanitize(doc);
    var badDate = DocumentTemplating.ValidateAgeFields(doc, dto?.Fields);
    if (badDate is not null) return Results.BadRequest(new { error = badDate });

    // Разбор ровно такой же, как при показе на планшет, иначе предпросмотр обещал бы одно, а
    // клиент видел другое. Чекбокс с именем, которое есть в документе, задаёт состояние тому
    // пункту, который уже стоит на своём месте; остальные дописываются вниз страницы. Выбор в
    // двойных зависимых чекбоксах раньше приходил в запрос, но не применялся вовсе.
    var live = DocumentTemplating.LiveKeys(doc);
    var extra = new List<DocCheckbox>();
    var states = new Dictionary<string, bool>(StringComparer.OrdinalIgnoreCase);
    foreach (var cb in (dto?.Checkboxes ?? new List<DocCheckbox>()).Where(x => x is not null))
    {
        var key = DocumentTemplating.CleanKey(cb.Key);
        if (key.Length > 0 && live.Contains(key)) { states[key] = cb.Checked; continue; }
        extra.Add(cb);
    }
    var selections = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
    foreach (var g in (dto?.Groups ?? new List<GroupSelectionDto>()).Where(x => x is not null))
    {
        var key = DocumentTemplating.CleanKey(g.Key);
        if (key.Length > 0) selections[key] = DocumentTemplating.CleanKey(g.Selected);
    }

    var resolved = DocumentTemplating.Resolve(doc, dto?.Fields, extra, selections, states);
    return Results.Ok(new
    {
        document = resolved,
        placeholders = DocumentTemplating.Placeholders(doc),
        missingPlaceholders = DocumentTemplating.Missing(doc, dto?.Fields),
        pagesTotal = (doc.Pages ?? new List<DocPage>()).Count,
        pagesShown = resolved.Pages.Count
    });
});

// ---- Tablet control through the FreeKiosk REST API on each tablet ----
// Every call goes server -> tablet, so it only works while the tablets are reachable on the
// network. A failure here never affects signing: it is reported and nothing else.
// The key is write-only, like every other secret here: it goes out as "set or not set", never as
// the value itself, so an open admin screen does not put the fleet credential on display.
static object KioskControlView(KioskControlSettings s) => new
{
    s.Enabled, s.Port, s.TimeoutSec, s.AutoHeal, s.AutoHealAfterMinutes,
    s.BatteryWarnPercent, s.StorageWarnPercent,
    ApiKeySet = !string.IsNullOrEmpty(s.ApiKey)
};

admin.MapGet("/kiosk-control/settings", () => Results.Ok(KioskControlView(storage.GetKioskControlSettings())));

admin.MapPut("/kiosk-control/settings", (KioskControlSettingsDto? dto, KioskHealthCache healthCache) =>
{
    if (dto is null) return Results.BadRequest(new { error = "settings required" });
    var current = storage.GetKioskControlSettings();
    var settings = new KioskControlSettings
    {
        Enabled = dto.Enabled,
        Port = dto.Port,
        TimeoutSec = dto.TimeoutSec,
        AutoHeal = dto.AutoHeal,
        AutoHealAfterMinutes = dto.AutoHealAfterMinutes,
        BatteryWarnPercent = dto.BatteryWarnPercent,
        StorageWarnPercent = dto.StorageWarnPercent,
        // Blank means "leave the stored key alone"; clearing it is an explicit request.
        ApiKey = dto.ClearApiKey ? "" : string.IsNullOrEmpty(dto.ApiKey) ? current.ApiKey : dto.ApiKey
    };
    storage.SaveKioskControlSettings(settings);

    // Readings taken through the old address or key describe a state we can no longer verify, so
    // drop them. Changing only a threshold leaves the readings on the cards where they were.
    var saved = storage.GetKioskControlSettings();
    if (saved.Enabled != current.Enabled || saved.Port != current.Port || saved.ApiKey != current.ApiKey)
        healthCache.Clear();

    return Results.Ok(KioskControlView(saved));
});

// Where to reach this tablet (its own IP), when it differs from the address the server sees.
admin.MapPut("/devices/{id}/control-address", async (string id, ControlAddressDto? dto,
    KioskCoordinator coord, KioskHealthCache healthCache) =>
{
    var ip = dto?.Ip?.Trim();
    // An empty value clears the override and falls back to the address the tablet connected from.
    if (!string.IsNullOrEmpty(ip) && !FreeKioskClient.IsUsableTabletAddress(ip, out _))
        return Results.BadRequest(new { error = "Укажите IP-адрес планшета в локальной сети, например 192.168.1.50." });
    if (!storage.SetDeviceControlAddress(id, ip, dto?.Port)) return Results.NotFound();
    // The old reading came from the old address; it says nothing about the new one.
    healthCache.Forget(id);
    await coord.NotifyAdminsDevicesAsync();
    return Results.Ok(new { ok = true });
});

// The commands an operator can trigger from a device card. Mapped explicitly (no free-form path
// from the client) so a request can never be turned into an arbitrary call to the tablet.
var kioskCommands = new Dictionary<string, (string Path, string Title)>(StringComparer.OrdinalIgnoreCase)
{
    ["reboot"] = ("/api/reboot", "Перезагрузка планшета"),
    ["restart-app"] = ("/api/restart-ui", "Перезапуск приложения"),
    ["reload"] = ("/api/reload", "Обновление страницы"),
    ["clear-cache"] = ("/api/clearCache", "Очистка кэша"),
    ["screen-on"] = ("/api/screen/on", "Включение экрана"),
    ["screen-off"] = ("/api/screen/off", "Выключение экрана"),
    ["beep"] = ("/api/audio/beep", "Звуковой сигнал"),
    ["wake"] = ("/api/wake", "Пробуждение")
};

admin.MapPost("/devices/{id}/kiosk/{command}", async (string id, string command, FreeKioskClient kiosk, EventLogService logs) =>
{
    var dev = storage.GetDevice(id);
    if (dev is null) return Results.NotFound();
    if (!kioskCommands.TryGetValue(command, out var cmd))
        return Results.BadRequest(new { error = "Неизвестная команда." });

    var res = await kiosk.SendAsync(dev, cmd.Path);
    logs.Add(res.Ok ? "info" : "warn", "control",
        cmd.Title + (res.Ok ? " выполнена" : " не удалась: " + res.Error), null, dev.Id, dev.Name);
    return res.Ok
        ? Results.Ok(new { ok = true })
        : Results.Json(new { error = res.Error }, statusCode: StatusCodes.Status502BadGateway);
});

admin.MapPost("/devices/{id}/kiosk/brightness", async (string id, ValueDto? dto, FreeKioskClient kiosk) =>
{
    var dev = storage.GetDevice(id);
    if (dev is null) return Results.NotFound();
    var value = Math.Clamp(dto?.Value ?? 100, 0, 100);
    var res = await kiosk.SendAsync(dev, "/api/brightness", HttpMethod.Post, new { brightness = value, value });
    return res.Ok ? Results.Ok(new { ok = true, value })
                  : Results.Json(new { error = res.Error }, statusCode: StatusCodes.Status502BadGateway);
});

admin.MapPost("/devices/{id}/kiosk/volume", async (string id, ValueDto? dto, FreeKioskClient kiosk) =>
{
    var dev = storage.GetDevice(id);
    if (dev is null) return Results.NotFound();
    var value = Math.Clamp(dto?.Value ?? 50, 0, 100);
    var res = await kiosk.SendAsync(dev, "/api/volume", HttpMethod.Post, new { volume = value, value });
    return res.Ok ? Results.Ok(new { ok = true, value })
                  : Results.Json(new { error = res.Error }, statusCode: StatusCodes.Status502BadGateway);
});

admin.MapPost("/devices/{id}/kiosk/say", async (string id, TextDto? dto, FreeKioskClient kiosk) =>
{
    var dev = storage.GetDevice(id);
    if (dev is null) return Results.NotFound();
    var text = (dto?.Text ?? "").Trim();
    if (text.Length == 0 || text.Length > 500) return Results.BadRequest(new { error = "Текст обязателен (до 500 символов)." });
    var res = await kiosk.SendAsync(dev, "/api/tts", HttpMethod.Post, new { text, locale = "ru-RU" });
    return res.Ok ? Results.Ok(new { ok = true })
                  : Results.Json(new { error = res.Error }, statusCode: StatusCodes.Status502BadGateway);
});

admin.MapPost("/devices/{id}/kiosk/toast", async (string id, TextDto? dto, FreeKioskClient kiosk) =>
{
    var dev = storage.GetDevice(id);
    if (dev is null) return Results.NotFound();
    var text = (dto?.Text ?? "").Trim();
    if (text.Length == 0 || text.Length > 200) return Results.BadRequest(new { error = "Текст обязателен (до 200 символов)." });
    var res = await kiosk.SendAsync(dev, "/api/toast", HttpMethod.Post, new { text, message = text });
    return res.Ok ? Results.Ok(new { ok = true })
                  : Results.Json(new { error = res.Error }, statusCode: StatusCodes.Status502BadGateway);
});

// Live health snapshot straight from the tablet (also used to verify the address is right).
admin.MapGet("/devices/{id}/kiosk/health", async (string id, FreeKioskClient kiosk, KioskHealthCache healthCache) =>
{
    var dev = storage.GetDevice(id);
    if (dev is null) return Results.NotFound();
    var health = await kiosk.GetHealthAsync(dev);
    // This is the freshest reading there is, so the tablet card shows it too without waiting
    // for the next monitor pass.
    healthCache.Set(dev.Id, health);
    return Results.Ok(health);
});

// What the tablet is actually showing right now.
admin.MapGet("/devices/{id}/kiosk/screenshot", async (string id, FreeKioskClient kiosk) =>
{
    var dev = storage.GetDevice(id);
    if (dev is null) return Results.NotFound();
    var (bytes, contentType, error) = await kiosk.GetBytesAsync(dev, "/api/screenshot");
    return bytes is null
        ? Results.Json(new { error }, statusCode: StatusCodes.Status502BadGateway)
        : Results.File(bytes, contentType ?? "image/png");
});

// ---- Расписание управления планшетами ----
// Список действий отдаёт сервер, чтобы интерфейс и исполнитель не могли разойтись в именах.
admin.MapGet("/schedule/actions", () => Results.Ok(ScheduleActions.All.Select(a => new
{
    key = a.Key,
    title = a.Title,
    needsValue = a.NeedsValue,
    needsText = a.NeedsText,
    catchUp = a.CatchUp
})));

admin.MapGet("/schedule", () => Results.Ok(new
{
    rules = storage.GetScheduleRules(),
    // Часы сервера: оператор задаёт время по ним, и это должно быть видно, а не подразумеваться.
    serverTime = DateTime.Now.ToString("HH:mm"),
    serverZone = TimeZoneInfo.Local.StandardName
}));

admin.MapPut("/schedule", (List<ScheduleRule>? rules) => Results.Ok(new { rules = storage.SaveScheduleRules(rules) }));

// Запуск правила по требованию: проверить его, не дожидаясь назначенного времени.
admin.MapPost("/schedule/{id}/run", async (string id, ScheduleRunner runner, CancellationToken cancel) =>
{
    var rule = storage.GetScheduleRules().FirstOrDefault(r => r.Id == id);
    if (rule is null) return Results.NotFound();
    var result = await runner.RunNow(rule, cancel);
    return Results.Ok(new { ok = true, result });
});

// ---- Operator alerts ----
admin.MapGet("/alerts", (AlertService alerts) =>
    Results.Ok(new { unacknowledged = alerts.UnacknowledgedCount, alerts = alerts.List() }));

admin.MapPost("/alerts/ack", async (AlertService alerts, KioskCoordinator coord, AckDto? dto) =>
{
    if (string.IsNullOrWhiteSpace(dto?.Id)) alerts.AcknowledgeAll(); else alerts.Acknowledge(dto.Id!);
    await coord.NotifyAdminsAlertsAsync();
    return Results.Ok(new { ok = true });
});

admin.MapGet("/alerts/settings", () => Results.Ok(storage.GetAlertSettings()));

admin.MapPut("/alerts/settings", (AlertSettings? settings) =>
{
    if (settings is null) return Results.BadRequest(new { error = "settings required" });
    storage.SaveAlertSettings(settings);
    return Results.Ok(storage.GetAlertSettings());
});

// Raise a harmless test alert so the operator can check that notifications reach them.
admin.MapPost("/alerts/test", async (AlertService alerts, KioskCoordinator coord) =>
{
    // A fixed id: pressing the button repeatedly refreshes one test alert instead of piling up
    // entries that nothing ever clears.
    alerts.Raise("test:manual", "test", "warn",
        "Тестовое уведомление", "Проверка: уведомления доходят до оператора. Можно закрыть.", DateTime.UtcNow);
    await coord.NotifyAdminsAlertsAsync();
    return Results.Ok(new { ok = true });
});

admin.MapDelete("/alerts/{id}", async (string id, AlertService alerts, KioskCoordinator coord) =>
{
    var cleared = alerts.Clear(id);
    if (cleared) await coord.NotifyAdminsAlertsAsync();
    return cleared ? Results.Ok(new { ok = true }) : Results.NotFound();
});

// ---- Operational log ----
admin.MapGet("/logs", (EventLogService logs, string? level, string? q, int? limit) =>
    Results.Ok(new { total = logs.Count, entries = logs.List(level, q, limit ?? 300) }));

admin.MapDelete("/logs", (EventLogService logs) => { logs.Clear(); return Results.Ok(new { ok = true }); });

// ---- Barcode / QR scanning ----
// Scanning always targets exactly ONE tablet (the operator picks it), like the document.
admin.MapPost("/scan/start", async (TargetDto? dto, KioskCoordinator coord) =>
{
    var deviceId = DeviceFromTarget(dto?.Target);
    if (deviceId is null) return Results.BadRequest(new { error = "Выберите планшет для сканирования." });
    // Scanning is a live command: nothing is stored and nothing is replayed on reconnect, so a
    // tablet that is not connected would simply never hear it. Saying so beats a silent success.
    if (!tracker.IsOnline(deviceId))
    {
        var dev = storage.GetDevice(deviceId);
        return Results.Json(new
        {
            error = "Планшет «" + (dev?.Name ?? deviceId) + "» сейчас не на связи, команда сканирования до него не дойдёт. " +
                    "Проверьте, что планшет включён, есть Wi-Fi и открыта страница киоска."
        }, statusCode: StatusCodes.Status409Conflict);
    }
    await coord.StartScanAsync(deviceId);
    return Results.Ok(new { ok = true, deviceId });
});

admin.MapPost("/scan/stop", async (TargetDto? dto, KioskCoordinator coord) =>
{
    var deviceId = DeviceFromTarget(dto?.Target);
    if (deviceId is null) return Results.BadRequest(new { error = "Выберите планшет." });
    await coord.StopScanAsync(deviceId);
    return Results.Ok(new { ok = true, deviceId });
});

admin.MapGet("/scans", (int? limit) => Results.Ok(storage.GetScans(Math.Clamp(limit ?? 200, 1, 1000))));
admin.MapDelete("/scans/{id}", (string id) =>
    storage.DeleteScan(id) ? Results.Ok(new { ok = true }) : Results.NotFound());

// ---- Document backup: import a template file back ----
// Файл экспорта собирает сама админка: в него должны попадать и несохранённые правки редактора,
// поэтому серверной выгрузки нет. Импорт проверяет заголовок файла, чтобы не подсунули чужой JSON.
admin.MapPost("/document/import", (DocumentBackup? backup) =>
{
    var doc = backup?.Document;
    if (backup is null || doc is null || !string.Equals(backup.Kind, DocumentBackup.KindValue, StringComparison.Ordinal))
        return Results.BadRequest(new { error = "Это не файл шаблона документа HELIX SignTablet." });
    if (backup.Version is < 1 or > 1)
        return Results.BadRequest(new { error = "Версия файла шаблона не поддерживается." });
    // Validate AFTER sanitising: a file whose pages are all unusable would otherwise pass the check
    // and then replace the working template with an empty one.
    DocumentTemplating.Sanitize(doc);
    if (doc.Pages.Count == 0)
        return Results.BadRequest(new { error = "В файле нет ни одной пригодной страницы документа." });
    storage.SaveDocument(doc);
    return Results.Ok(new { ok = true, pages = doc.Pages.Count });
});

// A document is ALWAYS shown on exactly one tablet (never all/group), so the signer's
// personal data can only ever reach that one device.
admin.MapPost("/show-document", async (ShowDocumentDto dto, KioskCoordinator coord) =>
{
    var deviceId = DeviceFromTarget(dto?.Target);
    if (deviceId is null)
        return Results.BadRequest(new { error = "Документ показывается только на один планшет. Выберите планшет." });
    var badField = FieldSchema.Validate(dto?.Fields);
    if (badField is not null) return Results.BadRequest(new { error = badField });
    var badDate = DocumentTemplating.ValidateAgeFields(storage.GetDocument(), dto?.Fields);
    if (badDate is not null) return Results.BadRequest(new { error = badDate });
    await coord.ShowDocumentAsync(deviceId, dto?.Fields, dto?.Checkboxes, dto?.Groups);
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
// Newest first, bounded: after a year of use the archive holds tens of thousands of records and
// returning all of them would stall every other storage operation.
admin.MapGet("/signatures", (int? limit) =>
    Results.Ok(storage.ListSignatures(Math.Clamp(limit ?? 200, 1, 1000)).Select(r => new
    {
        r.Id, r.CreatedUtc, r.DocumentTitle, r.DeviceId, r.DeviceName, r.WorkstationName,
        checkedCount = r.Items.Count(i => i is { Checked: true }), totalCount = r.Items.Count
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

// The external API is rate limited too: without it a flood of requests (even ones with a bad key)
// would contend for the same storage lock that signing and tablet registration need.
var ext = app.MapGroup("/api/ext").RequireRateLimiting("ext").AddEndpointFilter(async (ctx, next) =>
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
    var badField = FieldSchema.Validate(dto?.Fields);
    if (badField is not null) return Results.BadRequest(new { error = badField });
    var badDate = DocumentTemplating.ValidateAgeFields(storage.GetDocument(), dto?.Fields);
    if (badDate is not null) return Results.BadRequest(new { error = badDate });
    var (deviceId, status, error) = ResolveExtDeviceId(dto?.DeviceId, dto?.WorkstationExternalId);
    if (deviceId is null)
        return Results.Json(new { error }, statusCode: status);
    await coord.ShowDocumentAsync(deviceId, dto?.Fields, dto?.Checkboxes, dto?.Groups);
    var missing = DocumentTemplating.Missing(storage.GetDocument(), dto?.Fields);
    return Results.Ok(new { ok = true, deviceId, missingPlaceholders = missing });
});

// Ask a tablet to scan a barcode / QR code and WAIT for the result, returning the code in the
// response. The tablet opens its camera, the client shows the code, and it comes back here.
// timeoutSec (default 60, max 300) bounds the wait so the caller is never blocked indefinitely.
ext.MapPost("/scan-request", async (ExtScanRequestDto dto, KioskCoordinator coord, ScanBroker broker, HttpContext ctx) =>
{
    var (deviceId, status, error) = ResolveExtDeviceId(dto?.DeviceId, dto?.WorkstationExternalId);
    if (deviceId is null) return Results.Json(new { error }, statusCode: status);

    // Команда сканирования живёт только в момент отправки: планшет не на связи её просто не
    // услышит. Без этой проверки вызывающая система молча ждала до таймаута (до пяти минут) и
    // получала «код не отсканирован» вместо понятной причины.
    if (!tracker.IsOnline(deviceId))
    {
        var offline = storage.GetDevice(deviceId);
        return Results.Json(new
        {
            error = "Планшет «" + (offline?.Name ?? deviceId) + "» сейчас не на связи, команда сканирования до него не дойдёт.",
            deviceId
        }, statusCode: StatusCodes.Status409Conflict);
    }

    var timeout = TimeSpan.FromSeconds(Math.Clamp(dto?.TimeoutSec ?? 60, 5, 300));
    using var cts = CancellationTokenSource.CreateLinkedTokenSource(ctx.RequestAborted);
    cts.CancelAfter(timeout);

    // Register the waiter BEFORE telling the tablet to scan, so a very fast scan cannot be missed.
    var wait = broker.Wait(deviceId, cts.Token);
    await coord.StartScanAsync(deviceId);

    try
    {
        var rec = await wait;
        return Results.Ok(new { ok = true, deviceId, code = rec.Code, format = rec.Format, scanId = rec.Id, createdUtc = rec.CreatedUtc });
    }
    catch (OperationCanceledException)
    {
        // The client went away: do not touch the tablet and do not write to a dead connection.
        if (ctx.RequestAborted.IsCancellationRequested) return Results.Empty;

        // Only close the camera if nobody else is waiting for this tablet. A newer request may have
        // superseded this one, and stopping the camera would cancel THAT scan mid-air.
        if (!broker.IsWaiting(deviceId)) await coord.StopScanAsync(deviceId);
        return Results.Json(new { ok = false, deviceId, error = "timeout: код не был отсканирован" },
            statusCode: StatusCodes.Status408RequestTimeout);
    }
});

// Cancel a scan in progress on a tablet.
ext.MapPost("/scan-cancel", async (ExtShowDocumentDto dto, KioskCoordinator coord) =>
{
    var (deviceId, status, error) = ResolveExtDeviceId(dto?.DeviceId, dto?.WorkstationExternalId);
    if (deviceId is null) return Results.Json(new { error }, statusCode: status);
    await coord.StopScanAsync(deviceId);
    return Results.Ok(new { ok = true, deviceId });
});

// Recent scans (newest first), so an integrator can poll instead of waiting.
ext.MapGet("/scans", (int? limit) =>
    Results.Ok(storage.GetScans(Math.Clamp(limit ?? 50, 1, 500))));

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
