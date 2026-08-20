using System.Collections.Concurrent;
using System.Text.Json;
using SignatureKiosk.Models;

namespace SignatureKiosk.Services;

/// <summary>
/// Operational log of failures the operator needs to see: server warnings/errors and problems
/// reported by the tablets. Kept in memory (fast, bounded) and mirrored to a file so the history
/// survives a restart, which matters for a 24/7 kiosk fleet.
/// </summary>
public class EventLogService
{
    private const int MaxEntries = 2000;          // in-memory ring; oldest fall out
    private const long MaxFileBytes = 4 * 1024 * 1024;

    private readonly ConcurrentQueue<LogEntry> _entries = new();
    private readonly object _fileLock = new();
    private readonly string _path;
    private long _seq;

    public EventLogService(StorageService storage)
    {
        _path = Path.Combine(storage.DataDir, "events.log");
        LoadTail();
    }

    /// <summary>Record one entry. Never throws: logging must not break the operation being logged.</summary>
    public LogEntry Add(string level, string source, string message, string? detail = null,
        string? deviceId = null, string? deviceName = null)
    {
        var entry = new LogEntry
        {
            Id = Interlocked.Increment(ref _seq),
            Utc = DateTime.UtcNow,
            Level = string.IsNullOrWhiteSpace(level) ? "error" : level.Trim().ToLowerInvariant(),
            Source = source ?? "",
            Message = Trim(message, 2000) ?? "",
            Detail = Trim(detail, 8000),
            DeviceId = deviceId,
            DeviceName = deviceName
        };

        _entries.Enqueue(entry);
        while (_entries.Count > MaxEntries) _entries.TryDequeue(out _);

        try
        {
            lock (_fileLock)
            {
                RotateIfNeeded();
                File.AppendAllText(_path, JsonSerializer.Serialize(entry) + Environment.NewLine);
            }
        }
        catch { /* a full or read-only disk must not take the app down */ }

        return entry;
    }

    /// <summary>Newest first, optionally filtered by level and a free-text query.</summary>
    public List<LogEntry> List(string? level = null, string? query = null, int limit = 300)
    {
        IEnumerable<LogEntry> items = _entries.ToArray().Reverse();
        if (!string.IsNullOrWhiteSpace(level) && level != "all")
            items = items.Where(e => string.Equals(e.Level, level, StringComparison.OrdinalIgnoreCase));
        if (!string.IsNullOrWhiteSpace(query))
        {
            var q = query.Trim();
            items = items.Where(e =>
                (e.Message?.Contains(q, StringComparison.OrdinalIgnoreCase) ?? false) ||
                (e.Source?.Contains(q, StringComparison.OrdinalIgnoreCase) ?? false) ||
                (e.Detail?.Contains(q, StringComparison.OrdinalIgnoreCase) ?? false) ||
                (e.DeviceName?.Contains(q, StringComparison.OrdinalIgnoreCase) ?? false) ||
                // Идентификатор планшета виден на его карточке, и оператор ищет по нему, когда
                // нужно разобрать историю конкретного планшета. Без этого поиск по скопированному
                // идентификатору не находил ничего.
                (e.DeviceId?.Contains(q, StringComparison.OrdinalIgnoreCase) ?? false));
        }
        return items.Take(Math.Clamp(limit, 1, MaxEntries)).ToList();
    }

    public int Count => _entries.Count;

    /// <summary>How many errors happened in the last <paramref name="window"/> (for burst alerting).</summary>
    public int CountErrorsSince(TimeSpan window)
    {
        var from = DateTime.UtcNow - window;
        return _entries.ToArray().Count(e =>
            e.Utc >= from && string.Equals(e.Level, "error", StringComparison.OrdinalIgnoreCase));
    }

    /// <summary>Drop everything (operator action after the issues have been dealt with).</summary>
    public void Clear()
    {
        while (_entries.TryDequeue(out _)) { }
        try { lock (_fileLock) if (File.Exists(_path)) File.Delete(_path); } catch { /* ignore */ }
    }

    private static string? Trim(string? s, int max) =>
        s is null ? null : (s.Length <= max ? s : s[..max] + "…");

    private void RotateIfNeeded()
    {
        var fi = new FileInfo(_path);
        if (!fi.Exists || fi.Length < MaxFileBytes) return;
        var bak = _path + ".1";
        if (File.Exists(bak)) File.Delete(bak);
        File.Move(_path, bak);
    }

    /// <summary>Reload the most recent entries from disk so the tab is not empty after a restart.</summary>
    private void LoadTail()
    {
        try
        {
            if (!File.Exists(_path)) return;
            // Stream the file and keep only the tail: an oversized log (an older build, a restored
            // backup) must not pull hundreds of MB into memory during startup.
            var tail = new Queue<string>(MaxEntries);
            foreach (var line in File.ReadLines(_path))
            {
                if (string.IsNullOrWhiteSpace(line)) continue;
                if (tail.Count == MaxEntries) tail.Dequeue();
                tail.Enqueue(line);
            }
            foreach (var line in tail)
            {
                try
                {
                    var e = JsonSerializer.Deserialize<LogEntry>(line);
                    if (e is null) continue;
                    e.Id = Interlocked.Increment(ref _seq);
                    _entries.Enqueue(e);
                }
                catch { /* skip a corrupt line */ }
            }
        }
        catch { /* an unreadable log file must not stop startup */ }
    }
}
