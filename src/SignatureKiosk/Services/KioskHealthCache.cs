using System.Collections.Concurrent;
using SignatureKiosk.Models;

namespace SignatureKiosk.Services;

/// <summary>
/// Last known health of each tablet, as read from its FreeKiosk API. In memory only: it describes
/// the situation right now, and a stale reading is worse than none after a restart.
/// </summary>
public class KioskHealthCache
{
    private readonly ConcurrentDictionary<string, KioskHealth> _health = new();
    private readonly ConcurrentDictionary<string, (DateTime Last, int Count)> _healAttempts = new();

    public void Set(string deviceId, KioskHealth health) => _health[deviceId] = health;

    public KioskHealth? Get(string deviceId) => _health.TryGetValue(deviceId, out var h) ? h : null;

    public Dictionary<string, KioskHealth> All() => new(_health);

    public void Forget(string deviceId)
    {
        _health.TryRemove(deviceId, out _);
        _healAttempts.TryRemove(deviceId, out _);
    }

    /// <summary>Drop every reading. Used when the control settings change, because readings taken
    /// through the old address or key no longer describe anything we can verify.</summary>
    public void Clear()
    {
        _health.Clear();
        // Счёт попыток лечения не сбрасывается вместе с показаниями. Показания устарели, а
        // «сдались после трёх попыток» это вывод о самом планшете: обнулять его при каждой смене
        // настроек значило бы выдавать заведомо сломанному планшету ещё три перезагрузки подряд.
    }

    /// <summary>Забыть, что этот планшет уже лечили. Оператор его осмотрел и хочет попробовать снова.</summary>
    public void ResetHealAttempts() => _healAttempts.Clear();

    /// <summary>Drop the readings of tablets that no longer exist.</summary>
    public void KeepOnly(ICollection<string> deviceIds)
    {
        foreach (var id in _health.Keys) if (!deviceIds.Contains(id)) _health.TryRemove(id, out _);
        foreach (var id in _healAttempts.Keys) if (!deviceIds.Contains(id)) _healAttempts.TryRemove(id, out _);
    }

    /// <summary>How many times we have already tried to revive this tablet without it coming back.</summary>
    public int HealAttempts(string deviceId) => _healAttempts.TryGetValue(deviceId, out var a) ? a.Count : 0;

    /// <summary>
    /// Take the right to try reviving a tablet now, so the same attempt is not repeated every
    /// 30 seconds while it boots. Counts the attempt at the same time, in one atomic step.
    /// </summary>
    public bool ShouldTryHeal(string deviceId, TimeSpan minInterval)
    {
        var now = DateTime.UtcNow;
        var taken = false;
        _healAttempts.AddOrUpdate(deviceId,
            _ => { taken = true; return (now, 1); },
            (_, current) =>
            {
                if (now - current.Last < minInterval) return current;
                taken = true;
                return (now, current.Count + 1);
            });
        return taken;
    }

    /// <summary>The tablet is back: forget that it ever needed reviving.</summary>
    public void ClearHealAttempts(string deviceId) => _healAttempts.TryRemove(deviceId, out _);
}
