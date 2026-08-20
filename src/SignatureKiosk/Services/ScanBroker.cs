using System.Collections.Concurrent;
using SignatureKiosk.Models;

namespace SignatureKiosk.Services;

/// <summary>
/// Lets an external API call ask a tablet for a code and wait for the result.
/// One pending request per device: a new request replaces (and cancels) the previous one, so a
/// stale waiter can never receive a code meant for a later request, and nothing is left dangling.
/// </summary>
public class ScanBroker
{
    private readonly ConcurrentDictionary<string, TaskCompletionSource<ScanRecord>> _waiters = new();

    /// <summary>Register a waiter for this device and return the task that completes on the next scan.</summary>
    public Task<ScanRecord> Wait(string deviceId, CancellationToken cancel)
    {
        var tcs = new TaskCompletionSource<ScanRecord>(TaskCreationOptions.RunContinuationsAsynchronously);
        _waiters.AddOrUpdate(deviceId, tcs, (_, existing) =>
        {
            // A newer request supersedes the older one; release the old waiter immediately.
            existing.TrySetCanceled();
            return tcs;
        });
        // Remove the registration when the caller gives up (timeout or client disconnect).
        cancel.Register(() =>
        {
            if (_waiters.TryGetValue(deviceId, out var current) && ReferenceEquals(current, tcs))
                _waiters.TryRemove(deviceId, out _);
            tcs.TrySetCanceled();
        });
        return tcs.Task;
    }

    /// <summary>Deliver a scan to whoever is waiting for this device. True if someone was waiting.</summary>
    public bool Publish(string deviceId, ScanRecord rec)
    {
        if (!_waiters.TryRemove(deviceId, out var tcs)) return false;
        return tcs.TrySetResult(rec);
    }

    /// <summary>Whether an external caller is currently waiting for a code from this device.</summary>
    public bool IsWaiting(string deviceId) => _waiters.ContainsKey(deviceId);
}
