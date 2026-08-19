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

    private enum Kind { All, Group, Device }
    private static (Kind kind, string id) Parse(string? target)
    {
        if (string.IsNullOrWhiteSpace(target) || target == AllTarget) return (Kind.All, "");
        if (target.StartsWith("group:", StringComparison.Ordinal)) return (Kind.Group, target["group:".Length..]);
        if (target.StartsWith("device:", StringComparison.Ordinal)) return (Kind.Device, target["device:".Length..]);
        return (Kind.Device, target); // bare id → device
    }

    private IClientProxy Clients(Kind kind, string id) => kind switch
    {
        Kind.All => _hub.Clients.Group("kiosks"),
        Kind.Group => _hub.Clients.Group(RoomGroup(id)),
        _ => _hub.Clients.Group(DeviceGroup(id))
    };

    private List<string> DeviceIds(Kind kind, string id) => kind switch
    {
        Kind.All => _tracker.OnlineDeviceIds().ToList(),
        Kind.Group => _storage.GetDevices().Where(d => d.GroupIds.Contains(id)).Select(d => d.Id).ToList(),
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

    public CurrentCommand BuildCurrentCommand(string deviceId)
    {
        var state = _storage.ResolveState(deviceId);
        if (state.Mode == "document")
            return new CurrentCommand { Mode = "document", Document = _storage.GetDocument() };
        return new CurrentCommand { Mode = "slides", Slides = BuildSlidesPayload(state) };
    }

    // ---------- State mutation ----------

    private void ApplyToState(StateStore states, Kind kind, string id, Action<KioskState> mutate)
    {
        if (kind == Kind.All)
        {
            mutate(states.Default);
            foreach (var s in states.Devices.Values) mutate(s);
            return;
        }
        foreach (var deviceId in kind == Kind.Group
                     ? _storage.GetDevices().Where(d => d.GroupIds.Contains(id)).Select(d => d.Id)
                     : new[] { id })
        {
            if (!states.Devices.TryGetValue(deviceId, out var s))
            {
                s = states.Default.Clone();
                states.Devices[deviceId] = s;
            }
            mutate(s);
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
    public async Task SaveAndShowSlidesAsync(string target, List<string> imageIds, int intervalSec)
    {
        intervalSec = Math.Clamp(intervalSec, 1, 3600);
        var (kind, id) = Parse(target);
        var states = _storage.GetStates();

        if (kind == Kind.All)
        {
            states.Default.Mode = "slides";
            states.Default.PlaylistImageIds = new List<string>(imageIds);
            states.Default.IntervalSec = intervalSec;
            foreach (var s in states.Devices.Values)
            {
                s.PlaylistImageIds = new List<string>(imageIds);
                s.IntervalSec = intervalSec;
                if (s.Mode != "document") s.Mode = "slides";
            }
            _storage.SaveStates(states);

            var payloadAll = BuildSlidesPayload(states.Default);
            foreach (var deviceId in _tracker.OnlineDeviceIds())
            {
                if (IsShowingDocument(states, deviceId)) continue; // document wins
                await _hub.Clients.Group(DeviceGroup(deviceId)).SendAsync("ShowSlides", payloadAll);
            }
            return;
        }

        // Group or single device: update each concrete device's stored playlist, but
        // apply the same document-priority rule per device.
        var targetDevices = DeviceIds(kind, id);
        foreach (var deviceId in targetDevices)
        {
            if (!states.Devices.TryGetValue(deviceId, out var s))
            {
                s = states.Default.Clone();
                states.Devices[deviceId] = s;
            }
            s.PlaylistImageIds = new List<string>(imageIds);
            s.IntervalSec = intervalSec;
            if (s.Mode != "document") s.Mode = "slides";
        }
        _storage.SaveStates(states);

        var payload = BuildSlidesPayload(new KioskState { PlaylistImageIds = imageIds, IntervalSec = intervalSec });
        foreach (var deviceId in targetDevices)
        {
            if (IsShowingDocument(states, deviceId)) continue; // document wins
            await _hub.Clients.Group(DeviceGroup(deviceId)).SendAsync("ShowSlides", payload);
        }
    }

    private static bool IsShowingDocument(StateStore states, string deviceId) =>
        states.Devices.TryGetValue(deviceId, out var s) && s.Mode == "document";

    public async Task ShowDocumentAsync(string target)
    {
        var (kind, id) = Parse(target);
        var states = _storage.GetStates();
        ApplyToState(states, kind, id, s => s.Mode = "document");
        _storage.SaveStates(states);

        await Clients(kind, id).SendAsync("ShowDocument", _storage.GetDocument());
    }

    public async Task ReturnToSlidesAsync(string target)
    {
        var (kind, id) = Parse(target);
        var states = _storage.GetStates();
        ApplyToState(states, kind, id, s => s.Mode = "slides");
        _storage.SaveStates(states);

        // Each device may keep a different playlist → send its own payload per device.
        foreach (var deviceId in DeviceIds(kind, id))
        {
            var payload = BuildSlidesPayload(_storage.ResolveState(deviceId));
            await _hub.Clients.Group(DeviceGroup(deviceId)).SendAsync("ShowSlides", payload);
        }
    }

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

    public Task NotifyAdminsSignatureAsync(SignatureRecord rec) =>
        _hub.Clients.Group("admins").SendAsync("SignatureReceived", new
        {
            id = rec.Id,
            createdUtc = rec.CreatedUtc,
            documentTitle = rec.DocumentTitle,
            deviceId = rec.DeviceId,
            deviceName = rec.DeviceName,
            workstationName = rec.WorkstationName,
            checkedCount = rec.Items.Count(i => i.Checked),
            totalCount = rec.Items.Count
        });
}
