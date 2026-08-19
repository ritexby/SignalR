using Microsoft.AspNetCore.SignalR;
using SignatureKiosk.Models;
using SignatureKiosk.Services;

namespace SignatureKiosk.Hubs;

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

    /// <summary>Called by a tablet after connecting. Joins groups, records the device and
    /// returns the state the tablet should render right now (restores state after reboot/reconnect).</summary>
    public async Task<CurrentCommand> RegisterKiosk(string deviceId, string? name)
    {
        deviceId = NormalizeDeviceId(deviceId);
        Context.Items[DeviceItemKey] = deviceId;

        await Groups.AddToGroupAsync(Context.ConnectionId, "kiosks");
        await Groups.AddToGroupAsync(Context.ConnectionId, KioskCoordinator.DeviceGroup(deviceId));

        _storage.UpsertDevice(deviceId, name);
        _tracker.Add(deviceId, Context.ConnectionId);
        await _coord.NotifyAdminsDevicesAsync();

        return _coord.BuildCurrentCommand(deviceId);
    }

    /// <summary>Called by the admin page so it can receive live device/signature notifications.</summary>
    public Task RegisterAdmin() => Groups.AddToGroupAsync(Context.ConnectionId, "admins");

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
            _tracker.Remove(deviceId, Context.ConnectionId);
            await _coord.NotifyAdminsDevicesAsync();
        }
        await base.OnDisconnectedAsync(exception);
    }

    private static string NormalizeDeviceId(string? deviceId)
    {
        if (string.IsNullOrWhiteSpace(deviceId)) return "unknown";
        var cleaned = new string(deviceId.Trim()
            .Where(c => char.IsLetterOrDigit(c) || c is '-' or '_' or '.')
            .ToArray());
        if (cleaned.Length == 0) return "unknown";
        return cleaned.Length > 64 ? cleaned[..64] : cleaned;
    }
}
