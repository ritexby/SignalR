using System.Collections.Concurrent;
using SignatureKiosk.Models;

namespace SignatureKiosk.Services;

/// <summary>
/// Raises and clears operator alerts. An alert is keyed by its cause (one per tablet going off air,
/// one for an error burst), so a persistent problem produces a single standing alert rather than a
/// stream of duplicates. Alerts live in memory: they describe the situation right now, and the
/// underlying facts (last seen, errors) survive restarts in devices.json and the event log.
/// </summary>
public class AlertService
{
    private readonly ConcurrentDictionary<string, Alert> _active = new();

    private const int MaxActive = 500;   // hard ceiling so alerts can never grow without bound

    /// <summary>Raise an alert, or refresh the existing one for the same cause. Returns true if the
    /// operator's view needs updating (newly raised, or its text changed).</summary>
    public bool Raise(string id, string kind, string severity, string title, string detail,
        DateTime sinceUtc, string? deviceId = null, string? deviceName = null)
        => Raise(id, kind, severity, title, detail, sinceUtc, out _, deviceId, deviceName);

    /// <summary>
    /// То же самое, но заодно говорит, впервые ли поднята эта тревога. Разница важна для журнала:
    /// текст тревоги про планшет не на связи содержит «Нет связи N мин» и меняется каждую минуту,
    /// поэтому запись «по любому изменению» давала строку в минуту на каждый выключенный планшет
    /// и за ночь вытесняла из журнала всё остальное.
    /// </summary>
    public bool Raise(string id, string kind, string severity, string title, string detail,
        DateTime sinceUtc, out bool впервые, string? deviceId = null, string? deviceName = null)
    {
        var changed = false;
        var новая = false;
        _active.AddOrUpdate(id,
            _ =>
            {
                changed = true;
                новая = true;
                return new Alert
                {
                    Id = id, Kind = kind, Severity = severity, Title = title, Detail = detail,
                    SinceUtc = sinceUtc, UpdatedUtc = DateTime.UtcNow,
                    DeviceId = deviceId, DeviceName = deviceName
                };
            },
            (_, existing) =>
            {
                // Same ongoing problem: keep SinceUtc and the acknowledged flag, but report a text
                // change so a dashboard left open does not keep showing stale wording ("5 ошибок"
                // when it is now 60). Replace the instance rather than mutating it, so a concurrent
                // reader never sees half of one version and half of another.
                changed = existing.Title != title || existing.Detail != detail || existing.Severity != severity;
                if (!changed) return existing;
                return new Alert
                {
                    Id = existing.Id, Kind = existing.Kind, Severity = severity,
                    Title = title, Detail = detail,
                    SinceUtc = existing.SinceUtc, UpdatedUtc = DateTime.UtcNow,
                    DeviceId = existing.DeviceId, DeviceName = deviceName ?? existing.DeviceName,
                    Acknowledged = existing.Acknowledged
                };
            });

        // Never let the set grow past the ceiling: drop the oldest entries first.
        if (_active.Count > MaxActive)
            foreach (var old in _active.Values.OrderBy(a => a.UpdatedUtc).Take(_active.Count - MaxActive).ToList())
                _active.TryRemove(old.Id, out _);

        впервые = новая;
        return changed;
    }

    /// <summary>Clear an alert once its cause is gone. Returns true if something was cleared.</summary>
    public bool Clear(string id) => _active.TryRemove(id, out _);

    /// <summary>Mark one alert as seen; it stays visible until the cause clears.</summary>
    public bool Acknowledge(string id)
    {
        if (!_active.TryGetValue(id, out var a)) return false;
        a.Acknowledged = true;
        return true;
    }

    public void AcknowledgeAll()
    {
        foreach (var a in _active.Values) a.Acknowledged = true;
    }

    /// <summary>Active alerts, most recent first, errors before warnings.</summary>
    public List<Alert> List() => _active.Values
        .OrderByDescending(a => a.Severity == "error")
        .ThenByDescending(a => a.UpdatedUtc)
        .ToList();

    public int UnacknowledgedCount => _active.Values.Count(a => !a.Acknowledged);

    /// <summary>Ids of the alerts currently raised for a given kind (used to clear stale ones).</summary>
    public IEnumerable<string> IdsOfKind(string kind) =>
        _active.Values.Where(a => a.Kind == kind).Select(a => a.Id).ToList();
}
