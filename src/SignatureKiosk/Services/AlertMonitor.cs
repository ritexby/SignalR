using SignatureKiosk.Models;

namespace SignatureKiosk.Services;

/// <summary>
/// Watches the fleet and raises operator alerts: a tablet that has been off air too long, or errors
/// piling up. Runs for the life of the process; a failure inside one pass is logged and the loop
/// continues, so monitoring can never take the service down.
/// </summary>
public class AlertMonitor : BackgroundService
{
    private static readonly TimeSpan Interval = TimeSpan.FromSeconds(30);

    private readonly StorageService _storage;
    private readonly DeviceTracker _tracker;
    private readonly AlertService _alerts;
    private readonly EventLogService _log;
    private readonly KioskCoordinator _coord;
    private readonly FreeKioskClient _kiosk;
    private readonly KioskHealthCache _healthCache;
    private readonly ILogger<AlertMonitor> _logger;

    public AlertMonitor(StorageService storage, DeviceTracker tracker, AlertService alerts,
        EventLogService log, KioskCoordinator coord, FreeKioskClient kiosk, KioskHealthCache healthCache,
        ILogger<AlertMonitor> logger)
    {
        _storage = storage;
        _tracker = tracker;
        _alerts = alerts;
        _log = log;
        _coord = coord;
        _kiosk = kiosk;
        _healthCache = healthCache;
        _logger = logger;
    }

    // After a restart no tablet has reconnected yet, and LastSeenUtc can be hours old (an ungraceful
    // shutdown never stamps it), so an immediate pass would alert about the entire fleet. Give the
    // tablets time to come back before judging them.
    private static readonly TimeSpan StartupGrace = TimeSpan.FromMinutes(2);
    private readonly DateTime _startedUtc = DateTime.UtcNow;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(Interval);
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                // Privacy housekeeping first: drop signer sessions abandoned on tablets that never
                // came back, so personal data does not sit at rest waiting for a reconnect.
                var swept = _coord.SweepExpiredSessions();
                if (swept > 0)
                    _log.Add("info", "privacy", "Очищены брошенные сессии подписания: " + swept);

                // Повреждённый файл данных был отложен в сторону вместо того, чтобы его затёрло
                // пустым значением. Оператор должен узнать об этом сразу: часть настроек в этот
                // момент выглядит так, будто её никогда не было.
                ReportCorruptFiles();

                var changed = await Check();
                if (changed) await _coord.NotifyAdminsAlertsAsync();

                // Polling the tablets means one network round trip each, and an unreachable tablet
                // costs a full timeout. Run it alongside the loop rather than inside it, so a large
                // or sleeping fleet can never hold up the privacy sweep or the offline alerts.
                if (_tabletPass.IsCompleted) _tabletPass = RunTabletPassAsync(stoppingToken);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Alert monitor pass failed");
            }
            try { if (!await timer.WaitForNextTickAsync(stoppingToken)) break; }
            catch (OperationCanceledException) { break; }
        }

        try { await _tabletPass; } catch { /* shutting down */ }
    }

    private Task _tabletPass = Task.CompletedTask;

    private async Task RunTabletPassAsync(CancellationToken cancel)
    {
        try
        {
            if (await CheckTablets(cancel)) await _coord.NotifyAdminsAlertsAsync();
        }
        catch (OperationCanceledException) { /* shutting down */ }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Tablet health pass failed");
        }
    }

    /// <summary>One pass. Returns true if the alert set changed and admins should be told.</summary>
    private Task<bool> Check()
    {
        var settings = _storage.GetAlertSettings();
        var changed = false;

        if (!settings.Enabled)
        {
            // Alerting switched off: drop everything we raised so nothing stale is shown.
            foreach (var id in _alerts.IdsOfKind("offline")) changed |= _alerts.Clear(id);
            foreach (var id in _alerts.IdsOfKind("errors")) changed |= _alerts.Clear(id);
            return Task.FromResult(changed);
        }

        changed |= CheckOfflineDevices(settings);
        changed |= CheckErrorBurst(settings);
        changed |= CheckDuplicateConnections();
        return Task.FromResult(changed);
    }

    private bool CheckOfflineDevices(AlertSettings settings)
    {
        var changed = false;
        // During the grace period after a restart, clear any offline alerts rather than raising new
        // ones: the fleet has simply not reconnected yet.
        if (DateTime.UtcNow - _startedUtc < StartupGrace)
        {
            foreach (var id in _alerts.IdsOfKind("offline")) changed |= _alerts.Clear(id);
            return changed;
        }
        var online = _tracker.OnlineDeviceIds();
        var threshold = TimeSpan.FromMinutes(settings.OfflineMinutes);
        var now = DateTime.UtcNow;
        var wanted = new HashSet<string>(StringComparer.Ordinal);

        foreach (var d in _storage.GetDevices())
        {
            // A revoked tablet is offline on purpose; never alert about it.
            if (d.Status == "revoked" || online.Contains(d.Id)) continue;
            // A tablet that has never connected has no meaningful "since" - skip until it appears once.
            if (d.LastSeenUtc == default) continue;

            var away = now - d.LastSeenUtc;
            if (away < threshold) continue;

            var id = "offline:" + d.Id;
            wanted.Add(id);
            if (_alerts.Raise(id, "offline", "error",
                    "Планшет не на связи: " + d.Name,
                    "Нет связи " + Describe(away) + ". Последний раз на связи " + d.LastSeenUtc.ToLocalTime().ToString("dd.MM.yyyy HH:mm") + ".",
                    d.LastSeenUtc, d.Id, d.Name))
            {
                changed = true;
                _log.Add("warn", "alerts", "Планшет не на связи дольше " + settings.OfflineMinutes + " мин: " + d.Name,
                    null, d.Id, d.Name);
            }
        }

        // Clear alerts for tablets that came back (or were deleted / revoked).
        foreach (var id in _alerts.IdsOfKind("offline"))
            if (!wanted.Contains(id) && _alerts.Clear(id)) changed = true;

        return changed;
    }

    // Health is polled less often than the alert loop: it is a network round trip per tablet.
    private static readonly TimeSpan HealthInterval = TimeSpan.FromMinutes(5);
    private DateTime _lastHealthUtc = DateTime.MinValue;

    /// <summary>
    /// Ask each tablet how it is doing (battery, storage, memory) through its FreeKiosk API, raise
    /// alerts on what needs attention, and try to revive a tablet that dropped off air but is still
    /// answering on the network. All of this is best effort: an unreachable tablet is not an error.
    /// </summary>
    private async Task<bool> CheckTablets(CancellationToken cancel)
    {
        var settings = _storage.GetKioskControlSettings();
        // Alerts about tablets belong to the same switch as every other alert: an operator who
        // turned alerting off for a maintenance window must not be beeped at about batteries.
        var alertsOn = settings.Enabled && _storage.GetAlertSettings().Enabled;

        if (!settings.Enabled)
        {
            // Readings taken before the feature was switched off describe a state nobody is
            // checking any more; showing them as current would mislead.
            _healthCache.Clear();
            return ClearTabletAlerts();
        }
        if (!alertsOn) ClearTabletAlerts();

        if (DateTime.UtcNow - _lastHealthUtc < HealthInterval) return false;
        _lastHealthUtc = DateTime.UtcNow;

        var changed = false;
        var online = _tracker.OnlineDeviceIds();
        var wantedBattery = new HashSet<string>(StringComparer.Ordinal);
        var wantedStorage = new HashSet<string>(StringComparer.Ordinal);
        var wantedStuck = new HashSet<string>(StringComparer.Ordinal);

        var devices = new List<Device>();
        var known = new HashSet<string>(StringComparer.Ordinal);
        foreach (var d in _storage.GetDevices())
        {
            known.Add(d.Id);
            if (d.Status == "revoked") _healthCache.Forget(d.Id);
            else devices.Add(d);
        }
        // A deleted tablet must not leave its last reading behind for the life of the process.
        _healthCache.KeepOnly(known);

        // Poll the fleet a few at a time. One tablet after another would cost a full timeout per
        // sleeping tablet, and a large fleet would then never finish inside one interval.
        var readings = await PollHealthAsync(devices, settings, cancel);

        // After a restart no tablet has reconnected yet, so every one of them looks stuck. Reviving
        // them here would mean a fleet-wide reboot after ordinary maintenance. Read their health,
        // but leave them alone until they have had time to come back.
        var healingAllowed = settings.AutoHeal && DateTime.UtcNow - _startedUtc >= StartupGrace;

        foreach (var (d, health) in readings)
        {
            _healthCache.Set(d.Id, health);

            // Off the network entirely (switched off, out of Wi-Fi range, wrong address). Nothing
            // can be done from here; the "tablet off air" alert already covers it.
            if (!health.Reachable) continue;

            // The tablet answers its own API but is not talking to us. That is the signature of a
            // stuck WebView, and it is exactly the case we can fix remotely.
            if (online.Contains(d.Id))
            {
                _healthCache.ClearHealAttempts(d.Id);
            }
            else if (healingAllowed && IsAwayLongEnough(d, settings))
            {
                var healed = await TryHeal(d, settings, cancel);
                if (alertsOn)
                {
                    var id = "stuck:" + d.Id;
                    wantedStuck.Add(id);
                    // Say what is actually happening: after several attempts we stop trying, and
                    // then the operator is the only one who can fix it.
                    var detail = healed
                        ? "Планшет отвечает по сети, но не выходит на связь с сервисом. Выполняется автолечение."
                        : "Планшет отвечает по сети, но не выходит на связь с сервисом. Автолечение не помогло, нужен осмотр планшета.";
                    if (_alerts.Raise(id, "stuck", healed ? "warn" : "error",
                            "Планшет завис: " + d.Name, detail, DateTime.UtcNow, d.Id, d.Name))
                        changed = true;
                }
            }

            if (!alertsOn) continue;

            if (health.BatteryPercent is { } battery && battery <= settings.BatteryWarnPercent && health.Charging != true)
            {
                var id = "battery:" + d.Id;
                wantedBattery.Add(id);
                // Only claim the tablet is not charging when the tablet actually said so.
                var detail = health.Charging == false
                    ? "Планшет не заряжается. Проверьте кабель или блок питания."
                    : "Проверьте, подключено ли зарядное устройство.";
                if (_alerts.Raise(id, "battery", "warn",
                        "Низкий заряд планшета: " + d.Name + " (" + battery + "%)",
                        detail, DateTime.UtcNow, d.Id, d.Name))
                    changed = true;
            }

            if (health.StorageFreePercent is { } free && free <= settings.StorageWarnPercent)
            {
                var id = "storage:" + d.Id;
                wantedStorage.Add(id);
                if (_alerts.Raise(id, "storage", "warn",
                        "Мало места на планшете: " + d.Name + " (свободно " + free + "%)",
                        "Очистите кэш планшета или удалите лишние приложения.",
                        DateTime.UtcNow, d.Id, d.Name))
                    changed = true;
            }
        }

        if (alertsOn)
        {
            foreach (var id in _alerts.IdsOfKind("battery"))
                if (!wantedBattery.Contains(id) && _alerts.Clear(id)) changed = true;
            foreach (var id in _alerts.IdsOfKind("storage"))
                if (!wantedStorage.Contains(id) && _alerts.Clear(id)) changed = true;
            foreach (var id in _alerts.IdsOfKind("stuck"))
                if (!wantedStuck.Contains(id) && _alerts.Clear(id)) changed = true;
        }

        return changed;
    }

    /// <summary>Рассказать оператору о повреждённых файлах данных, отложенных хранилищем.</summary>
    private void ReportCorruptFiles()
    {
        while (_storage.CorruptFiles.TryDequeue(out var item))
        {
            var text = "Файл данных «" + item.File + "» повреждён и отложен как «" + item.Backup +
                       "» (" + item.Reason + "). Его содержимое сейчас пустое. " +
                       "Файл сохранён в каталоге данных, из него можно восстановить записи.";
            _alerts.Raise("corrupt:" + item.File, "storage", "error",
                "Повреждён файл данных: " + item.File, text, DateTime.UtcNow);
        }
    }

    private bool ClearTabletAlerts()
    {
        var cleared = false;
        foreach (var kind in new[] { "battery", "storage", "stuck" })
            foreach (var id in _alerts.IdsOfKind(kind)) cleared |= _alerts.Clear(id);
        return cleared;
    }

    // Enough to keep a fleet check short without flooding a small office switch.
    // Сколько планшетов опрашивается одновременно. Считается от худшего случая: весь парк
    // выключен, и каждый ответ стоит полного времени ожидания. Оператор вправе поставить его
    // до тридцати секунд, значит при двухстах планшетах и восьми за раз проход занимал бы
    // 200 / 8 * 30 = 750 секунд, вчетверо дольше своего же пятиминутного шага: проходы шли бы
    // встык, а опрос никогда не заканчивался. При тридцати двух худший случай укладывается в
    // 210 секунд. Для сервера это тридцать два коротких запроса в локальную сеть, не нагрузка.
    private const int MaxParallelHealthChecks = 32;

    /// <summary>Read health from every tablet at once, a few at a time.</summary>
    private async Task<List<(Device Device, KioskHealth Health)>> PollHealthAsync(
        List<Device> devices, KioskControlSettings settings, CancellationToken cancel)
    {
        using var gate = new SemaphoreSlim(MaxParallelHealthChecks);
        var tasks = devices.Select(async d =>
        {
            await gate.WaitAsync(cancel);
            try { return (Device: d, Health: await _kiosk.GetHealthAsync(d, settings, cancel)); }
            finally { gate.Release(); }
        });
        return (await Task.WhenAll(tasks)).ToList();
    }

    /// <summary>
    /// A tablet is worth reviving only once it has really been away. A tablet that has never
    /// connected has no "since", so it is judged from when it was enrolled instead: an activated
    /// tablet that never showed up is exactly the case an operator wants fixed.
    /// </summary>
    private static bool IsAwayLongEnough(Device device, KioskControlSettings settings)
    {
        var since = device.LastSeenUtc == default ? device.EnrolledUtc : device.LastSeenUtc;
        if (since == default) return false;
        return DateTime.UtcNow - since >= TimeSpan.FromMinutes(settings.AutoHealAfterMinutes);
    }

    // A tablet that does not come back after this many attempts has something wrong with it that
    // no remote command fixes (wrong start URL, broken WebView, cleared token). Rebooting it every
    // few minutes forever would only keep it unusable, so we stop and tell the operator instead.
    private const int MaxHealAttempts = 3;

    /// <summary>
    /// Revive a tablet that answers its own API but has stopped talking to us: usually a stuck
    /// WebView. Restart the app first; a second attempt reboots the tablet (which needs Device
    /// Owner). Returns false once we have given up on it.
    /// </summary>
    private async Task<bool> TryHeal(Device device, KioskControlSettings settings, CancellationToken cancel)
    {
        var attempt = _healthCache.HealAttempts(device.Id);
        if (attempt >= MaxHealAttempts) return false;

        // One attempt per interval, so a tablet that is restarting is not hit again and again.
        // Nothing was tried on this pass, but we have not given up either.
        if (!_healthCache.ShouldTryHeal(device.Id, TimeSpan.FromMinutes(settings.AutoHealAfterMinutes))) return true;

        // The gentle fix first; if the tablet is still away next time, reboot it.
        var reboot = attempt > 0;
        var res = reboot
            ? await _kiosk.SendAsync(device, "/api/reboot", settings: settings, cancel: cancel)
            : await _kiosk.SendAsync(device, "/api/restart-ui", settings: settings, cancel: cancel);

        // Deliberately not "error": a failed heal is expected when Device Owner is off, and logging
        // it as an error would feed the error-burst alert with the monitor's own output.
        _log.Add("warn", "control",
            (reboot ? "Автолечение: перезагрузка планшета " : "Автолечение: перезапуск приложения на планшете ") +
            device.Name + (res.Ok ? "" : " не удалось: " + res.Error),
            null, device.Id, device.Name);

        if (attempt + 1 >= MaxHealAttempts)
            _log.Add("warn", "control",
                "Автолечение не помогло, планшет требует осмотра: " + device.Name, null, device.Id, device.Name);
        return true;
    }

    /// <summary>
    /// The same device token driving more than one screen. That means a document carrying the
    /// signer's personal data renders on every one of them, so the operator must know: the fix is
    /// to revoke the token and enrol the extra tablet properly.
    /// </summary>
    private bool CheckDuplicateConnections()
    {
        var changed = false;
        var names = _storage.GetDevices().ToDictionary(d => d.Id, d => d.Name);
        var wanted = new HashSet<string>(StringComparer.Ordinal);

        foreach (var deviceId in _tracker.DuplicateDeviceIds())
        {
            var id = "duplicate:" + deviceId;
            wanted.Add(id);
            var name = names.TryGetValue(deviceId, out var n) ? n : deviceId;
            var count = _tracker.ConnectionCount(deviceId);
            if (_alerts.Raise(id, "duplicate", "error",
                    "Один код используется на нескольких экранах: " + name,
                    "Подключений с этим кодом: " + count + ". Документ с персональными данными будет показан на всех. " +
                    "Заблокируйте планшет в разделе «Планшеты» и активируйте лишний заново.",
                    DateTime.UtcNow, deviceId, name))
            {
                changed = true;
                _log.Add("warn", "alerts", "Дублирующее подключение планшета: " + name, null, deviceId, name);
            }
        }

        foreach (var id in _alerts.IdsOfKind("duplicate"))
            if (!wanted.Contains(id) && _alerts.Clear(id)) changed = true;

        return changed;
    }

    private bool CheckErrorBurst(AlertSettings settings)
    {
        var window = TimeSpan.FromMinutes(settings.ErrorWindowMinutes);
        var count = _log.CountErrorsSince(window);
        const string id = "errors:burst";

        if (count >= settings.ErrorCount)
        {
            var raised = _alerts.Raise(id, "errors", "error",
                "Много ошибок: " + count + " за " + settings.ErrorWindowMinutes + " мин",
                "Порог " + settings.ErrorCount + " ошибок за " + settings.ErrorWindowMinutes + " минут превышен. Откройте вкладку «Логи».",
                DateTime.UtcNow);
            return raised;
        }
        return _alerts.Clear(id);
    }

    private static string Describe(TimeSpan t)
    {
        if (t.TotalMinutes < 60) return (int)t.TotalMinutes + " мин";
        if (t.TotalHours < 24) return (int)t.TotalHours + " ч " + t.Minutes + " мин";
        return (int)t.TotalDays + " дн " + t.Hours + " ч";
    }
}
