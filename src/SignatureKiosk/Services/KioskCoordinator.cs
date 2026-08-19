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

    /// <summary>
    /// Resolve a target to the concrete set of device ids from storage (the source of truth
    /// for group membership), so targeting reflects the current device configuration without
    /// waiting for a reconnect. "All" resolves to the currently online devices.
    /// </summary>
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

    /// <summary>Set a device override's mode (creating it from the default when absent).</summary>
    private static void SetDeviceMode(StateStore states, IEnumerable<string> deviceIds, string mode)
    {
        foreach (var deviceId in deviceIds)
        {
            if (!states.Devices.TryGetValue(deviceId, out var s))
            {
                s = states.Default.Clone();
                states.Devices[deviceId] = s;
            }
            s.Mode = mode;
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
        var playlist = new List<string>(imageIds);

        // Resolve the concrete device set outside the state lock (these read other files).
        var online = _tracker.OnlineDeviceIds();
        var targets = kind == Kind.All ? online.ToList() : DeviceIds(kind, id);

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

    public async Task ShowDocumentAsync(string target)
    {
        var (kind, id) = Parse(target);
        var online = _tracker.OnlineDeviceIds();
        var targets = kind == Kind.All ? online.ToList() : DeviceIds(kind, id);

        _storage.MutateStates(states =>
        {
            if (kind == Kind.All)
            {
                // "All" also sets the default so tablets that connect later show the document too.
                states.Default.Mode = "document";
                foreach (var s in states.Devices.Values) s.Mode = "document";
            }
            else SetDeviceMode(states, targets, "document");
        });

        var doc = _storage.GetDocument();
        foreach (var deviceId in targets)
            await _hub.Clients.Group(DeviceGroup(deviceId)).SendAsync("ShowDocument", doc);
    }

    public async Task ReturnToSlidesAsync(string target)
    {
        var (kind, id) = Parse(target);
        var online = _tracker.OnlineDeviceIds();
        var targets = kind == Kind.All ? online.ToList() : DeviceIds(kind, id);

        _storage.MutateStates(states =>
        {
            if (kind == Kind.All)
            {
                states.Default.Mode = "slides";
                foreach (var s in states.Devices.Values) s.Mode = "slides";
            }
            else SetDeviceMode(states, targets, "slides");
        });

        // Each device may keep a different playlist, so send its own payload per device.
        foreach (var deviceId in targets)
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
