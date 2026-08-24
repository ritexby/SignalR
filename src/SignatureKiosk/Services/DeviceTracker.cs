using System.Collections.Concurrent;

namespace SignatureKiosk.Services;

/// <summary>Tracks which devices currently have at least one live SignalR connection.</summary>
public class DeviceTracker
{
    private readonly ConcurrentDictionary<string, HashSet<string>> _connections = new();
    private readonly Dictionary<string, string> _ips = new();  // deviceId -> IP of its live connection
    // Which build of the kiosk page the tablet is actually running. A tablet whose WebView has not
    // reloaded since an older deploy keeps working but silently ignores anything newer, so the
    // operator has to be able to see it.
    private readonly Dictionary<string, string> _appVersions = new();
    private readonly object _lock = new();

    /// <summary>Register a connection for a device. Returns true if the device just came online.</summary>
    public bool Add(string deviceId, string connectionId, string? ip = null)
    {
        lock (_lock)
        {
            if (!_connections.TryGetValue(deviceId, out var set))
            {
                set = new HashSet<string>();
                _connections[deviceId] = set;
            }
            bool wasEmpty = set.Count == 0;
            set.Add(connectionId);
            if (!string.IsNullOrWhiteSpace(ip)) _ips[deviceId] = ip;
            // A reconnect must not keep a version reported by a previous page load: the tablet
            // tells us again right after registering, or it is on a page too old to say.
            _appVersions.Remove(deviceId);
            return wasEmpty;
        }
    }

    /// <summary>How many live connections a device token currently has. More than one means the
    /// same token is driving several screens, which the operator is alerted about: a document
    /// carrying personal data would render on every one of them.</summary>
    public int ConnectionCount(string deviceId)
    {
        lock (_lock) return _connections.TryGetValue(deviceId, out var set) ? set.Count : 0;
    }

    /// <summary>Номера живых соединений планшета. Нужны, чтобы разорвать их поимённо.</summary>
    public List<string> ConnectionIds(string deviceId)
    {
        lock (_lock) return _connections.TryGetValue(deviceId, out var set) ? set.ToList() : new List<string>();
    }

    /// <summary>Device ids currently connected more than once.</summary>
    public List<string> DuplicateDeviceIds()
    {
        lock (_lock) return _connections.Where(kv => kv.Value.Count > 1).Select(kv => kv.Key).ToList();
    }

    /// <summary>Remove a connection. Returns true if the device just went offline.</summary>
    public bool Remove(string deviceId, string connectionId)
    {
        lock (_lock)
        {
            if (_connections.TryGetValue(deviceId, out var set))
            {
                set.Remove(connectionId);
                if (set.Count == 0)
                {
                    _connections.TryRemove(deviceId, out _);
                    _ips.Remove(deviceId);
                    _appVersions.Remove(deviceId);
                    return true;
                }
            }
            return false;
        }
    }

    /// <summary>The current IP of each online device's live connection.</summary>
    public Dictionary<string, string> OnlineIps()
    {
        lock (_lock) return new Dictionary<string, string>(_ips);
    }

    /// <summary>Record the page build a tablet reported just after registering.</summary>
    public void SetAppVersion(string deviceId, string appVersion)
    {
        var v = appVersion.Trim();
        if (v.Length > 32) v = v[..32];
        lock (_lock) if (_connections.ContainsKey(deviceId)) _appVersions[deviceId] = v;
    }

    /// <summary>The kiosk page build each online tablet reported when it connected.</summary>
    public Dictionary<string, string> OnlineAppVersions()
    {
        lock (_lock) return new Dictionary<string, string>(_appVersions);
    }

    public bool IsOnline(string deviceId)
    {
        lock (_lock)
        {
            return _connections.TryGetValue(deviceId, out var set) && set.Count > 0;
        }
    }

    public HashSet<string> OnlineDeviceIds()
    {
        lock (_lock)
        {
            return new HashSet<string>(_connections.Keys);
        }
    }
}
