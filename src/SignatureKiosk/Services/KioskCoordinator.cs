using System.Collections.Concurrent;
using System.Security.Cryptography;
using Microsoft.AspNetCore.SignalR;
using SignatureKiosk.Hubs;
using SignatureKiosk.Models;

namespace SignatureKiosk.Services;

/// <summary>
/// Central place that mutates screen state and pushes commands to kiosks.
/// A "target" is one of: "all" · "group:{groupId}" · "device:{deviceId}".
/// </summary>
public class KioskCoordinator
{
    public const string AllTarget = "all";

    private readonly IHubContext<KioskHub> _hub;
    private readonly StorageService _storage;
    private readonly DeviceTracker _tracker;

    public KioskCoordinator(IHubContext<KioskHub> hub, StorageService storage, DeviceTracker tracker)
    {
        _hub = hub;
        _storage = storage;
        _tracker = tracker;
    }

    public static string DeviceGroup(string deviceId) => "dev:" + deviceId;
    public static string RoomGroup(string groupId) => "grp:" + groupId;

    private enum Kind { All, Group, Device, Devices }
    private static (Kind kind, string id) Parse(string? target)
    {
        if (string.IsNullOrWhiteSpace(target) || target == AllTarget) return (Kind.All, "");
        if (target.StartsWith("group:", StringComparison.Ordinal)) return (Kind.Group, target["group:".Length..]);
        if (target.StartsWith("device:", StringComparison.Ordinal)) return (Kind.Device, target["device:".Length..]);
        // Произвольный набор планшетов: список приходит отдельным параметром, а не в строке
        // адресата, потому что в строке он был бы неограниченной длины.
        if (string.Equals(target, "devices", StringComparison.Ordinal)) return (Kind.Devices, "");
        return (Kind.Device, target); // bare id → device
    }

    /// <summary>
    /// Resolve a target to the concrete set of device ids from storage (the source of truth
    /// for group membership), so targeting reflects the current device configuration without
    /// waiting for a reconnect. "All" resolves to the currently online devices.
    /// </summary>
    private List<string> DeviceIds(Kind kind, string id, IReadOnlyList<string>? chosen = null) => kind switch
    {
        Kind.All => _tracker.OnlineDeviceIds().ToList(),
        Kind.Group => _storage.GetDevices().Where(d => d.GroupIds.Contains(id)).Select(d => d.Id).ToList(),
        // Только те планшеты, которые действительно существуют: удалённый из набора просто
        // выпадает, а остальные продолжают получать рекламу.
        Kind.Devices => _storage.GetDevices().Where(d => (chosen ?? Array.Empty<string>()).Contains(d.Id)).Select(d => d.Id).ToList(),
        _ => new List<string> { id }
    };

    // ---------- Build payloads ----------

    public SlidesPayload BuildSlidesPayload(KioskState state)
    {
        var images = _storage.GetImages().ToDictionary(i => i.Id, i => i.FileName);
        var urls = new List<string>();
        foreach (var imgId in state.PlaylistImageIds)
            if (images.TryGetValue(imgId, out var fileName))
                urls.Add("/media/" + fileName);
        return new SlidesPayload { Images = urls, IntervalSec = state.IntervalSec };
    }

    /// <summary>
    /// A signer session must not outlive the client. If a tablet is powered off (or crashes) in the
    /// middle of signing, its client-side idle timer never fires, so the server enforces its own
    /// ceiling: an abandoned document is dropped rather than shown to whoever comes next.
    /// </summary>
    // Deliberately generous: this is a backstop for a tablet that is gone (switched off, crashed,
    // taken away), not an idle timeout. A tablet that is still connected governs itself with the
    // operator-configured idle timeout, so a slow signer is never cut off mid-document.
    private static readonly TimeSpan SignerSessionMaxAge = TimeSpan.FromHours(2);

    private static bool IsExpired(KioskState state) =>
        state.Mode == "document" && state.DocumentSetUtc is { } set && DateTime.UtcNow - set > SignerSessionMaxAge;

    /// <summary>
    /// Clear every abandoned signer session, without waiting for the tablet to reconnect. A tablet
    /// that is switched off (or broken, or returned) mid-signing would otherwise leave the client's
    /// personal data at rest indefinitely. Returns how many were cleared.
    /// </summary>
    public int SweepExpiredSessions()
    {
        // Only tablets that are NOT connected: an online tablet is showing the document to someone
        // right now and manages its own return-to-ads. Sweeping it would wipe the session under an
        // active signer, whose signature would then be refused.
        var online = _tracker.OnlineDeviceIds();
        var candidates = _storage.GetStates().Devices
            .Where(kv => !online.Contains(kv.Key) && IsExpired(kv.Value))
            .Select(kv => kv.Key).ToList();
        if (candidates.Count == 0) return 0;   // never rewrite the file for nothing

        return _storage.MutateStates(states =>
        {
            var n = 0;
            foreach (var deviceId in candidates)
            {
                if (!states.Devices.TryGetValue(deviceId, out var s) || !IsExpired(s)) continue;
                s.Mode = "slides";
                s.Fields.Clear();
                s.DynamicCheckboxes.Clear();
                s.CheckboxStates.Clear();
                s.GroupSelections.Clear();
                s.DocumentSetUtc = null;
                n++;
            }
            return n;
        });
    }

    public CurrentCommand BuildCurrentCommand(string deviceId)
    {
        var state = _storage.ResolveState(deviceId);
        if (IsExpired(state))
        {
            // Abandoned session: clear it now and show ads instead of the previous client's data.
            ClearSignerSession(deviceId);
            state = _storage.ResolveState(deviceId);
        }
        if (state.Mode == "document")
        {
            // Resolve with THIS device's own signer data only, so a tablet never receives
            // another signer's fields or checkboxes.
            var doc = DocumentTemplating.Resolve(_storage.GetDocument(), state.Fields, state.DynamicCheckboxes,
                state.GroupSelections, state.CheckboxStates, state.Texts, state.GroupOptions);
            return new CurrentCommand { Mode = "document", Document = doc };
        }
        return new CurrentCommand { Mode = "slides", Slides = BuildSlidesPayload(state) };
    }

    // ---------- State mutation ----------

    /// <summary>Set a device override's mode, signer fields and per-signer checkboxes (creating it from the default when absent).</summary>
    private static void SetDeviceState(StateStore states, IEnumerable<string> deviceIds, string mode,
        Dictionary<string, string> fields, List<DocCheckbox> checkboxes,
        Dictionary<string, bool>? checkboxStates = null, Dictionary<string, string>? groupSelections = null,
        Dictionary<string, string>? texts = null,
        Dictionary<string, List<DocGroupOption>>? groupOptions = null)
    {
        foreach (var deviceId in deviceIds)
        {
            if (!states.Devices.TryGetValue(deviceId, out var s))
            {
                s = states.Default.Clone();
                states.Devices[deviceId] = s;
            }
            s.Mode = mode;
            s.Fields = new Dictionary<string, string>(fields);
            s.DynamicCheckboxes = checkboxes.Select(c => new DocCheckbox { Key = c.Key, Label = c.Label, Required = c.Required, Checked = c.Checked }).ToList();
            s.CheckboxStates = checkboxStates is null ? new Dictionary<string, bool>() : new Dictionary<string, bool>(checkboxStates);
            s.GroupSelections = groupSelections is null ? new Dictionary<string, string>() : new Dictionary<string, string>(groupSelections);
            s.Texts = texts is null ? new Dictionary<string, string>() : new Dictionary<string, string>(texts);
            s.GroupOptions = groupOptions is null
                ? new Dictionary<string, List<DocGroupOption>>()
                : groupOptions.ToDictionary(kv => kv.Key,
                    kv => kv.Value.Select(o => new DocGroupOption { Key = o.Key, Label = o.Label }).ToList());
            s.DocumentSetUtc = mode == "document" ? DateTime.UtcNow : null;
        }
    }

    // ---------- Public operations ----------

    /// <summary>
    /// Publish advertising slides to a target (all / group / device).
    /// Hard rule: a document always has priority over ads. Publishing ads never
    /// interrupts a tablet that is currently showing a document; its playlist is
    /// updated in storage so the latest ads appear once it is returned to slides,
    /// but it is not flipped and receives no ShowSlides push. Only the explicit
    /// "return to slides" action moves a tablet out of document mode.
    /// </summary>
    public async Task SaveAndShowSlidesAsync(string target, List<string> imageIds, int intervalSec,
        IReadOnlyList<string>? deviceIds = null)
    {
        intervalSec = Math.Clamp(intervalSec, 1, 3600);
        var (kind, id) = Parse(target);
        var playlist = new List<string>(imageIds);

        // Resolve the concrete device set outside the state lock (these read other files):
        // "all" resolves to the currently online devices, group/device to storage membership.
        var targets = DeviceIds(kind, id, deviceIds);

        // Atomically update stored state and, from that same consistent snapshot, decide who
        // should receive the slides now: everyone in scope except tablets currently showing a
        // document (a document always has priority over ads).
        var recipients = _storage.MutateStates(states =>
        {
            if (kind == Kind.All)
            {
                states.Default.Mode = "slides";
                states.Default.PlaylistImageIds = new List<string>(playlist);
                states.Default.IntervalSec = intervalSec;
                foreach (var s in states.Devices.Values)
                {
                    s.PlaylistImageIds = new List<string>(playlist);
                    s.IntervalSec = intervalSec;
                    if (s.Mode != "document") s.Mode = "slides";
                }
            }
            else
            {
                foreach (var deviceId in targets)
                {
                    if (!states.Devices.TryGetValue(deviceId, out var s))
                    {
                        s = states.Default.Clone();
                        states.Devices[deviceId] = s;
                    }
                    s.PlaylistImageIds = new List<string>(playlist);
                    s.IntervalSec = intervalSec;
                    if (s.Mode != "document") s.Mode = "slides";
                }
            }
            return targets.Where(did => !IsShowingDocument(states, did)).ToList();
        });

        var payload = BuildSlidesPayload(new KioskState { PlaylistImageIds = playlist, IntervalSec = intervalSec });
        foreach (var deviceId in recipients)
            await _hub.Clients.Group(DeviceGroup(deviceId)).SendAsync("ShowSlides", payload);
    }

    private static bool IsShowingDocument(StateStore states, string deviceId) =>
        states.Devices.TryGetValue(deviceId, out var s) && s.Mode == "document";

    /// <summary>
    /// Show the signing document on exactly ONE tablet, filling {{tags}} with <paramref name="fields"/>
    /// and injecting any per-signer <paramref name="checkboxes"/>. A document is never shown to more
    /// than one tablet: the signer data lives only on this device, so it can never reach anyone else.
    /// </summary>
    // Signer data is stored per device and re-read on every hub connect, sign and scan-stop, so it
    // must stay small. These bounds are far above any real consent form.
    private const int MaxFields = 100;
    private const int MaxFieldNameLength = 200;
    private const int MaxFieldValueLength = 4000;
    private const int MaxDynamicCheckboxes = 100;
    private const int MaxCheckboxLabelLength = 2000;

    private static string Cut(string? s, int max) =>
        string.IsNullOrEmpty(s) ? "" : (s.Length <= max ? s : s[..max]);

    public async Task ShowDocumentAsync(string deviceId, IReadOnlyDictionary<string, string>? fields = null,
        IReadOnlyList<DocCheckbox>? checkboxes = null, IReadOnlyList<GroupSelectionDto>? groups = null)
    {
        var fieldMap = new Dictionary<string, string>();
        if (fields is not null)
            foreach (var kv in fields.Take(MaxFields))
                fieldMap[Cut(kv.Key, MaxFieldNameLength)] = Cut(kv.Value, MaxFieldValueLength);

        var template = _storage.GetDocument();
        // Имена, которые вообще есть в шаблоне. Чекбокс с известным именем не дописывается вниз
        // страницы, а задаёт состояние тому, который уже стоит в нужном месте документа.
        var known = DocumentTemplating.LiveKeys(template);

        var cbs = new List<DocCheckbox>();
        var states = new Dictionary<string, bool>(StringComparer.OrdinalIgnoreCase);
        // Тексты для того, что уже стоит в документе: формулировка зависит от заказа, а место
        // в документе всегда одно и то же. Label заменяет текст целиком, LabelAppend дописывает
        // к тому, что уже стоит: внешняя система не обязана знать формулировку документа.
        var texts = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        var current = DocumentTemplating.CurrentTexts(template);
        void SetText(string name, string? replace, string? append)
        {
            var text = string.IsNullOrWhiteSpace(replace)
                ? (current.TryGetValue(name, out var have) ? have : "")
                : replace!;
            if (!string.IsNullOrWhiteSpace(append))
            {
                var tail = append!.Trim();
                // Пробел ставится не всегда: дописка, начинающаяся со знака препинания, должна
                // прилипнуть к предыдущему слову, иначе получится «НЕТ , не соблюдал».
                var glue = tail.Length > 0 && ",.;:!?)»".IndexOf(tail[0]) >= 0 ? "" : " ";
                text = (text.TrimEnd() + glue + tail).Trim();
            }
            if (!string.IsNullOrWhiteSpace(replace) || !string.IsNullOrWhiteSpace(append))
                texts[name] = Cut(text, MaxCheckboxLabelLength);
        }
        foreach (var c in (checkboxes ?? Array.Empty<DocCheckbox>()).Where(c => c is not null))
        {
            var key = DocumentTemplating.CleanKey(c.Key);
            if (key.Length > 0 && known.Contains(key))
            {
                states[key] = c.Checked;
                SetText(key, c.Label, c.LabelAppend);
                continue;
            }
            if (cbs.Count >= MaxDynamicCheckboxes) continue;
            cbs.Add(new DocCheckbox
            {
                Key = key,
                Label = Cut(c.Label, MaxCheckboxLabelLength),
                Required = c.Required,
                Checked = c.Checked
            });
        }

        var selections = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        var options = new Dictionary<string, List<DocGroupOption>>(StringComparer.OrdinalIgnoreCase);
        foreach (var g in (groups ?? Array.Empty<GroupSelectionDto>()).Where(g => g is not null).Take(MaxDynamicCheckboxes))
        {
            var key = DocumentTemplating.CleanKey(g.Key);
            if (key.Length == 0) continue;
            selections[key] = DocumentTemplating.CleanKey(g.Selected);
            SetText(key, g.Title, g.TitleAppend);
            // Варианты, присланные вместе с заказом. Если их прислали, они и есть список:
            // складывать их с теми, что в документе, значило бы показать клиенту два набора.
            var sent = new List<DocGroupOption>();
            foreach (var o in (g.Options ?? new List<DocGroupOption>()).Where(o => o is not null).Take(MaxDynamicCheckboxes))
            {
                var ok = DocumentTemplating.CleanKey(o.Key);
                if (ok.Length == 0) continue;
                SetText(key + "/" + ok, o.Label, o.LabelAppend);
                sent.Add(new DocGroupOption { Key = ok, Label = Cut(o.Label, MaxCheckboxLabelLength) });
            }
            if (sent.Count > 0) options[key] = sent;
        }

        _storage.MutateStates(st => SetDeviceState(st, new[] { deviceId }, "document", fieldMap, cbs, states, selections, texts, options));

        var doc = DocumentTemplating.Resolve(template, fieldMap, cbs, selections, states, texts, options);
        await _hub.Clients.Group(DeviceGroup(deviceId)).SendAsync("ShowDocument", doc);
        // На планшете сменился документ: тот, кто смотрит, должен перечитать его заново, иначе
        // рисовал бы старый документ поверх нового состояния.
        await NotifyWatchersReloadAsync(deviceId);
        // И админка должна узнать, что документ поехал: отправить его могла внешняя система, а
        // не оператор, и тогда он об этом иначе не узнает вовсе.
        var dev = _storage.GetDevice(deviceId);
        await _hub.Clients.Group("admins").SendAsync("DocumentShown", new { deviceId, name = dev?.Name ?? deviceId });
        await NotifyAdminsDevicesAsync();
    }

    /// <summary>Return one tablet to advertising and clear its signer data, then push its slides.</summary>
    public async Task ReturnToSlidesAsync(string deviceId)
    {
        ClearSignerSession(deviceId);
        var payload = BuildSlidesPayload(_storage.ResolveState(deviceId));
        await _hub.Clients.Group(DeviceGroup(deviceId)).SendAsync("ShowSlides", payload);
        await NotifyWatchersReloadAsync(deviceId);
    }

    /// <summary>
    /// Clear a device's signer data and return it to slides mode in storage WITHOUT pushing a
    /// command (the tablet is showing its local thank-you screen). This closes the window where a
    /// reconnect right after signing could redisplay the just-signed document with its data.
    /// </summary>
    public void ClearSignerSession(string deviceId)
    {
        _storage.MutateStates(states =>
        {
            // Always write a per-device slides override (creating it if needed) so this device
            // returns to ads regardless of what the shared default is set to.
            if (!states.Devices.TryGetValue(deviceId, out var s))
            {
                s = states.Default.Clone();
                states.Devices[deviceId] = s;
            }
            s.Mode = "slides";
            s.Fields.Clear();
            s.DynamicCheckboxes.Clear();
            s.CheckboxStates.Clear();
            s.GroupSelections.Clear();
            s.DocumentSetUtc = null;
        });
    }

    /// <summary>
    /// Ask ONE tablet to open its camera and scan a barcode / QR code. Scanning is a transient
    /// screen: it is not stored as a mode, so a reconnect returns the tablet to its normal screen
    /// and no scan session can outlive the tablet's session.
    /// </summary>
    public Task StartScanAsync(string deviceId) =>
        _hub.Clients.Group(DeviceGroup(deviceId)).SendAsync("StartScan");

    /// <summary>Cancel scanning on one tablet and return it to whatever it should be showing.</summary>
    public async Task StopScanAsync(string deviceId)
    {
        await _hub.Clients.Group(DeviceGroup(deviceId)).SendAsync("StopScan");
        var cmd = BuildCurrentCommand(deviceId);
        if (cmd.Mode == "document")
            await _hub.Clients.Group(DeviceGroup(deviceId)).SendAsync("ShowDocument", cmd.Document);
        else
            await _hub.Clients.Group(DeviceGroup(deviceId)).SendAsync("ShowSlides", cmd.Slides);
    }

    /// <summary>Tell admins the alert set changed so the bell and the alerts page update live.</summary>
    public Task NotifyAdminsAlertsAsync() => _hub.Clients.Group("admins").SendAsync("AlertsChanged");

    /// <summary>Tell admins a scan arrived so the scan page updates live.</summary>
    public Task NotifyAdminsScanAsync(ScanRecord rec) =>
        _hub.Clients.Group("admins").SendAsync("ScanReceived", new
        {
            id = rec.Id,
            createdUtc = rec.CreatedUtc,
            code = rec.Code,
            format = rec.Format,
            deviceId = rec.DeviceId,
            deviceName = rec.DeviceName,
            workstationName = rec.WorkstationName
        });

    /// <summary>Flash an identifying marker on one device; returns the code shown so the operator can match it.</summary>
    public async Task<string> IdentifyAsync(string deviceId)
    {
        var code = RandomNumberGenerator.GetInt32(100, 1000).ToString();
        var dev = _storage.GetDevice(deviceId);
        await _hub.Clients.Group(DeviceGroup(deviceId)).SendAsync("Identify", new { code, name = dev?.Name ?? deviceId });
        return code;
    }

    // ---------- Admin notifications ----------

    public Task NotifyAdminsDevicesAsync() => _hub.Clients.Group("admins").SendAsync("DevicesChanged");

    // ---------- Наблюдение за экраном планшета ----------
    // Кто за каким планшетом смотрит. Нужно, чтобы планшет рассказывал о себе только тогда,
    // когда его действительно смотрят: иначе он тратил бы батарею и канал круглые сутки.
    // Хранится в памяти и только на время соединений: наблюдение не оставляет следов.
    private readonly ConcurrentDictionary<string, HashSet<string>> _watchers = new();

    /// <summary>
    /// Оператор начал или перестал смотреть за планшетом. Планшету сообщается только на границе:
    /// когда появился первый наблюдатель и когда ушёл последний.
    /// </summary>
    public async Task SetWatchAsync(string deviceId, string connectionId, bool on)
    {
        if (string.IsNullOrEmpty(deviceId) || string.IsNullOrEmpty(connectionId)) return;

        bool changed;
        var set = _watchers.GetOrAdd(deviceId, _ => new HashSet<string>(StringComparer.Ordinal));
        lock (set)
        {
            var was = set.Count > 0;
            if (on) set.Add(connectionId); else set.Remove(connectionId);
            changed = was != (set.Count > 0);
            if (set.Count == 0) _watchers.TryRemove(deviceId, out _);
        }
        if (!changed) return;
        await _hub.Clients.Group(DeviceGroup(deviceId)).SendAsync(on ? "WatchOn" : "WatchOff");
    }

    /// <summary>Сказать наблюдателям, что показанное на планшете сменилось целиком.</summary>
    public Task NotifyWatchersReloadAsync(string deviceId) =>
        IsWatched(deviceId) ? _hub.Clients.Group("watch:" + deviceId).SendAsync("WatchReload") : Task.CompletedTask;

    /// <summary>Смотрит ли кто-нибудь за этим планшетом прямо сейчас.</summary>
    public bool IsWatched(string deviceId)
    {
        if (!_watchers.TryGetValue(deviceId, out var set)) return false;
        lock (set) return set.Count > 0;
    }

    public Task NotifyAdminsSignatureAsync(SignatureRecord rec) =>
        _hub.Clients.Group("admins").SendAsync("SignatureReceived", new
        {
            id = rec.Id,
            createdUtc = rec.CreatedUtc,
            documentTitle = rec.DocumentTitle,
            deviceId = rec.DeviceId,
            deviceName = rec.DeviceName,
            workstationName = rec.WorkstationName,
            checkedCount = rec.Items.Count(i => i is { Checked: true }),
            totalCount = rec.Items.Count
        });
}
