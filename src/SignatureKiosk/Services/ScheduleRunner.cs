using SignatureKiosk.Models;

namespace SignatureKiosk.Services;

/// <summary>
/// Выполняет расписание управления планшетами: во сколько, в какие дни, что сделать и с какими
/// планшетами. Время местное для сервера, потому что оператор мыслит стенными часами: «включить
/// экраны в 6:50». При переходе на летнее время правило остаётся в 6:50, а не уезжает на час.
/// Сбой одного правила не мешает остальным и никогда не роняет сервис.
/// </summary>
public class ScheduleRunner : BackgroundService
{
    // Полминуты: правило с точностью до минуты нельзя проверять раз в минуту, иначе окно
    // срабатывания и период совпадают и правило иногда пропускается.
    private static readonly TimeSpan Tick = TimeSpan.FromSeconds(30);

    /// <summary>Обычное окно срабатывания: чуть больше двух тактов, чтобы правило не потерялось.</summary>
    private static readonly TimeSpan NormalWindow = TimeSpan.FromMinutes(2);

    /// <summary>
    /// Окно догона для безопасных действий. Сервис мог быть выключен в назначенный момент, и
    /// тогда утреннее включение экранов выполняется с опозданием: сотрудники приходят к
    /// работающим планшетам, а не к тёмным. Перезагрузка и перезапуск не догоняются никогда.
    /// </summary>
    private static readonly TimeSpan CatchUpWindow = TimeSpan.FromMinutes(30);

    private const int MaxParallel = 8;

    private readonly StorageService _storage;
    private readonly FreeKioskClient _kiosk;
    private readonly KioskCoordinator _coord;
    private readonly EventLogService _log;
    private readonly ILogger<ScheduleRunner> _logger;

    public ScheduleRunner(StorageService storage, FreeKioskClient kiosk, KioskCoordinator coord,
        EventLogService log, ILogger<ScheduleRunner> logger)
    {
        _storage = storage;
        _kiosk = kiosk;
        _coord = coord;
        _log = log;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(Tick);
        while (!stoppingToken.IsCancellationRequested)
        {
            try { await RunDue(DateTime.Now, stoppingToken); }
            catch (OperationCanceledException) { break; }
            catch (Exception ex) { _logger.LogError(ex, "Schedule pass failed"); }

            try { if (!await timer.WaitForNextTickAsync(stoppingToken)) break; }
            catch (OperationCanceledException) { break; }
        }
    }

    /// <summary>Выполнить все правила, чей момент наступил. now задаётся явно, чтобы это можно было проверить.</summary>
    public async Task RunDue(DateTime now, CancellationToken cancel)
    {
        var rules = _storage.GetScheduleRules();
        if (rules.Count == 0) return;

        var today = now.ToString("yyyy-MM-dd");
        foreach (var rule in rules)
        {
            if (!rule.Enabled) continue;
            if (rule.LastRunLocalDate == today) continue;      // раз в сутки

            var action = ScheduleActions.Find(rule.Action);
            if (action is null) continue;

            // День недели: 1 = понедельник … 7 = воскресенье. Пустой список означает каждый день.
            var dow = now.DayOfWeek == DayOfWeek.Sunday ? 7 : (int)now.DayOfWeek;
            if (rule.Days.Count > 0 && !rule.Days.Contains(dow)) continue;

            if (!TryScheduledToday(rule.Time, now, out var due)) continue;
            var late = now - due;
            if (late < TimeSpan.Zero) continue;                // ещё рано
            if (late > (action.CatchUp ? CatchUpWindow : NormalWindow)) continue;

            var result = await Execute(rule, action, cancel);
            _storage.MarkScheduleRun(rule.Id, today, result);
            _log.Add("info", "schedule",
                "Расписание «" + action.Title + "» (" + rule.Time + "): " + result +
                (late > TimeSpan.FromMinutes(2) ? ". Выполнено с опозданием на " + (int)late.TotalMinutes + " мин, сервис был недоступен" : ""));
        }
    }

    private static bool TryScheduledToday(string time, DateTime now, out DateTime due)
    {
        due = default;
        var parts = (time ?? "").Split(':');
        if (parts.Length != 2 || !int.TryParse(parts[0], out var h) || !int.TryParse(parts[1], out var m)) return false;
        if (h is < 0 or > 23 || m is < 0 or > 59) return false;
        due = now.Date.AddHours(h).AddMinutes(m);
        return true;
    }

    /// <summary>Планшеты, которых касается правило.</summary>
    private List<Device> Targets(ScheduleRule rule)
    {
        var devices = _storage.GetDevices().Where(d => d.Status != "revoked").ToList();
        var target = rule.Target ?? "all";
        if (target.StartsWith("device:", StringComparison.Ordinal))
        {
            var id = target["device:".Length..];
            return devices.Where(d => d.Id == id).ToList();
        }
        if (target.StartsWith("group:", StringComparison.Ordinal))
        {
            var id = target["group:".Length..];
            return devices.Where(d => d.GroupIds.Contains(id)).ToList();
        }
        if (string.Equals(target, "devices", StringComparison.Ordinal))
        {
            // Произвольный набор планшетов. Удалённый планшет просто не найдётся: правило от
            // этого не ломается и продолжает работать с остальными.
            var chosen = new HashSet<string>(rule.DeviceIds ?? new List<string>(), StringComparer.Ordinal);
            return devices.Where(d => chosen.Contains(d.Id)).ToList();
        }
        return devices;
    }

    private async Task<string> Execute(ScheduleRule rule, ScheduleActions.Action action, CancellationToken cancel)
    {
        var devices = Targets(rule);
        if (devices.Count == 0) return "планшетов по этому условию нет";

        // Планшет, на котором прямо сейчас открыт документ, трогать нельзя: погасить экран или
        // перезагрузить планшет под рукой у подписывающего человека значит потерять его подпись.
        var skipped = 0;
        if (rule.SkipBusy)
        {
            var states = _storage.GetStates();
            var busy = devices.Where(d => states.Devices.TryGetValue(d.Id, out var st) && st.Mode == "document").ToList();
            skipped = busy.Count;
            devices = devices.Except(busy).ToList();
        }
        if (devices.Count == 0)
            return "пропущено: на всех планшетах идёт подписание (" + skipped + ")";

        if (action.Path is null)
        {
            // Серверное действие: команда идёт через уже открытое соединение, локальная сеть не нужна.
            foreach (var d in devices) await _coord.ReturnToSlidesAsync(d.Id);
            return Report(devices.Count, 0, skipped, null);
        }

        var settings = _storage.GetKioskControlSettings();
        if (!settings.Enabled)
            return "управление по локальной сети выключено, команда не отправлена";

        object? body = action.NeedsValue
            ? (action.Key == "brightness" ? new { brightness = rule.Value, value = rule.Value } : new { volume = rule.Value, value = rule.Value })
            : action.NeedsText ? new { text = rule.Text, message = rule.Text, locale = "ru-RU" }
            : null;
        var method = body is null ? HttpMethod.Get : HttpMethod.Post;

        var ok = 0;
        var failed = new List<string>();
        using var gate = new SemaphoreSlim(MaxParallel);
        var tasks = devices.Select(async d =>
        {
            await gate.WaitAsync(cancel);
            try
            {
                var res = await _kiosk.SendAsync(d, action.Path, method, body, settings, cancel);
                lock (failed) { if (res.Ok) ok++; else failed.Add(d.Name); }
            }
            finally { gate.Release(); }
        });
        await Task.WhenAll(tasks);
        return Report(ok, failed.Count, skipped, failed);
    }

    private static string Report(int ok, int failedCount, int skipped, List<string>? failed)
    {
        var text = "выполнено на " + ok + " планшет(ах)";
        if (failedCount > 0)
        {
            text += ", не ответили: " + failedCount;
            if (failed is { Count: > 0 }) text += " (" + string.Join(", ", failed.Take(5)) + (failed.Count > 5 ? "…" : "") + ")";
        }
        if (skipped > 0) text += ", пропущено из-за идущего подписания: " + skipped;
        return text;
    }

    /// <summary>Запуск правила по требованию оператора, чтобы проверить его, не дожидаясь времени.</summary>
    public async Task<string> RunNow(ScheduleRule rule, CancellationToken cancel)
    {
        var action = ScheduleActions.Find(rule.Action);
        if (action is null) return "неизвестное действие";
        var result = await Execute(rule, action, cancel);
        _log.Add("info", "schedule", "Расписание «" + action.Title + "» запущено вручную: " + result);
        return result;
    }
}
