using System.Collections.Concurrent;

namespace SignatureKiosk.Services;

/// <summary>Tracks which devices currently have at least one live SignalR connection.</summary>
public class DeviceTracker
{
    private readonly ConcurrentDictionary<string, HashSet<string>> _connections = new();
    private readonly Dictionary<string, string> _ips = new();  // deviceId -> IP of its live connection
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
            return wasEmpty;
        }
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
