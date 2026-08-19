using Microsoft.AspNetCore.SignalR;
using SignatureKiosk.Hubs;
using SignatureKiosk.Models;

namespace SignatureKiosk.Services;

/// <summary>
/// Central place that mutates screen state and pushes commands to kiosks.
/// A "target" is either the literal "all" or a specific device id.
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

    private IClientProxy TargetClients(string target) =>
        IsAll(target) ? _hub.Clients.Group("kiosks") : _hub.Clients.Group(DeviceGroup(target));

    private static bool IsAll(string? target) =>
        string.IsNullOrWhiteSpace(target) || target == AllTarget;

    // ---------- Build payloads ----------

    public SlidesPayload BuildSlidesPayload(KioskState state)
    {
        var images = _storage.GetImages().ToDictionary(i => i.Id, i => i.FileName);
        var urls = new List<string>();
        foreach (var id in state.PlaylistImageIds)
            if (images.TryGetValue(id, out var fileName))
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

    // ---------- State mutations helpers ----------

    private void ApplyToState(StateStore states, string target, Action<KioskState> mutate)
    {
        if (IsAll(target))
        {
            mutate(states.Default);
            foreach (var s in states.Devices.Values) mutate(s);
        }
        else
        {
            if (!states.Devices.TryGetValue(target, out var s))
            {
                s = states.Default.Clone();
                states.Devices[target] = s;
            }
            mutate(s);
        }
    }

    // ---------- Public operations ----------

    /// <summary>Save a playlist for the target and immediately switch it to slideshow mode.</summary>
    public async Task SaveAndShowSlidesAsync(string target, List<string> imageIds, int intervalSec)
    {
        intervalSec = Math.Clamp(intervalSec, 1, 3600);
        var states = _storage.GetStates();
        ApplyToState(states, target, s =>
        {
            s.Mode = "slides";
            s.PlaylistImageIds = new List<string>(imageIds);
            s.IntervalSec = intervalSec;
        });
        _storage.SaveStates(states);

        var payload = BuildSlidesPayload(new KioskState { PlaylistImageIds = imageIds, IntervalSec = intervalSec });
        await TargetClients(target).SendAsync("ShowSlides", payload);
    }

    /// <summary>Switch the target back to slideshow using its stored playlist.</summary>
    public async Task ReturnToSlidesAsync(string target)
    {
        var states = _storage.GetStates();
        ApplyToState(states, target, s => s.Mode = "slides");
        _storage.SaveStates(states);

        if (IsAll(target))
        {
            // Each device may have a different stored playlist; send per online device.
            foreach (var deviceId in _tracker.OnlineDeviceIds())
            {
                var payload = BuildSlidesPayload(_storage.ResolveState(deviceId));
                await _hub.Clients.Group(DeviceGroup(deviceId)).SendAsync("ShowSlides", payload);
            }
        }
        else
        {
            var payload = BuildSlidesPayload(_storage.ResolveState(target));
            await _hub.Clients.Group(DeviceGroup(target)).SendAsync("ShowSlides", payload);
        }
    }

    /// <summary>Switch the target to document mode and push the current document.</summary>
    public async Task ShowDocumentAsync(string target)
    {
        var states = _storage.GetStates();
        ApplyToState(states, target, s => s.Mode = "document");
        _storage.SaveStates(states);

        await TargetClients(target).SendAsync("ShowDocument", _storage.GetDocument());
    }

    // ---------- Admin notifications ----------

    public async Task NotifyAdminsDevicesAsync()
    {
        await _hub.Clients.Group("admins").SendAsync("DevicesChanged");
    }

    public async Task NotifyAdminsSignatureAsync(SignatureRecord rec)
    {
        await _hub.Clients.Group("admins").SendAsync("SignatureReceived", new
        {
            id = rec.Id,
            createdUtc = rec.CreatedUtc,
            documentTitle = rec.DocumentTitle,
            deviceId = rec.DeviceId,
            deviceName = rec.DeviceName,
            checkedCount = rec.Items.Count(i => i.Checked),
            totalCount = rec.Items.Count
        });
    }
}
