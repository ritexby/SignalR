using Microsoft.AspNetCore.DataProtection;
using System.Text.Json;
using System.Threading.RateLimiting;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.HttpOverrides;
using Microsoft.AspNetCore.SignalR;
using Microsoft.Extensions.FileProviders;
using SignatureKiosk.Auth;
using SignatureKiosk.Hubs;
using SignatureKiosk.Models;
using SignatureKiosk.Services;

var builder = WebApplication.CreateBuilder(args);

// Учёт живых соединений хаба. Нужен, чтобы соединение отозванного планшета можно было не только
// перестать обслуживать, но и оборвать: SignalR сам такой возможности снаружи не даёт.
builder.Services.AddSingleton<KioskConnections>();
builder.Services.AddSignalR(o =>
{
    o.AddFilter<KioskConnections>();
    // По умолчанию сообщение больше 32 КБ обрывает соединение целиком. Планшет шлёт наблюдателю
    // только уменьшенные копии подписи, но полагаться на одну лишь бережность клиента нельзя:
    // разрыв связи посреди подписания возвращает клиента на первую страницу и заставляет
    // проходить документ заново. Запас взят с многократным перекрытием разумного сообщения.
    o.MaximumReceiveMessageSize = 256 * 1024;
}).AddJsonProtocol(options =>
{
    options.PayloadSerializerOptions.PropertyNamingPolicy = JsonNamingPolicy.CamelCase;
});
// An integration writes new { urine = true } and sends a real JSON boolean. Without this the whole
// request is rejected before any handler runs, the document never appears, and the caller has
// nothing to go on. Values arrive as strings either way: that is what a template substitutes.
builder.Services.ConfigureHttpJsonOptions(o =>
{
    o.SerializerOptions.Converters.Add(new LenientStringDictionaryConverter());
    // И то же самое для отдельного строкового поля. Коды рабочих мест у владельца выглядят как
    // числа (1232, 3244, 54545), интегратор кладёт их в JSON числом, и до этой уступки весь
    // запрос отвергался платформой ещё до обработчика: 400 с пустым телом, без Content-Type и
    // без следа в журналах. Разобраться в таком ответе снаружи нечем.
    o.SerializerOptions.Converters.Add(new LenientStringConverter());
});
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
    // Отказ с пустым телом это единственный ответ во всём API без объяснения: в журнале
    // интегратора он выглядит как «пустой ответ от киоска», и показать оператору нечего.
    options.OnRejected = async (ctx, cancel) =>
    {
        ctx.HttpContext.Response.StatusCode = StatusCodes.Status429TooManyRequests;
        ctx.HttpContext.Response.ContentType = "application/json; charset=utf-8";
        var через = ctx.Lease.TryGetMetadata(System.Threading.RateLimiting.MetadataName.RetryAfter, out var span)
            ? (int)Math.Ceiling(span.TotalSeconds) : 60;
        ctx.HttpContext.Response.Headers.RetryAfter = через.ToString();
        await ctx.HttpContext.Response.WriteAsJsonAsync(new
        {
            error = "Слишком много запросов с этого адреса. Повторите через " + через + " с.",
            retryAfterSec = через
        }, cancel);
    };

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

    // Подписи, поставленные внутри страниц, приходят тем же запросом. Каждая проверяется так же,
    // как итоговая: чужие байты не должны попасть в запись под видом подписи.
    var extraSignatures = new List<(string Key, string Label, byte[] Png)>();
    foreach (var extra in (sub.Signatures ?? new List<SubmittedSignature>()).Where(x => x is not null).Take(40))
    {
        if ((extra.Image?.Length ?? 0) > MaxSignatureDataUrlChars)
            return Results.BadRequest(new { error = "signature image too large" });
        var bytes = DecodeDataUrlPng(extra.Image ?? "");
        if (bytes is null || !IsPng(bytes) || bytes.Length > MaxSignaturePngBytes)
            return Results.BadRequest(new { error = "invalid signature image" });
        extraSignatures.Add((DocumentTemplating.CleanKey(extra.Key), extra.Label ?? "", bytes));
    }
    if ((sub.Scans?.Count ?? 0) > 40 || (sub.Scans ?? new List<SubmittedScan>())
            .Any(x => x is null || (x.Code?.Length ?? 0) > StorageService.MaxScanCodeLength))
        return Results.BadRequest(new { error = "invalid scans" });
    // Выбор в группах и вписанное клиентом проверяются так же, как всё остальное. Раньше эти два
    // списка уходили в запись как есть: null внутри ронял чтение списка подписей, а длина не была
    // ограничена ничем, кроме размера тела запроса, и в meta.json и в PDF попадало что угодно.
    if ((sub.Groups?.Count ?? 0) > 200 || (sub.Groups ?? new List<SubmittedGroup>())
            .Any(x => x is null || (x.Title?.Length ?? 0) > 2000 || (x.Selected?.Length ?? 0) > 2000))
        return Results.BadRequest(new { error = "invalid groups" });
    if ((sub.Inputs?.Count ?? 0) > 200 || (sub.Inputs ?? new List<SubmittedInput>())
            .Any(x => x is null || (x.Label?.Length ?? 0) > 2000 || (x.Value?.Length ?? 0) > 2000))
        return Results.BadRequest(new { error = "invalid inputs" });

    var deviceId = ctx.User.FindFirst("device_id")?.Value;
    if (deviceId is null) return Results.BadRequest(new { error = "device required" });

    var submissionId = sub.SubmissionId?.Trim();
    var cleared = false;
    // Имя показа, который мы проверяли. Нужно, чтобы в конце стереть именно его, а не тот, что
    // успел прийти на планшет, пока шла проверка.
    string? нашПоказ = null;
    try
    {
        var state = storage.ResolveState(deviceId);
        нашПоказ = state.SessionId;
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
            {
                // Сессию не трогаем: на планшете сейчас другой человек и другой документ, и
                // стереть его из-за чужого запоздавшего повтора значит сорвать ему подписание.
                // Без этого флага общий finally доходил до ClearSession и делал ровно это.
                cleared = true;
                return Results.Json(new { error = "stale submission: another document is open" },
                    statusCode: StatusCodes.Status409Conflict);
            }
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
        // Ключ для сверки пункта: имя, а у безымянного его надпись. Один и тот же способ и при
        // снятии показанного, и при сборке записи, иначе сверка развалится на безымянных.
        static string ПометкаПункта(string? key, string? label)
        {
            var k = DocumentTemplating.CleanKey(key);
            return k.Length > 0 ? "k:" + k.ToLowerInvariant() : "l:" + (label ?? "");
        }
        var показано = new Dictionary<string, bool>(StringComparer.Ordinal);
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

        // Запись и PDF собираются из снимка сессии: документа ровно в том виде, в каком его
        // получил планшет. Пересборка из текущего шаблона здесь была бы ошибкой: шаблон могли
        // править, пока человек подписывал, и в запись легло бы не то, что он видел и подписал.
        DocumentConfig resolvedDoc;
        Dictionary<string, string>? recordFields;
        string? кодДокумента = null, названиеДокумента = null;
        // Планшет присылает имя показа, под которым он получил документ. Разошлось значит, что на
        // планшет успели послать другой документ, пока этот клиент подписывал: его отметки легли
        // бы в снимок следующего человека. Отказываем, сессию нового клиента не трогая.
        var сВопросом = (sub.SessionId ?? "").Trim();
        if (сВопросом.Length > 0 && !string.Equals(сВопросом, state.SessionId ?? "", StringComparison.Ordinal))
        {
            cleared = true;
            return Results.Json(new
            {
                error = "На планшет уже отправлен другой документ, эта подпись к нему не относится. " +
                        "Отправьте документ на планшет заново."
            }, statusCode: StatusCodes.Status409Conflict);
        }

        var session = string.IsNullOrEmpty(state.SessionId) ? null : storage.GetDocSession(deviceId);
        if (session is not null && session.SessionId == state.SessionId)
        {
            resolvedDoc = session.Document;
            // С чем пункты были показаны клиенту, снимается до того, как в снимок лягут его
            // ответы: дальше ApplyMarks перепишет Checked, и «что человек изменил» будет уже
            // не из чего посчитать.
            foreach (var стр in resolvedDoc.Pages ?? new List<DocPage>())
                foreach (var c in (стр?.Checkboxes ?? new List<DocCheckbox>()).Where(x => x is not null))
                    показано[ПометкаПункта(c.Key, c.Label)] = c.Checked;
            DocumentTemplating.ApplyMarks(resolvedDoc, finalStates, finalGroups);
            recordFields = session.RecordFields;
            кодДокумента = session.DocumentCode;
            названиеДокумента = session.DocumentName;
        }
        else
        {
            // Снимка нет или он не от этой сессии. Прежде тут собиралась запись из документа по
            // умолчанию, а он может быть совсем другим: получалась подпись под текстом, которого
            // человек не видел, и по ней ничего не докажешь. Состояние планшета имени документа
            // не хранит, восстановить нечего, поэтому отказ, а не догадка. Сессию не трогаем:
            // оператор пошлёт документ заново, и клиент подпишет то же самое.
            cleared = true;
            app.Logger.LogWarning("Sign refused: no session snapshot for {Device} (session {Session})",
                deviceId, state.SessionId ?? "-");
            return Results.Json(new { error = "Сессия подписания устарела: отправьте документ на планшет заново." },
                statusCode: StatusCodes.Status409Conflict);
        }
        // Вписанные клиентом значения нужны здесь же: на планшете условие «телефон не пусто»
        // открывает блок прямо во время набора, и в PDF этот блок обязан быть. Раньше значения
        // собирались ниже, уже после применения условий, и блок из бумаги пропадал.
        var finalInputs = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var inp in sub.Inputs ?? new List<SubmittedInput>())
        {
            var k = DocumentTemplating.CleanKey(inp?.Key);
            if (k.Length > 0) finalInputs[k] = (inp!.Value ?? "").Trim();
        }
        // Блоки, скрытые условием, клиент не видел: их не должно быть и в PDF.
        // Имена полей подписи и сканирования тоже участвуют в условиях: планшет их так считает,
        // и сервер обязан считать так же, иначе в записи окажется не то, что клиент видел.
        var подписаны = extraSignatures.Select(x => x.Key).Where(k => !string.IsNullOrWhiteSpace(k)).ToList();
        var коды = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var sc in sub.Scans ?? new List<SubmittedScan>())
        {
            var k = DocumentTemplating.CleanKey(sc?.Key);
            if (k.Length > 0) коды[k] = sc!.Code ?? "";
        }
        DocumentTemplating.ApplyLiveConditions(resolvedDoc, finalStates, finalGroups, finalInputs, подписаны, коды);
        if (recordFields is { Count: 0 }) recordFields = null;

        // Откуда взялся каждый пункт, знает снимок сессии, а не планшет: планшет присылает только
        // имя, надпись и отметку, и верить ему в таком вопросе нельзя. Через год по записи должно
        // быть видно, что оператор этот пункт не писал: его прислали вместе с заказом.
        {
            var изДокумента = new List<DocCheckbox>();
            foreach (var стр in resolvedDoc.Pages ?? new List<DocPage>())
                изДокумента.AddRange((стр?.Checkboxes ?? new List<DocCheckbox>()).Where(c => c is not null));
            foreach (var it in sub.Items ?? new List<SubmittedItem>())
            {
                if (it is null) continue;
                var k = DocumentTemplating.CleanKey(it.Key);
                var свой = k.Length > 0
                    ? изДокумента.FirstOrDefault(c => string.Equals(DocumentTemplating.CleanKey(c.Key), k, StringComparison.OrdinalIgnoreCase))
                    : изДокумента.FirstOrDefault(c => string.Equals(c.Label ?? "", it.Label ?? "", StringComparison.Ordinal));
                if (свой is null) continue;
                it.Api = свой.Api;
                it.ApiText = свой.ApiText;
                it.LabelBefore = свой.LabelBefore;
                it.CheckedFromApi = свой.CheckedFromApi;
                // Клиент сам изменил то, что ему показали. Заранее отмеченный заказом пункт,
                // с которого человек снял отметку, это самое сильное доказательство: он видел
                // пункт и решил про него. Обратное тоже важно: пункт, пришедший отмеченным и
                // так и оставшийся, согласием по сути не является, и это обязано быть видно.
                it.ChangedBySigner = показано.TryGetValue(ПометкаПункта(it.Key, свой.Label), out var было)
                    && было != it.Checked;
            }
        }

        // Информационный документ не подписывают: на планшете экрана подписи нет вовсе, и запрос
        // сюда означает либо сломанную страницу, либо чужой запрос. Записи о согласии из него
        // быть не должно: согласия никто не давал.
        if (DocumentTemplating.IsInfo(resolvedDoc))
        {
            // Сессию не трогаем, как и при всех прочих отказах: документ показан клиенту, он его
            // читает, и стирать показанное из-за чужого кривого запроса нельзя. Раньше эта ветка
            // одна из всех флаг не выставляла, и любой такой запрос гасил чужой документ.
            cleared = true;
            return Results.BadRequest(new { error = "Этот документ информационный: его не подписывают." });
        }

        // Обязательное должно быть заполнено. Это проверяет и страница планшета, но полагаться
        // на одну её нельзя: сломанная или подделанная страница прислала бы запись о согласии
        // без самого согласия, и запись выглядела бы подлинной. Отказ сессию не трогает: клиент
        // ещё подписывает, и стереть его документ из-за чужого кривого запроса нельзя.
        var missing = DocumentTemplating.MissingRequired(resolvedDoc,
            extraSignatures.Select(x => x.Key).ToList(),
            (sub.Scans ?? new List<SubmittedScan>()).Select(x => DocumentTemplating.CleanKey(x.Key)).ToList());
        if (missing is not null)
        {
            cleared = true;
            return Results.BadRequest(new { error = "Не заполнено обязательное: " + missing });
        }

        // Правила отметок и полей ввода: то же самое, что проверяет страница планшета. Значения
        // проверяются по снимку, а не по текущему шаблону: поле могли добавить только что.
        var broken = DocumentTemplating.BrokenRuleOrInput(resolvedDoc, finalStates, finalInputs);
        if (broken is not null)
        {
            cleared = true;
            return Results.BadRequest(new { error = broken });
        }

        var rec = storage.AddSignature(sub, resolvedDoc, device, ws, png, recordFields, extraSignatures,
            кодДокумента, названиеДокумента);

        // The record is safely stored: from here the signer's data may leave the tablet.
        ClearSession();

        try { pdf.Generate(rec, resolvedDoc, png, file => storage.GetExtraSignatureBytes(rec.Id, file)); }
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
        // Стираем ровно тот показ, который проверяли. Между чтением снимка и этой строкой на
        // планшет мог прийти следующий документ: без сверки мы стёрли бы сессию нового клиента,
        // у которого документ уже на экране, и он получил бы на подписи «на этом планшете ничего
        // не подписывают».
        try { coord.ClearSignerSession(deviceId, нашПоказ); }
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
    // Состояние читается один раз на весь список. Раньше оно читалось на каждый планшет
    // отдельно: при двухстах планшетах один запрос списка означал двести чтений и разборов
    // одного и того же файла, а список запрашивается на каждое событие сети.
    var states = storage.GetStates();
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
                // Размер экрана планшета, каким его сообщила его собственная страница. Отдаётся
                // и для отключённого планшета: окно наблюдения открывается по этим числам ещё до
                // первого кадра, а карточка рассказывает, какое железо стоит на рабочем месте.
                // Пусто у планшета на старой странице, которая размер не сообщает; пусто это
                // «неизвестно», и его нельзя путать с нулём.
                d.ScreenWidth,
                d.ScreenHeight,
                d.ScreenPixelRatio,
                // Что сейчас на экране: реклама или документ. Оператору это нужно, чтобы знать,
                // за чем есть смысл смотреть, особенно когда документ отправила внешняя система,
                // а не он сам.
                screen = states.Devices.TryGetValue(d.Id, out var st) ? st.Mode : states.Default.Mode,
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
    // Рабочее место трогается, только если поле прислали. Раньше оно трогалось всегда, и запрос
    // «смени имя», в котором места нет вовсе, снимал планшет с места. Замер до починки: планшет
    // на месте «1232», тело {"name":"Ресепшн 2"}, ответ 200 {"ok":true}, после чего место стало
    // null, а показ документа по workstationExternalId «1232» ответил 404 «no tablet is assigned
    // to this workstation». Имя и группы по этому правилу жили с самого начала, место было
    // единственным исключением.
    var поле = dto?.WorkstationId ?? default;
    var местоПрислали = поле.ValueKind != System.Text.Json.JsonValueKind.Undefined;
    // Строка это номер места, пустая строка и присланный null это осознанное «снять с места».
    var местоИзТела = поле.ValueKind == System.Text.Json.JsonValueKind.String ? поле.GetString() : null;
    if (!storage.UpdateDevice(id, dto?.Name, dto?.GroupIds, местоИзТела, touchWorkstation: местоПрислали,
                              out var местоСменилось))
        return Results.NotFound();
    if (местоСменилось) await УвестиСМеста(coord, id);
    await coord.NotifyAdminsDevicesAsync();
    return Results.Ok(new { ok = true });
});

admin.MapPost("/devices/{id}/revoke", async (string id, KioskCoordinator coord) =>
{
    if (!storage.SetDeviceStatus(id, "revoked")) return Results.NotFound();
    // Отзыв это не пометка в списке, а «убрать всё с этого экрана прямо сейчас»: данные
    // подписанта стираются, планшет уходит на экран активации, соединение рвётся.
    await coord.RevokeDeviceAsync(id);
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
    if (storage.GetDevice(id) is null) return Results.NotFound();
    // Удаление это тот же отзыв, только без записи в списке: экран надо очистить и связь
    // разорвать ДО удаления, пока планшет ещё числится в системе. Раньше запись просто исчезала,
    // а на планшете оставался висеть документ с данными клиента: погасить его было нечем, потому
    // что все команды отбирают адресата по списку планшетов, а в нём этого планшета уже нет.
    await coord.RevokeDeviceAsync(id);
    if (!storage.DeleteDevice(id)) return Results.NotFound();
    await coord.NotifyAdminsDevicesAsync();
    return Results.Ok(new { ok = true });
});

admin.MapPost("/devices/{id}/identify", async (string id, KioskCoordinator coord) =>
{
    // Отозванный планшет не мигает номером: он выведен из системы, и найти его в зале по нашей
    // команде уже нельзя. Молчаливое «ок» тут выглядело бы как «планшет жив и слушается».
    var карточка = storage.GetDevice(id);
    if (карточка is null) return Results.NotFound();
    if (карточка.Status == "revoked")
        return Results.Json(new
        {
            error = "Планшет «" + карточка.Name + "» отозван: он больше не подчиняется серверу и номер на нём не появится."
        }, statusCode: StatusCodes.Status409Conflict);
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
// Номер версии страницы планшета. Живёт он ровно в одном месте: в самой странице, которую этот
// сервер и отдаёт планшетам. Админка сверяет с ним то, что сообщают планшеты по связи, и раньше
// держала рядом свою копию номера. Копии разошлись на первом же выпуске, и админка написала
// «старая версия страницы» на карточке каждого исправного планшета в парке.
//
// Файл читается один раз за жизнь службы: на работающей службе он не меняется, а меняется он
// только при выкате, после которого служба перезапускается. Не прочитали, значит версия
// неизвестна, и тогда админка не обвиняет никого: недоказанное обвинение хуже молчания, после
// него идут снимать со стены исправный планшет.
string? версияСтраницы = null;
bool версияПрочитана = false;
string? ВерсияСтраницыПланшета()
{
    if (версияПрочитана) return версияСтраницы;
    версияПрочитана = true;
    try
    {
        var корень = app.Environment.WebRootPath;
        if (string.IsNullOrEmpty(корень)) return null;
        var путь = Path.Combine(корень, "kiosk.js");
        if (!File.Exists(путь)) return null;
        var найдено = System.Text.RegularExpressions.Regex.Match(
            File.ReadAllText(путь), "APP_VERSION\\s*=\\s*\"([^\"]*)\"");
        if (найдено.Success && найдено.Groups[1].Value.Length > 0) версияСтраницы = найдено.Groups[1].Value;
    }
    catch
    {
        // Версия осталась неизвестной. Это не повод валить запрос: без неё админка просто
        // перестаёт судить о версиях, а всё остальное работает.
    }
    return версияСтраницы;
}

admin.MapGet("/page-version", () => Results.Ok(new { version = ВерсияСтраницыПланшета() }));

admin.MapGet("/groups", () => Results.Ok(storage.GetGroups()));
admin.MapPost("/groups", (GroupDto dto) => Results.Ok(storage.AddGroup(dto?.Name ?? "")));
admin.MapPut("/groups/{id}", (string id, GroupDto dto) =>
    storage.RenameGroup(id, dto?.Name ?? "") ? Results.Ok(new { ok = true }) : Results.NotFound());
admin.MapDelete("/groups/{id}", (string id, KioskCoordinator coord) =>
{
    if (!storage.DeleteGroup(id)) return Results.NotFound();
    // Набор мог решать, где показывать картинки рекламы. Ссылки на него из картинок вычищены,
    // значит состав рекламы у планшетов изменился прямо сейчас: они держат выданный им список и
    // сами о наборах не знают, поэтому список пересобирается и уходит заново.
    _ = coord.RefreshSlidesAsync();
    return Results.Ok(new { ok = true });
});

// ---- Workstations ----
admin.MapGet("/workstations", () => Results.Ok(storage.GetWorkstations()));
admin.MapPost("/workstations", (WorkstationDto dto) =>
{
    var (место, ошибка) = storage.AddWorkstation(dto?.ExternalId, dto?.Name, dto?.Location);
    return ошибка is not null ? Results.BadRequest(new { error = ошибка }) : Results.Ok(место);
});
admin.MapPut("/workstations/{id}", (string id, WorkstationDto dto) =>
    storage.UpdateWorkstation(id, dto?.ExternalId, dto?.Name, dto?.Location, out var ошибка) switch
    {
        StorageService.РезультатПравкиМеста.Готово => Results.Ok(new { ok = true }),
        StorageService.РезультатПравкиМеста.НетМеста => Results.NotFound(),
        _ => Results.BadRequest(new { error = ошибка })
    });
admin.MapDelete("/workstations/{id}", async (string id, KioskCoordinator coord) =>
{
    var снятые = storage.DeleteWorkstation(id);
    if (снятые is null) return Results.NotFound();
    // Планшеты, стоявшие на удалённом месте, уводятся на рекламу: на их экранах мог остаться
    // документ с данными клиента, а места, для которого он заказан, больше нет.
    await УвестиСМеста(coord, снятые.ToArray());
    await coord.NotifyAdminsDevicesAsync();
    return Results.Ok(new { ok = true });
});

// ---- API keys (external integration) ----
admin.MapGet("/apikeys", () =>
    Results.Ok(storage.GetApiKeys().Select(k => new { k.Id, k.Label, k.CreatedUtc, k.Disabled })));
admin.MapPost("/apikeys", (ApiKeyDto dto) =>
{
    var (key, plaintext) = storage.CreateApiKey(dto?.Label);
    return Results.Ok(new { key.Id, key.Label, key = plaintext }); // plaintext returned once
});
// Выключить ключ, не удаляя. Удаление необратимо: чтобы перекрыть доступ интеграции на время
// разбирательства, ключ приходилось стирать, а потом заново настраивать чужую систему, из-за
// чего доступ чаще оставляли включённым. Выключенный ключ лежит в списке и доступа не даёт.
admin.MapPost("/apikeys/{id}/disable", (string id) =>
    storage.SetApiKeyDisabled(id, true) ? Results.Ok(new { ok = true, disabled = true }) : Results.NotFound());
admin.MapPost("/apikeys/{id}/enable", (string id) =>
    storage.SetApiKeyDisabled(id, false) ? Results.Ok(new { ok = true, disabled = false }) : Results.NotFound());
admin.MapDelete("/apikeys/{id}", (string id) =>
    storage.DeleteApiKey(id) ? Results.Ok(new { ok = true }) : Results.NotFound());

// ---- Images ----
// Предел размера одной картинки рекламы. Реклама уезжает на планшеты целиком и хранится на
// сервере, поэтому снимок с телефона на двадцать мегабайт здесь не место.
const long MaxImageBytes = 8L * 1024 * 1024;

admin.MapGet("/images", () =>
{
    var today = DateTime.Now.Date;
    return Results.Ok(storage.GetImages().Select(i => new
    {
        i.Id, i.OriginalName, i.UploadedUtc, url = "/media/" + i.FileName,
        i.ShowFrom, i.ShowTo,
        // Где показывать и где не показывать. Пустые списки означают «везде».
        i.GroupIds, i.ExceptGroupIds,
        // Показывается ли она сегодня. Считает сервер: у него и часы, и правило, а оператор
        // иначе гадал бы, попадает ли сегодняшний день в заданный срок.
        showsToday = KioskCoordinator.ImageShowsToday(i, today)
    }));
});

// Сроки показа картинки: с какого и по какой день она участвует в рекламе. Пустая дата снимает
// ограничение с этой стороны.
admin.MapPut("/images/{id}/dates", (string id, ImageDatesDto? dto, KioskCoordinator coord) =>
{
    var from = (dto?.ShowFrom ?? "").Trim();
    var to = (dto?.ShowTo ?? "").Trim();
    if (from.Length > 0 && DocumentTemplating.ParseDate(from) is null)
        return Results.BadRequest(new { error = "Дата начала показа не разобрана. Подойдёт 2026-08-21 или 21.08.2026." });
    if (to.Length > 0 && DocumentTemplating.ParseDate(to) is null)
        return Results.BadRequest(new { error = "Дата окончания показа не разобрана. Подойдёт 2026-08-21 или 21.08.2026." });
    var f = DocumentTemplating.ParseDate(from);
    var t = DocumentTemplating.ParseDate(to);
    // Срок наоборот это всегда ошибка ввода, а не хитрое правило: такая картинка не покажется
    // никогда, и молчать об этом нельзя.
    if (f is not null && t is not null && t < f)
        return Results.BadRequest(new { error = "Дата окончания раньше даты начала: такая картинка не покажется никогда." });
    if (!storage.SetImageDates(id, f?.ToString("yyyy-MM-dd"), t?.ToString("yyyy-MM-dd")))
        return Results.NotFound(new { error = "Картинка не найдена." });
    // Состав рекламы изменился прямо сейчас: планшеты держат выданный им список и сами о сроках
    // не знают, поэтому список пересобирается и уходит заново.
    _ = coord.RefreshSlidesAsync();
    return Results.Ok(new { ok = true, showFrom = f?.ToString("yyyy-MM-dd"), showTo = t?.ToString("yyyy-MM-dd") });
});

// Где показывать картинку: в каких группах планшетов и в каких не показывать. Пустые списки
// означают «везде», как было до появления этой настройки.
admin.MapPut("/images/{id}/groups", (string id, ImageGroupsDto? dto, KioskCoordinator coord) =>
{
    var только = dto?.GroupIds ?? new List<string>();
    var кроме = dto?.ExceptGroupIds ?? new List<string>();
    // Группа и в «показывать», и в «кроме» это противоречие в самой настройке: разрешение и
    // запрет на одно и то же. Молча выбрать одно из двух значит оставить оператора в
    // уверенности, что он задал другое.
    var спор = только.Intersect(кроме, StringComparer.Ordinal).ToList();
    if (спор.Count > 0)
    {
        var имена = storage.GetGroups().Where(g => спор.Contains(g.Id)).Select(g => g.Name).ToList();
        return Results.BadRequest(new { error = "Группа указана и в «показывать», и в «кроме»: " + string.Join(", ", имена.Count > 0 ? имена : спор) });
    }
    if (!storage.SetImageGroups(id, только, кроме))
        return Results.NotFound(new { error = "Картинка не найдена." });
    // Состав рекламы у планшетов изменился прямо сейчас: они держат выданный им список и сами о
    // группах не знают, поэтому список пересобирается и уходит заново.
    _ = coord.RefreshSlidesAsync();
    var сохранено = storage.GetImages().FirstOrDefault(i => i.Id == id);
    return Results.Ok(new { ok = true, groupIds = сохранено?.GroupIds ?? new List<string>(), exceptGroupIds = сохранено?.ExceptGroupIds ?? new List<string>() });
});

admin.MapPost("/images", async (HttpRequest req) =>
{
    if (!req.HasFormContentType)
        return Results.BadRequest(new { error = "expected multipart/form-data" });
    var form = await req.ReadFormAsync();
    var added = new List<object>();
    var skipped = new List<string>();
    foreach (var file in form.Files)
    {
        var ext = ResolveImageExtension(file.FileName, file.ContentType);
        if (ext is null) { skipped.Add(file.FileName + ": это не картинка"); continue; }
        // Предел на файл. Реклама уезжает на планшеты целиком и хранится на сервере, поэтому
        // снимок с телефона на двадцать мегабайт здесь не место: он и грузиться будет минуту,
        // и место займёт зря. Восьми мегабайт хватает любой рекламной картинке с запасом.
        if (file.Length > MaxImageBytes)
        {
            skipped.Add(file.FileName + ": " + (file.Length / (1024 * 1024)) + " МБ, а больше " +
                        (MaxImageBytes / (1024 * 1024)) + " МБ картинка быть не может");
            continue;
        }
        await using var s = file.OpenReadStream();
        var info = storage.AddImage(s, file.FileName, ext);
        added.Add(new { info.Id, info.OriginalName, url = "/media/" + info.FileName });
    }
    // Молча пропустить файл нельзя: оператор увидел бы «Картинки загружены» и не понял, почему
    // их в списке нет.
    if (added.Count == 0 && skipped.Count > 0)
        return Results.BadRequest(new { error = "Ничего не загружено. " + string.Join("; ", skipped) });
    return Results.Ok(new { added, skipped });
});

admin.MapDelete("/images/{id}", (string id, KioskCoordinator coord) =>
{
    if (!storage.DeleteImage(id)) return Results.NotFound();
    // Планшет держит выданный ему список и о том, что файла больше нет, не знает: он показывал
    // бы битую картинку до самой перезагрузки. Список пересобирается и уходит заново.
    _ = coord.RefreshSlidesAsync();
    return Results.Ok(new { ok = true });
});

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
    var дошло = await coord.SaveAndShowSlidesAsync(target, dto?.ImageIds ?? new List<string>(), dto?.IntervalSec ?? 8, dto?.DeviceIds);
    // Сохранить настройку и показать её на экране это разные события: оператору важно знать,
    // случилось ли второе, иначе «Сохранено и отправлено» звучит одинаково и когда реклама
    // поехала на десять планшетов, и когда ни один из них не включён.
    return Results.Ok(new { ok = true, shown = дошло });
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

// ---- Библиотека документов ----
// Документов может быть несколько. Адресуются они кодом: его пишет оператор, им пользуется
// внешняя система. Текст документа читается и пишется теми же методами, что и раньше, просто
// с указанием, какой именно: без указания берётся тот, что назначен по умолчанию.

admin.MapGet("/documents", () => Results.Ok(storage.GetDocuments()));

admin.MapPost("/documents", (DocumentMetaDto? dto) =>
{
    var (info, error) = storage.AddDocument(dto?.Code, dto?.Name, dto?.CopyOfId);
    return error is not null ? Results.BadRequest(new { error }) : Results.Ok(info);
});

admin.MapPut("/documents/{id}", (string id, DocumentMetaDto? dto) =>
{
    var error = storage.UpdateDocumentMeta(id, dto?.Code, dto?.Name);
    return error is not null ? Results.BadRequest(new { error }) : Results.Ok(new { ok = true });
});

admin.MapPost("/documents/{id}/default", (string id) =>
{
    var error = storage.SetDefaultDocument(id);
    return error is not null ? Results.BadRequest(new { error }) : Results.Ok(new { ok = true });
});

admin.MapDelete("/documents/{id}", (string id) =>
{
    var error = storage.DeleteDocument(id);
    return error is not null ? Results.BadRequest(new { error }) : Results.Ok(new { ok = true });
});

// Версия документа едет заголовком, а не в теле: тело остаётся самим документом, и ни админка,
// ни внешние системы, ни экспорт с импортом форму ответа не меняют.
admin.MapGet("/document", (HttpContext ctx, string? id) =>
{
    // Какой документ читать, говорит запрос. Без указания это документ по умолчанию: так
    // работает всё, написанное до появления библиотеки.
    var док = id is null ? storage.DefaultDocumentInfo() : storage.GetDocumentInfo(id);
    if (док is null) return Results.NotFound(new { error = "Документ не найден." });
    ctx.Response.Headers["X-Doc-Rev"] = storage.GetDocumentRev(док.Id);
    ctx.Response.Headers["X-Doc-Id"] = док.Id;
    return Results.Ok(storage.GetDocument(док.Id));
});
admin.MapPut("/document", (DocumentConfig? doc, HttpContext ctx, string? id) =>
{
    if (doc is null) return Results.BadRequest(new { error = "document required" });
    var док = id is null ? storage.DefaultDocumentInfo() : storage.GetDocumentInfo(id);
    if (док is null) return Results.NotFound(new { error = "Документ не найден." });
    // Две открытые админки правят один документ: без сверки версий вторая молча затирала бы
    // работу первой, и никто бы об этом не узнал. Сверка по желанию отправителя: админка шлёт
    // версию, от которой правила, а внешняя система и импорт не шлют ничего и работают как
    // работали, перезаписью целиком.
    var baseRev = ctx.Request.Headers["X-Doc-Rev"].ToString();
    if (baseRev.Length > 0 && baseRev != storage.GetDocumentRev(док.Id))
        return Results.Json(new
        {
            error = "Документ уже изменён в другом окне или другим оператором. " +
                    "Возьмите свежую версию, иначе чужая работа будет затёрта."
        }, statusCode: StatusCodes.Status409Conflict);
    // Условие, которое при сохранении изменилось бы само, это отказ, а не предупреждение: иначе
    // документ сохранится с другим смыслом, и содержимое покажется там, где его прятали.
    var нельзя = DocumentTemplating.WhyNotSavable(doc);
    if (нельзя is not null) return Results.BadRequest(new { error = нельзя });
    // Остальное разбор рассказывает как замечания: имя элемента, совпавшее с тегом API, и
    // прочее, что стоит знать, но что смысла документа не меняет.
    var срезано = DocumentTemplating.SanitizeWarnings(doc);
    if (DocumentTemplating.IsInfo(doc))
    {
        var почемуНельзя = DocumentTemplating.WhyNotInfo(doc);
        if (почемуНельзя is not null) return Results.BadRequest(new { error = почемуНельзя });
    }
    var badImages = DocumentTemplating.UnsupportedImages(doc);
    if (badImages.Count > 0)
        return Results.BadRequest(new
        {
            error = "Эти картинки нельзя использовать в документе: их не удастся вложить в PDF. " +
                    "Подойдут PNG, JPG или BMP. Проблемные файлы: " + string.Join(", ", badImages)
        });
    if (!storage.SaveDocument(док.Id, doc))
        return Results.NotFound(new { error = "Документ не найден: " + док.Id });
    ctx.Response.Headers["X-Doc-Rev"] = storage.GetDocumentRev(док.Id);
    return Results.Ok(new { ok = true, warnings = срезано });
});

// Preview: resolve the template with operator-supplied test values EXACTLY as a tablet would see
// it (tags substituted, conditions applied, API checkboxes injected), without touching any tablet
// and without storing anything. If a document is posted, the unsaved editor state is previewed.
admin.MapPost("/document/preview", (PreviewDto? dto) =>
{
    var badField = FieldSchema.Validate(dto?.Fields);
    if (badField is not null) return Results.BadRequest(new { error = badField });
    // Неизвестный номер документа это отказ, а не документ по умолчанию: иначе оператор увидел
    // бы чужой текст под именем запрошенного документа и решил, что открыл нужный.
    DocumentConfig doc;
    if (dto?.Document is not null) doc = dto.Document;
    else if (!storage.TryGetDocument(dto?.DocumentId, out doc))
        return Results.NotFound(new { error = "Документ не найден: " + dto?.DocumentId });
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
    // Присланный пункт переводится так же, как на пути показа: обязательность только та, о
    // которой сказали явно. Иначе предпросмотр показывал бы звёздочку там, где на планшете её
    // не будет, и обещал бы не тот экран.
    foreach (var cb in (dto?.Checkboxes ?? new List<ApiCheckboxDto>()).Where(x => x is not null).Select(x => x.ВПункт()))
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

    var badPreviewImage = KioskCoordinator.ParseApiImages(dto?.Images, out var картинкиПред);
    if (badPreviewImage is not null) return Results.BadRequest(new { error = badPreviewImage });
    var resolved = DocumentTemplating.Resolve(doc, dto?.Fields, extra, selections, states, null, null, картинкиПред);
    return Results.Ok(new
    {
        document = resolved,
        placeholders = DocumentTemplating.Placeholders(doc),
        missingPlaceholders = DocumentTemplating.Missing(doc, dto?.Fields),
        emptyPlaceholders = DocumentTemplating.Empty(doc, dto?.Fields),
        pagesTotal = (doc.Pages ?? new List<DocPage>()).Count,
        pagesShown = resolved.Pages.Count
    });
});

// ---- Наблюдение за экраном планшета ----
// Что сейчас показано на планшете, в том же виде, в каком это получил он сам. Нужно окну
// наблюдения: оно рисует документ своим отрисовщиком, а от планшета получает только то, что
// меняется. Отдаётся по требованию и только администратору, никуда не записывается.
admin.MapGet("/devices/{id}/screen", (string id, KioskCoordinator coord) =>
{
    var dev = storage.GetDevice(id);
    if (dev is null) return Results.NotFound(new { error = "Планшет не найден." });
    var cmd = coord.BuildCurrentCommand(id);
    return Results.Ok(new { mode = cmd.Mode, document = cmd.Document, slides = cmd.Slides });
});

// ---- Раскладка PDF ----
// Возвращает, где именно окажется каждая строка будущего PDF. Считает это тот же генератор,
// который потом соберёт настоящий файл, поэтому макет в админке не похож на PDF, а совпадает
// с ним. Рисовать PDF в браузере для этого не нужно.
admin.MapPost("/document/pdf-layout", (PreviewDto? dto, PdfService pdf) =>
{
    DocumentConfig doc;
    if (dto?.Document is not null) doc = dto.Document;
    else if (!storage.TryGetDocument(dto?.DocumentId, out doc))
        return Results.NotFound(new { error = "Документ не найден: " + dto?.DocumentId });
    DocumentTemplating.Sanitize(doc);
    var badField = FieldSchema.Validate(dto?.Fields);
    if (badField is not null) return Results.BadRequest(new { error = badField });
    var badDate = DocumentTemplating.ValidateAgeFields(doc, dto?.Fields);
    if (badDate is not null) return Results.BadRequest(new { error = badDate });

    // Макет считается по документу с подставленными значениями: длина текста зависит от них,
    // а значит и от них зависит, на какой странице окажется подпись.
    var resolved = DocumentTemplating.Resolve(doc, dto?.Fields,
        (dto?.Checkboxes ?? new List<ApiCheckboxDto>()).Where(x => x is not null).Select(x => x.ВПункт()).ToList());
    var layout = pdf.Layout(resolved, null, doc, dto?.Fields);
    return Results.Ok(new
    {
        pageWidth = layout.PageWidth,
        pageHeight = layout.PageHeight,
        pageCount = layout.PageCount,
        items = layout.Items,
        placements = doc.SignaturePlacements,
        // Поля подписи документа: их и расставляет оператор. Пустое имя это итоговая подпись.
        fields = SignatureFieldsOf(doc)
    });
});

static List<object> SignatureFieldsOf(DocumentConfig doc)
{
    var list = new List<object> { new { key = "", label = "Итоговая подпись под документом" } };
    foreach (var p in doc.Pages ?? new List<DocPage>())
        foreach (var sg in p.Signatures ?? new List<DocSignature>())
            if (sg is not null && !string.IsNullOrWhiteSpace(sg.Key))
                list.Add(new { key = sg.Key, label = string.IsNullOrWhiteSpace(sg.Label) ? sg.Key : sg.Label });
    return list;
}

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
    // Ключ, который нельзя передать по HTTP, отвергается здесь, а не превращается потом в
    // «планшет не отвечает по сети» на каждой команде: оператор искал бы неисправность в Wi-Fi.
    var плохойКлюч = StorageService.ПочемуКлючУправленияНеГодится(dto.ClearApiKey ? "" : dto.ApiKey);
    if (плохойКлюч is not null) return Results.BadRequest(new { error = плохойКлюч });
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
    // Дата здесь же и по той же причине. Сутки везде считаются по этим часам: и расписание, и
    // возраст, и окно вокруг годовщины. Если пояс сервера не тот, в котором живёт оператор, окно
    // открывается и закрывается со сдвигом, и выглядит это как ошибка на день в счёте дней.
    serverDate = DateTime.Now.ToString("yyyy-MM-dd"),
    serverTime = DateTime.Now.ToString("HH:mm"),
    serverZone = TimeZoneInfo.Local.StandardName,
    serverOffset = TimeZoneInfo.Local.GetUtcOffset(DateTime.Now).ToString()
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
{
    // total это сколько записей подошло под отбор, а не сколько их всего в кольце: иначе при
    // выбранном уровне оператор читал «Показано 12 из 1843» как «остальное от меня спрятали».
    var записи = logs.Filtered(level, q, limit ?? 300, out var подошло);
    return Results.Ok(new { total = подошло, entries = записи });
});

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
// Импорт заводит НОВЫЙ документ, а не затирает открытый. С библиотекой затирание означало бы
// «принёс шаблон от коллеги, потерял свой»: файл шаблона это отдельный документ, а не замена
// всему. Код нового документа берётся из запроса, а без него сочиняется из названия файла.
admin.MapPost("/document/import", (DocumentBackup? backup, string? code, string? title) =>
{
    var doc = backup?.Document;
    if (backup is null || doc is null || !string.Equals(backup.Kind, DocumentBackup.KindValue, StringComparison.Ordinal))
        return Results.BadRequest(new { error = "Это не файл шаблона документа HELIX SignTablet." });
    // Версия 1 это файл без картинок, версия 2 с картинками. Обе читаются.
    if (backup.Version is < 1 or > 2)
        return Results.BadRequest(new { error = "Версия файла шаблона не поддерживается." });
    // Название, заданное при импорте, это и есть имя документа, а имя документа это его заголовок.
    // Прежде оно уходило только в список, и когда в файле был свой заголовок, заданное название
    // молча не действовало: в списке одно, в открытом документе другое.
    if (!string.IsNullOrWhiteSpace(title)) doc.Title = title!.Trim();
    // Условие, которое при разборе изменилось бы само, это отказ и здесь: принять чужой файл и
    // молча сохранить его с другим смыслом хуже, чем отказать и назвать причину. Правило то же,
    // что при сохранении из редактора.
    var опасное = DocumentTemplating.WhyNotSavable(doc);
    if (опасное is not null) return Results.BadRequest(new { error = опасное });
    // Validate AFTER sanitising: a file whose pages are all unusable would otherwise pass the check
    // and then replace the working template with an empty one.
    DocumentTemplating.Sanitize(doc);
    if (doc.Pages.Count == 0)
        return Results.BadRequest(new { error = "В файле нет ни одной пригодной страницы документа." });

    // Картинки из файла кладутся в медиатеку под теми же именами, на которые ссылается документ.
    // Без этого шаблон, перенесённый на другой сервер, показывал бы пустые рамки вместо печатей.
    // Уже существующий файл не трогаем: он мог быть заменён нарочно.
    var restored = 0;
    foreach (var img in backup.Images ?? new List<BackupImage>())
    {
        if (img is null) continue;
        var name = Path.GetFileName(img.File ?? "");
        // Имя из файла в путь не превращается: только имя файла и только известное расширение.
        if (name.Length == 0 || name != img.File || name.Length > 120) continue;
        var ext = Path.GetExtension(name).ToLowerInvariant();
        if (ext is not (".png" or ".jpg" or ".jpeg" or ".gif" or ".webp")) continue;
        try
        {
            var bytes = Convert.FromBase64String(img.Data ?? "");
            if (bytes.Length == 0 || bytes.Length > 8 * 1024 * 1024) continue;
            if (storage.RestoreImage(name, bytes, img.File ?? name)) restored++;
        }
        catch (Exception ex) { app.Logger.LogWarning(ex, "Картинка {File} из файла шаблона не восстановлена", name); }
    }

    // Код должен быть свободным. Занятый не подменяется молча: это и есть тот самый случай,
    // когда чужая работа затирается без спроса.
    var желаемый = StorageService.CleanDocCode(code);
    if (желаемый.Length == 0) желаемый = StorageService.CleanDocCode(doc.Title);
    if (желаемый.Length == 0) желаемый = "import";
    var свободный = желаемый;
    var n = 2;
    while (storage.FindByCode(свободный) is not null) свободный = желаемый + "-" + n++;

    // Имя берётся из заголовка, который уже сведён с заданным при импорте названием. Пустой
    // заголовок оставляет документу именем его код: выдумывать заголовок за оператора нельзя.
    var (info, error) = storage.AddDocument(свободный, doc.Title, null);
    if (error is not null) return Results.BadRequest(new { error });
    if (!storage.SaveDocument(info!.Id, doc))
        return Results.NotFound(new { error = "Документ не найден: " + info!.Id });
    return Results.Ok(new { ok = true, pages = doc.Pages.Count, images = restored, id = info.Id, code = info.Code });
});

// A document is ALWAYS shown on exactly one tablet (never all/group), so the signer's
// personal data can only ever reach that one device.
admin.MapPost("/show-document", async (ShowDocumentDto dto, KioskCoordinator coord) =>
{
    var deviceId = DeviceFromTarget(dto?.Target);
    if (deviceId is null)
    {
        // Отозванный планшет сюда не проходит. Сказать об этом прямо: «выберите планшет», когда
        // планшет выбран, читается как поломка формы, а не как отказ по существу.
        var сырой = (dto?.Target ?? "").StartsWith("device:", StringComparison.Ordinal)
            ? dto!.Target!["device:".Length..] : (dto?.Target ?? "");
        var отозван = storage.GetDevice(сырой);
        if (отозван is { Status: "revoked" })
            return Results.BadRequest(new { error = "Планшет «" + отозван.Name + "» отозван: показывать на нём ничего нельзя. Верните его в работу на вкладке «Планшеты» или выберите другой." });
        return Results.BadRequest(new { error = "Документ показывается только на один планшет. Выберите планшет." });
    }
    var badField = FieldSchema.Validate(dto?.Fields);
    if (badField is not null) return Results.BadRequest(new { error = badField });
    var (док, badCode) = PickDocument(dto?.DocumentCode);
    if (badCode is not null) return Results.BadRequest(new { error = badCode });
    var шаблон = storage.GetDocument(док!.Id);
    var badDate = DocumentTemplating.ValidateAgeFields(шаблон, dto?.Fields);
    if (badDate is not null) return Results.BadRequest(new { error = badDate });
    // Документ без страниц показывать нечего: планшет останется с тем же экраном, а оператор
    // будет думать, что отправка не сработала. Молча делать ничего хуже, чем сказать почему.
    if (шаблон.Pages.Count == 0)
        return Results.BadRequest(new { error = "В документе «" + док.Name + "» нет ни одной страницы: показывать нечего. Добавьте страницу на вкладке «Документ»." });
    var badImage = KioskCoordinator.ParseApiImages(dto?.Images, out var картинки);
    if (badImage is not null) return Results.BadRequest(new { error = badImage });
    // Присланные пункты переводятся так же, как на внешнем пути: обязательность только та, о
    // которой сказали явно. Помощник в админке отправляет ровно то же тело, что внешняя система.
    var пунктыИзЗапроса = (dto?.Checkboxes ?? new List<ApiCheckboxDto>())
        .Where(x => x is not null).Select(x => x.ВПункт()).ToList();
    // Что из запроса не доехало до клиента, говорится и здесь: помощник в админке отправляет то
    // же тело, что внешняя система, и молчать о потерянном пункте перед оператором так же плохо.
    var отброшено = new List<string>();
    var размещено = new List<string>();
    await coord.ShowDocumentAsync(deviceId, dto?.Fields, пунктыИзЗапроса, dto?.Groups, картинки, док, отброшено, размещено);
    if (размещено.Count > 0)
        eventLog.Add("info", "api", "Заказ добавил в документ «" + док.Code + "» пунктов: "
            + размещено.Count + ". " + string.Join("; ", размещено));
    var missing = DocumentTemplating.Missing(шаблон, dto?.Fields);
    // Ключ прислали, а значения в нём нет: на месте тега останется дыра, а условие на него
    // погаснет. Отдельно от missingPlaceholders: там смысл «ключа не было», и менять его нельзя,
    // на него смотрят уже работающие внешние системы.
    var пустые = DocumentTemplating.Empty(шаблон, dto?.Fields);
    return Results.Ok(new { ok = true, document = док.Code, missingPlaceholders = missing,
        emptyPlaceholders = пустые, dropped = отброшено, placed = размещено });
});

admin.MapPost("/show-slides", async (TargetDto dto, KioskCoordinator coord) =>
{
    var deviceId = DeviceFromTarget(dto?.Target);
    if (deviceId is null)
    {
        // Каждой причине свой текст. «Возврат к рекламе выполняется для одного планшета» в ответ
        // на выбранный планшет читается как поломка формы, а оператор в этот момент пытается
        // убрать с экрана документ с данными клиента и должен понимать, что происходит.
        var сырой = (dto?.Target ?? "").StartsWith("device:", StringComparison.Ordinal)
            ? dto!.Target!["device:".Length..] : (dto?.Target ?? "");
        var планшет = сырой.Length > 0 ? storage.GetDevice(сырой) : null;
        if (планшет is { Status: "revoked" })
            return Results.BadRequest(new { error = "Планшет «" + планшет.Name + "» отозван: его экран уже очищен, возвращать к рекламе нечего." });
        if (сырой.Length > 0 && планшет is null)
            return Results.BadRequest(new { error = "Планшета «" + сырой + "» в системе нет: он удалён, а его экран очищен при удалении." });
        return Results.BadRequest(new { error = "Возврат к рекламе выполняется для одного планшета. Выберите планшет." });
    }
    await coord.ReturnToSlidesAsync(deviceId);
    return Results.Ok(new { ok = true });
});

// ---- Signatures ----
// Newest first, bounded: after a year of use the archive holds tens of thousands of records and
// returning all of them would stall every other storage operation.
admin.MapGet("/signatures", (int? limit) =>
    Results.Ok(storage.ListSignatures(Math.Clamp(limit ?? 200, 1, 1000)).Select(r => new
    {
        r.Id, r.CreatedUtc, r.DocumentTitle, r.DocumentCode, r.DocumentName, r.DeviceId, r.DeviceName, r.WorkstationName,
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

admin.MapGet("/signatures/{id}/image/{file}", (string id, string file) =>
{
    // Подпись, поставленная внутри страницы. Имя файла берётся из самой записи, поэтому
    // произвольный путь сюда не подставить.
    var rec = storage.GetSignature(id);
    if (rec is null || !rec.Signatures.Any(x => x.File == file)) return Results.NotFound();
    var bytes = storage.GetExtraSignatureBytes(id, file);
    return bytes is null ? Results.NotFound() : Results.File(bytes, "image/png");
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
            try { path = pdf.Generate(rec, doc, png, file => storage.GetExtraSignatureBytes(id, file)); }
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
    // Вошедший администратор проходит и без ключа: он проверяет свой же документ из админки, а
    // права у него и так шире, чем у любого ключа. Искать ключ ради проверки собственного
    // документа значило бы мешать работать на ровном месте.
    var админ = ctx.HttpContext.User?.HasClaim("role", "admin") == true;
    if (!админ && !storage.ValidateApiKey(key))
        return Results.Json(new { error = "invalid api key" }, statusCode: StatusCodes.Status401Unauthorized);
    return await next(ctx);
})
// Отказ без единого слова. Запрос с пустым телом платформа отвергала голым кодом 400 с пустым
// телом ответа: в журнале интегратора это выглядит как «киоск ответил пустотой», и показать
// оператору нечего. Здесь два прохода: пустое тело называется своим именем сразу, а всё
// остальное, что платформа отвергла молча, получает объяснение после её работы.
.AddEndpointFilter(async (ctx, next) =>
{
    var req = ctx.HttpContext.Request;
    var ждётТело = HttpMethods.IsPost(req.Method) || HttpMethods.IsPut(req.Method) || HttpMethods.IsPatch(req.Method);
    // Пустым считается только то, что пусто наверняка: нулевая длина, либо неизвестная длина без
    // объявленного вида содержимого. Тело, присланное кусками (chunked), под это не подпадает.
    var пусто = req.ContentLength == 0 || (req.ContentLength is null && string.IsNullOrEmpty(req.ContentType));
    if (ждётТело && пусто)
        return Results.Json(new
        {
            error = "Тело запроса пустое, а этот запрос ждёт JSON. Пришлите заголовок " +
                    "Content-Type: application/json и тело запроса, например {\"deviceId\":\"...\"}."
        }, statusCode: StatusCodes.Status400BadRequest);

    // Само тело здесь читать нельзя: к моменту работы фильтра его уже прочитал разбор
    // параметров, и вторая попытка увидит пустой поток. Проверено прогоном: с такой проверкой
    // каждый нормальный запрос с телом получал «тело это не JSON». Поэтому битый JSON и
    // неверный Content-Type остаются за платформой, см. запись ниже.
    var результат = await next(ctx);

    // Разбор мог не удаться и на том, что до тела не относится: буквы вместо числа в строке
    // запроса, слишком длинное тело, ещё что-то, о чём платформа отвечает голым кодом. Свои
    // отказы сюда не попадают: их код появляется позже, когда результат уже отдан наружу, а
    // здесь он ещё 200. Пустой отказ это единственный ответ во всём API без объяснения, и в
    // журнале интегратора он выглядит как «киоск промолчал».
    var ответ = ctx.HttpContext.Response;
    if (!ответ.HasStarted && ответ.StatusCode >= 400 && (ответ.ContentLength is null or 0))
        return Results.Json(new { error = ПочемуЗапросНеРазобран(ответ.StatusCode) }, statusCode: ответ.StatusCode);
    return результат;
});

// Отчего платформа отказала до обработчика. Текст один на весь внешний API: разбирать причину
// точнее нам нечем, но сказать, куда смотреть, можно и нужно.
static string ПочемуЗапросНеРазобран(int код) => код switch
{
    StatusCodes.Status400BadRequest =>
        "Запрос не разобран. Проверьте, что тело это правильный JSON, а значения в строке запроса " +
        "нужного вида (например limit это число).",
    StatusCodes.Status415UnsupportedMediaType =>
        "Не задан или не подходит Content-Type. Тело запроса присылайте как application/json.",
    _ => "Запрос отклонён до обработки, код " + код + ". Проверьте адрес, заголовки и тело запроса."
};

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

// Какие документы есть в библиотеке. Без этого интегратор узнаёт коды из переписки, и связь
// ломается при первом же переименовании.
ext.MapGet("/documents", () => Results.Ok(storage.GetDocuments().Select(d => new
{
    code = d.Code,
    name = d.Name,
    isDefault = d.IsDefault
})));

ext.MapGet("/workstations", () =>
    Results.Ok(storage.GetWorkstations().Select(w => new { w.Id, w.ExternalId, w.Name, w.Location })));

// Завести рабочее место. Запрос идемпотентен по коду: медсистема обычно шлёт «создай, если
// нет» на каждый заказ, и без этого копились места с одинаковым кодом. Планшет, привязанный ко
// второму такому месту, становился недостижим: отбор берёт первое совпадение и отвечает «нет
// планшета на этом месте», хотя планшет в кабинете стоит и работает.
ext.MapPost("/workstations", (WorkstationDto dto) =>
{
    var код = (dto?.ExternalId ?? "").Trim();
    if (код.Length > 0)
    {
        var было = storage.GetWorkstations().FirstOrDefault(w => ЭтоМесто(w, код));
        if (было is not null) return Results.Ok(было);
    }
    // Отказ «код занят» сюда не доходит: повтор уже отдан строкой выше как готовое место. Но
    // если он всё же случится (двое завели один код одновременно), внешняя система услышит
    // причину словами, а не получит запись, которой нет.
    var (место, ошибка) = storage.AddWorkstation(dto?.ExternalId, dto?.Name, dto?.Location);
    return ошибка is not null ? Results.BadRequest(new { error = ошибка }) : Results.Ok(место);
});

ext.MapPost("/enrollments", (ExtEnrollmentDto dto) =>
{
    string? wsId = null;
    if (!string.IsNullOrWhiteSpace(dto?.WorkstationExternalId))
    {
        // Код места ищется так же, как везде: без учёта регистра и окружающих пробелов.
        var ws = storage.GetWorkstations().FirstOrDefault(w => ЭтоМесто(w, dto!.WorkstationExternalId));
        if (ws is null) return Results.Json(new
        {
            error = "Рабочего места с кодом «" + dto!.WorkstationExternalId!.Trim() + "» нет " +
                    "(workstationExternalId). Заведите его запросом POST /api/ext/workstations."
        }, statusCode: StatusCodes.Status404NotFound);
        wsId = ws.Id;
    }
    var e = storage.CreateEnrollment(dto?.Name, wsId, null, 60);
    return Results.Ok(new { code = e.Code, expiresUtc = e.ExpiresUtc });
});

// Планшет уводят с рабочего места: перевели в другой кабинет, сняли с места, удалили само место.
// Его экран обязан вернуться к рекламе, а данные подписанта стереться.
//
// Замер до починки: планшет на месте «201» показывает документ с фамилией клиента; PUT переводит
// его на место «202», ответ 200; через три секунды и после перезагрузки страницы планшета на
// экране тот же документ, хотя карточка уже называет другой кабинет. То же на отвязке и на
// удалении места. То есть данные клиента уезжали на экране в другой кабинет, к другому человеку,
// а внешняя система и оператор видели «ок».
//
// Уводится только тот планшет, у которого место ДЕЙСТВИТЕЛЬНО сменилось. Повторная привязка к
// тому же месту экран не трогает: зря погашенный экран это оборванное подписание у живого
// человека, и это не лучше первой беды.
async Task УвестиСМеста(KioskCoordinator coord, params string[] планшеты)
{
    foreach (var id in планшеты)
    {
        // Отозванный и удалённый отсеиваются внутри: на их экранах нет ни документа, ни рекламы.
        try { await coord.ReturnToSlidesAsync(id); }
        catch { /* планшет не на связи: состояние на сервере уже переписано на рекламу */ }
    }
}

// Привязать планшет к рабочему месту по коду места. Пустой код здесь не принимается: раньше
// такой запрос молча отвязывал планшет от места и отвечал «ок», а внешняя система, забывшая
// подставить код в шаблон запроса, узнавала об этом только тогда, когда документ переставал
// находить планшет в кабинете. Отвязка это отдельное, названное вслух действие: DELETE.
ext.MapPut("/devices/{id}/workstation", async (string id, ExtWorkstationAssignDto dto, KioskCoordinator coord) =>
{
    var код = (dto?.ExternalId ?? "").Trim();
    if (код.Length == 0)
        return Results.BadRequest(new
        {
            error = "Не задан externalId рабочего места. Чтобы отвязать планшет от места, вызовите " +
                    "DELETE /api/ext/devices/" + id + "/workstation."
        });
    var итог = storage.AssignWorkstationByExternalId(id, код, out var сменилось);
    if (сменилось) await УвестиСМеста(coord, id);
    return ПривязкаОтвет(итог, id, код);
});

// Отвязать планшет от рабочего места. Отдельный вызов, а не пустое поле в запросе выше.
ext.MapDelete("/devices/{id}/workstation", async (string id, KioskCoordinator coord) =>
{
    var итог = storage.AssignWorkstationByExternalId(id, null, out var сменилось);
    if (сменилось) await УвестиСМеста(coord, id);
    return ПривязкаОтвет(итог, id, null);
});

// Ответ на привязку и отвязку: у каждой причины отказа свой текст, чтобы интегратору было что
// чинить. Раньше на оба случая шло одно «device or workstation not found».
IResult ПривязкаОтвет(StorageService.РезультатПривязки итог, string id, string? код) => итог switch
{
    StorageService.РезультатПривязки.Готово => Results.Ok(new { ok = true, deviceId = id, workstationExternalId = код }),
    StorageService.РезультатПривязки.НетПланшета =>
        Results.Json(new { error = "Планшета «" + id + "» в системе нет (deviceId)." }, statusCode: StatusCodes.Status404NotFound),
    _ => Results.Json(new
    {
        error = "Рабочего места с кодом «" + код + "» нет (workstationExternalId). " +
                "Заведите его запросом POST /api/ext/workstations."
    }, statusCode: StatusCodes.Status404NotFound)
};

// Это ли рабочее место с таким кодом. Сравнение одно на всё внешнее API: без учёта регистра и
// окружающих пробелов. Раньше один и тот же код сравнивался то так, то с учётом регистра, и
// «ROOM-12» заводил место, но не находил его: планшет числился в кабинете, а заказ на этот
// кабинет отвечал «нет такого места».
bool ЭтоМесто(Workstation w, string? код) =>
    string.Equals((w.ExternalId ?? "").Trim(), (код ?? "").Trim(), StringComparison.OrdinalIgnoreCase);

// Resolve a device by its id, or by the external id of the workstation it is assigned to.
// A document carries the signer's personal data, so this must resolve to exactly ONE device:
// if a workstation has several tablets, we refuse rather than pick one arbitrarily and risk
// showing one client's data on another client's screen. status is 0 on success.
// Кому уйдёт документ по запросу внешней системы. Правило одно: документ всегда показывается
// ровно на одном планшете, и если выбрать однозначно нельзя, лучше отказать, чем угадать: чужие
// данные перед чужим человеком не исправишь.
//
// По прямому номеру планшета выбор задан. По коду рабочего места планшетов может оказаться
// несколько; тогда списанные не в счёт, а из оставшихся берётся тот, что на связи, если он там
// один: остальные сейчас не могут показать вообще ничего, и вопрос «кто это увидит» имеет
// единственный ответ. На связи несколько или ни одного означает настоящую неоднозначность, и
// это отказ с перечнем, чтобы вызывающий подставил deviceId.
(string? id, int status, string? error) ResolveExtDeviceId(string? deviceId, string? workstationExternalId)
{
    if (!string.IsNullOrWhiteSpace(deviceId))
    {
        // Списанный планшет не выбирается и по прямому номеру. Отбор по рабочему месту его уже
        // пропускал, а тут он проходил насквозь: документ с данными клиента уезжал на
        // устройство, которое отозвано и ничего не покажет, а внешняя система получала «ок».
        var прямо = storage.GetDevice(deviceId!);
        if (прямо is null) return (null, StatusCodes.Status404NotFound, "device not found");
        if (прямо.Status == "revoked")
            return (null, StatusCodes.Status404NotFound, "this tablet is revoked");
        // Прислали и номер планшета, и код рабочего места. Раньше второе молча отбрасывалось, а
        // это самый опасный вид расхождения: заказ несёт вчерашний номер планшета, который с тех
        // пор перевезли в другой кабинет, и правильный код кабинета. Документ с данными пациента
        // уезжал в чужой кабинет, а в ответе стояло «ок».
        if (!string.IsNullOrWhiteSpace(workstationExternalId))
        {
            var место = storage.GetWorkstations().FirstOrDefault(w => ЭтоМесто(w, workstationExternalId));
            if (место is null)
                return (null, StatusCodes.Status404NotFound, "workstation not found: " + workstationExternalId);
            if (!string.Equals(прямо.WorkstationId, место.Id, StringComparison.Ordinal))
                return (null, StatusCodes.Status409Conflict,
                    "deviceId and workstationExternalId disagree: tablet '" + прямо.Name + "' is not at workstation '" +
                    (место.Name ?? место.ExternalId) + "'. Pass one of them, not both.");
        }
        return (deviceId, 0, null);
    }
    if (!string.IsNullOrWhiteSpace(workstationExternalId))
    {
        var ws = storage.GetWorkstations().FirstOrDefault(w => ЭтоМесто(w, workstationExternalId));
        if (ws is null) return (null, StatusCodes.Status404NotFound,
            "workstation not found: " + workstationExternalId.Trim());
        var наМесте = storage.GetDevices().Where(d => d.WorkstationId == ws.Id).ToList();
        // Отозванный планшет это списанный планшет: он лежит в списке ради истории, показать на
        // нём ничего нельзя. Раньше он считался наравне с живым, и рабочее место с одним рабочим
        // планшетом и одним списанным получало отказ «их тут несколько». Расписание и наблюдение
        // отозванные пропускают давно, а здесь их считали.
        var живые = наМесте.Where(d => d.Status != "revoked").ToList();
        if (живые.Count == 0)
            return (null, StatusCodes.Status404NotFound, наМесте.Count > 0
                ? "the only tablet(s) assigned to this workstation are revoked"
                : "no tablet is assigned to this workstation");
        if (живые.Count > 1)
        {
            // Несколько рабочих планшетов на одном месте. Если на связи ровно один, выбор
            // очевиден: остальные сейчас не могут показать вообще ничего, и никакой
            // неоднозначности в том, кто увидит документ, нет.
            var наСвязи = живые.Where(d => tracker.IsOnline(d.Id)).ToList();
            if (наСвязи.Count == 1) return (наСвязи[0].Id, 0, null);
            // На связи несколько или ни одного: угадывать нельзя. Документ уходит только на один
            // планшет, и ошибка тут означает чужие данные перед чужим человеком. Имена, номера и
            // состояние прямо в ответе: без них внешней системе некуда девать «pass deviceId».
            var перечень = string.Join(", ", живые.Select(d =>
                d.Name + " (" + d.Id + ", " + (tracker.IsOnline(d.Id) ? "на связи" : "не на связи") + ")"));
            return (null, StatusCodes.Status409Conflict,
                "several tablets are assigned to this workstation; pass deviceId to choose one: " + перечень);
        }
        return (живые[0].Id, 0, null);
    }
    return (null, StatusCodes.Status400BadRequest, "pass deviceId or workstationExternalId");
}

// A single device id from an admin target ("device:{id}" or a bare id); null for all/group/unknown.
// Документ из библиотеки по коду. Кода нет: берётся тот, что назначен по умолчанию, и всё
// написанное до библиотеки работает как работало. Код есть, но такого документа нет: отказ с
// именем кода. Молча подставить документ по умолчанию было бы худшим из решений: внешняя система
// опечаталась, а человек подписал не то, и запись при этом выглядит подлинной.
(DocumentInfo? Doc, string? Error) PickDocument(string? code)
{
    var c = (code ?? "").Trim();
    if (c.Length == 0) return (storage.DefaultDocumentInfo(), null);
    var found = storage.FindByCode(c);
    if (found is null)
        return (null, "Документ с кодом «" + c + "» не найден. Доступные коды: " +
                      string.Join(", ", storage.GetDocuments().Select(d => d.Code)) + ".");
    return (found, null);
}

// Отозванный планшет адресатом быть не может. Внешнее API это проверяет и опирается на то, что
// «показать на нём ничего нельзя»; в админке проверки не было, и документ следующего клиента
// уходил на экран, который отозвали как раз затем, чтобы он ничего не показывал.
string? DeviceFromTarget(string? target)
{
    if (string.IsNullOrWhiteSpace(target)) return null;
    var id = target.StartsWith("device:", StringComparison.Ordinal) ? target["device:".Length..] : target;
    var dev = storage.GetDevice(id);
    return dev is not null && dev.Status != "revoked" ? id : null;
}

// Show the signing document on one tablet with per-signer data. Placeholders {{...}} in the
// admin-authored template are filled from `fields`; `checkboxes` add per-signer consent items.
ext.MapPost("/show-document", async (ExtShowDocumentDto dto, KioskCoordinator coord) =>
{
    var badField = FieldSchema.Validate(dto?.Fields);
    if (badField is not null) return Results.BadRequest(new { error = badField });
    var (док, badCode) = PickDocument(dto?.DocumentCode);
    if (badCode is not null) return Results.BadRequest(new { error = badCode });
    var шаблон = storage.GetDocument(док!.Id);
    var badDate = DocumentTemplating.ValidateAgeFields(шаблон, dto?.Fields);
    if (badDate is not null) return Results.BadRequest(new { error = badDate });
    // Тот же случай, что и в админке: показывать нечего, и внешняя система должна узнать это
    // сразу, а не гадать, почему на планшете ничего не изменилось.
    if (шаблон.Pages.Count == 0)
        return Results.BadRequest(new { error = "В документе «" + док.Name + "» нет ни одной страницы: показывать нечего." });
    var (deviceId, status, error) = ResolveExtDeviceId(dto?.DeviceId, dto?.WorkstationExternalId);
    if (deviceId is null)
        return Results.Json(new { error }, statusCode: status);
    var badImage = KioskCoordinator.ParseApiImages(dto?.Images, out var картинки);
    if (badImage is not null) return Results.BadRequest(new { error = badImage });
    // На связи ли планшет прямо сейчас. Внешней системе нельзя показать предупреждение, как
    // оператору: у неё есть только ответ. Раньше «ok:true» приходил одинаково и когда документ
    // появился на экране, и когда планшет выключен, и медсистема считала, что пациент читает
    // согласие, которого никто не показывал.
    var наСвязи = tracker.IsOnline(deviceId);
    var отброшено = new List<string>();
    var размещено = new List<string>();
    // Присланные пункты переводятся в пункты документа здесь: обязательность у них только та,
    // о которой сказали явно, а не «включена по умолчанию», как у пункта, поставленного оператором.
    var присланныеПункты = (dto?.Checkboxes ?? new List<ApiCheckboxDto>())
        .Where(x => x is not null).Select(x => x.ВПункт()).ToList();
    await coord.ShowDocumentAsync(deviceId, dto?.Fields, присланныеПункты, dto?.Groups, картинки, док, отброшено, размещено);
    // След остаётся, даже если клиент уйдёт не подписав: записи тогда не будет вовсе, а заказ
    // добавил в документ пункты, которых оператор не писал.
    if (размещено.Count > 0)
        eventLog.Add("info", "api", "Заказ добавил в документ «" + док.Code + "» пунктов: "
            + размещено.Count + ". " + string.Join("; ", размещено));
    var missing = DocumentTemplating.Missing(шаблон, dto?.Fields);
    return Results.Ok(new
    {
        ok = true, deviceId, document = док.Code, missingPlaceholders = missing,
        // Куда встал каждый присланный пункт. Раньше ответ перечислял только потери, и внешняя
        // система не знала, на какой странице человек увидит то, что она дописала.
        placed = размещено,
        // Теги, которые прислали пустыми. Показ не отменяется: пустое может быть прислано
        // умышленно, но знать об этом внешняя система обязана.
        emptyPlaceholders = DocumentTemplating.Empty(шаблон, dto?.Fields),
        // shown: документ действительно на экране. false означает, что он сохранён и покажется,
        // когда планшет подключится, но не позже чем через два часа: потом он стирается сам.
        shown = наСвязи,
        deviceOnline = наСвязи,
        // Что из заказа не поместилось в пределы и до клиента не доехало. Пустой список это
        // «доехало всё».
        dropped = отброшено,
        note = наСвязи ? null
            : "Планшет сейчас не на связи. Документ сохранён и покажется, как только планшет подключится; если этого не случится за два часа, он будет стёрт."
    });
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

        // Отчего ожидание кончилось. Раньше на все случаи отвечали «код не был отсканирован»,
        // хотя таймаут мог и не наступить: заявку могла вытеснить другая или её отменили. Две
        // интеграции, спорящие за один планшет, читали это как поломку камеры.
        var почему = broker.WhyEnded(wait);
        broker.Forget(wait);
        if (почему == "вытеснена")
            return Results.Json(new
            {
                ok = false, deviceId,
                error = "На этот планшет пришла другая заявка на сканирование, ваша снята. Повторите запрос, когда планшет освободится."
            }, statusCode: StatusCodes.Status409Conflict);
        if (почему == "отменена")
            return Results.Json(new { ok = false, deviceId, error = "Сканирование отменено." },
                statusCode: StatusCodes.Status409Conflict);

        // Only close the camera if nobody else is waiting for this tablet. A newer request may have
        // superseded this one, and stopping the camera would cancel THAT scan mid-air.
        if (!broker.IsWaiting(deviceId)) await coord.StopScanAsync(deviceId);
        return Results.Json(new { ok = false, deviceId, error = "timeout: код не был отсканирован" },
            statusCode: StatusCodes.Status408RequestTimeout);
    }
});

// Cancel a scan in progress on a tablet.
ext.MapPost("/scan-cancel", async (ExtShowDocumentDto dto, KioskCoordinator coord, ScanBroker broker) =>
{
    var (deviceId, status, error) = ResolveExtDeviceId(dto?.DeviceId, dto?.WorkstationExternalId);
    if (deviceId is null) return Results.Json(new { error }, statusCode: status);
    // Ожидающего надо разбудить, а не только погасить камеру: раньше отмена отвечала «ок», а
    // заявка висела до своего таймаута (до пяти минут), всё это время считалась живой и не
    // давала закрыть камеру даже чужому таймауту.
    var разбужен = broker.CancelWaiter(deviceId, "отменена");
    await coord.StopScanAsync(deviceId);
    return Results.Ok(new { ok = true, deviceId, cancelledWaiter = разбужен });
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
