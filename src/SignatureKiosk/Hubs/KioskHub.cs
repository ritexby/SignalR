using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.SignalR;
using SignatureKiosk.Models;
using SignatureKiosk.Services;

namespace SignatureKiosk.Hubs;

/// <summary>
/// Only authenticated connections may reach the hub: a tablet (device token) or the
/// admin page (login cookie). Identity and group membership come from the token -
/// never from client-supplied arguments.
/// </summary>
[Authorize]
public class KioskHub : Hub
{
    private const string DeviceItemKey = "deviceId";

    private readonly KioskCoordinator _coord;
    private readonly StorageService _storage;
    private readonly DeviceTracker _tracker;

    public KioskHub(KioskCoordinator coord, StorageService storage, DeviceTracker tracker)
    {
        _coord = coord;
        _storage = storage;
        _tracker = tracker;
    }

    private string? DeviceId => Context.User?.FindFirst("device_id")?.Value;
    private bool IsAdmin => Context.User?.FindFirst("role")?.Value == "admin";

    /// <summary>A tablet joins its channels and gets the screen it should render right now.</summary>
    public async Task<CurrentCommand> RegisterKiosk()
    {
        var deviceId = DeviceId;
        if (string.IsNullOrEmpty(deviceId)) throw new HubException("not a device connection");

        Context.Items[DeviceItemKey] = deviceId;
        await Groups.AddToGroupAsync(Context.ConnectionId, "kiosks");
        await Groups.AddToGroupAsync(Context.ConnectionId, KioskCoordinator.DeviceGroup(deviceId));

        var dev = _storage.GetDevice(deviceId);
        if (dev is not null)
            foreach (var groupId in dev.GroupIds)
                await Groups.AddToGroupAsync(Context.ConnectionId, KioskCoordinator.RoomGroup(groupId));

        var ip = ClientIp();
        _storage.TouchDevice(deviceId, ip);
        _tracker.Add(deviceId, Context.ConnectionId, ip);
        await _coord.NotifyAdminsDevicesAsync();

        return _coord.BuildCurrentCommand(deviceId);
    }

    /// <summary>The tablet's real IP. UseForwardedHeaders has already applied X-Forwarded-For,
    /// so this is the client behind the reverse proxy, not the proxy itself. IPv4-mapped IPv6
    /// addresses are normalised to plain dotted-quad.</summary>
    private string? ClientIp()
    {
        var ip = Context.GetHttpContext()?.Connection.RemoteIpAddress;
        if (ip is null) return null;
        if (ip.IsIPv4MappedToIPv6) ip = ip.MapToIPv4();
        return ip.ToString();
    }

    /// <summary>The admin page subscribes to live notifications. Admins only.</summary>
    public async Task RegisterAdmin()
    {
        if (!IsAdmin) throw new HubException("admin only");
        await Groups.AddToGroupAsync(Context.ConnectionId, "admins");
    }

    /// <summary>Called by a tablet after a completed signing flow so it returns to the slideshow.</summary>
    public async Task FinishDocument()
    {
        if (Context.Items.TryGetValue(DeviceItemKey, out var value) && value is string deviceId)
            await _coord.ReturnToSlidesAsync(deviceId);
    }

    public override async Task OnDisconnectedAsync(Exception? exception)
    {
        if (Context.Items.TryGetValue(DeviceItemKey, out var value) && value is string deviceId)
        {
            // Stamp the moment the tablet dropped, so "last seen" reflects when it actually went
            // off air (while it stays connected the admin shows "online now" instead of a time).
            _storage.TouchDevice(deviceId);
            _tracker.Remove(deviceId, Context.ConnectionId);
            await _coord.NotifyAdminsDevicesAsync();
        }
        await base.OnDisconnectedAsync(exception);
    }
}
