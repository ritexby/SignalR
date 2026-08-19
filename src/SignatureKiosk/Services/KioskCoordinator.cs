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
        {
            // Resolve with THIS device's own signer data only, so a tablet never receives
            // another signer's fields or checkboxes.
            var doc = DocumentTemplating.Resolve(_storage.GetDocument(), state.Fields, state.DynamicCheckboxes);
            return new CurrentCommand { Mode = "document", Document = doc };
        }
        return new CurrentCommand { Mode = "slides", Slides = BuildSlidesPayload(state) };
    }

    // ---------- State mutation ----------

    /// <summary>Set a device override's mode, signer fields and per-signer checkboxes (creating it from the default when absent).</summary>
    private static void SetDeviceState(StateStore states, IEnumerable<string> deviceIds, string mode,
        Dictionary<string, string> fields, List<DocCheckbox> checkboxes)
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
            s.DynamicCheckboxes = checkboxes.Select(c => new DocCheckbox { Label = c.Label, Required = c.Required, Checked = c.Checked }).ToList();
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

        // Resolve the concrete device set outside the state lock (these read other files):
        // "all" resolves to the currently online devices, group/device to storage membership.
        var targets = DeviceIds(kind, id);

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
    public async Task ShowDocumentAsync(string deviceId, IReadOnlyDictionary<string, string>? fields = null,
        IReadOnlyList<DocCheckbox>? checkboxes = null)
    {
        var fieldMap = fields is null ? new Dictionary<string, string>() : new Dictionary<string, string>(fields);
        var cbs = checkboxes is null ? new List<DocCheckbox>() : checkboxes.ToList();

        _storage.MutateStates(states => SetDeviceState(states, new[] { deviceId }, "document", fieldMap, cbs));

        var doc = DocumentTemplating.Resolve(_storage.GetDocument(), fieldMap, cbs);
        await _hub.Clients.Group(DeviceGroup(deviceId)).SendAsync("ShowDocument", doc);
    }

    /// <summary>Return one tablet to advertising and clear its signer data, then push its slides.</summary>
    public async Task ReturnToSlidesAsync(string deviceId)
    {
        ClearSignerSession(deviceId);
        var payload = BuildSlidesPayload(_storage.ResolveState(deviceId));
        await _hub.Clients.Group(DeviceGroup(deviceId)).SendAsync("ShowSlides", payload);
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
        });
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
