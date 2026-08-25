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
        // Страницу планшета можно открыть и в браузере оператора: тогда подключение опознано по
        // куке админки, а не по токену планшета, и регистрировать нечего. Это обычное дело, а не
        // сбой службы, поэтому не исключение: оно попадало бы в журнал оператора красной строкой
        // при каждом переподключении. Планшет по ответу поймёт, что он не привязан, и покажет
        // экран активации.
        if (string.IsNullOrEmpty(deviceId)) return new CurrentCommand { Mode = "notdevice" };

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
        // If the same token drives more than one screen (a cloned image, a token copied off a
        // tablet), the operator is alerted by AlertMonitor. Deliberately NOT disconnecting the
        // others: a browser that reloads or a second tab would otherwise silence the real tablet
        // for good, and a compromised token is fixed by revoking it, not by guessing which screen
        // is genuine.
        await _coord.NotifyAdminsDevicesAsync();

        // Планшет мог переподключиться, пока за ним смотрят: сервер говорит об этом только на
        // границе, когда наблюдатель появился или ушёл, поэтому вернувшийся планшет иначе молчал
        // бы, а оператор смотрел бы на застывшую картинку и не знал об этом.
        if (_coord.IsWatched(deviceId))
            await Clients.Caller.SendAsync("WatchOn");

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

    // ---------- Наблюдение за экраном планшета ----------
    // Оператор видит у себя то же, что клиент видит на планшете. Планшет не шлёт картинку: у
    // админки есть тот же отрисовщик документа, и ей достаточно знать, что изменилось. Поэтому
    // расход измеряется сотнями байт на событие, а не мегабитами видео.
    //
    // Связь односторонняя, от планшета к наблюдателю: из окна наблюдения на планшет не уходит
    // ничего, там нет ни одной команды. Поток живёт только в памяти соединения и никуда не
    // записывается: у данных подписанта в этой системе строгий срок жизни, и наблюдение не
    // должно создавать вторую копию.
    private const string WatchItemKey = "watching";

    private static string WatchGroup(string deviceId) => "watch:" + deviceId;

    /// <summary>Оператор начинает смотреть за одним планшетом. Только для админки.</summary>
    public async Task WatchDevice(string? deviceId)
    {
        if (!IsAdmin) throw new HubException("admin only");
        var id = (deviceId ?? "").Trim();
        if (id.Length == 0 || _storage.GetDevice(id) is null) throw new HubException("unknown device");

        // Смотреть можно только за одним планшетом сразу: иначе в одном окне оказались бы
        // данные двух разных клиентов, а этого в системе быть не должно.
        if (Context.Items.TryGetValue(WatchItemKey, out var was) && was is string old && old != id)
        {
            await Groups.RemoveFromGroupAsync(Context.ConnectionId, WatchGroup(old));
            await _coord.SetWatchAsync(old, Context.ConnectionId, false);
        }
        Context.Items[WatchItemKey] = id;
        await Groups.AddToGroupAsync(Context.ConnectionId, WatchGroup(id));
        // Планшет начинает рассказывать о себе только теперь: пока никто не смотрит, он молчит
        // и не тратит ни батарею, ни канал.
        await _coord.SetWatchAsync(id, Context.ConnectionId, true);
    }

    /// <summary>Оператор перестал смотреть.</summary>
    public async Task UnwatchDevice()
    {
        if (!Context.Items.TryGetValue(WatchItemKey, out var value) || value is not string id) return;
        Context.Items.Remove(WatchItemKey);
        await Groups.RemoveFromGroupAsync(Context.ConnectionId, WatchGroup(id));
        await _coord.SetWatchAsync(id, Context.ConnectionId, false);
    }

    /// <summary>
    /// Планшет рассказывает, что у него на экране. Личность берётся из токена, а не из
    /// аргументов: иначе один планшет мог бы выдать себя за другой и подсунуть наблюдателю
    /// чужую картину. Ответ уходит только тем, кто смотрит именно за этим планшетом.
    /// </summary>
    public async Task ReportScreen(object? state)
    {
        var deviceId = DeviceId;
        if (string.IsNullOrEmpty(deviceId)) return;
        await Clients.Group(WatchGroup(deviceId)).SendAsync("WatchState", deviceId, state);
    }

    /// <summary>Called by a tablet after a completed signing flow so it returns to the slideshow.</summary>
    // Identity comes from the token claim, not from Context.Items: after an automatic reconnect the
    // connection is new and Items is empty until RegisterKiosk finishes, and a call landing in that
    // window used to succeed while doing nothing, leaving the signer's document on screen.
    public async Task FinishDocument()
    {
        var deviceId = DeviceId;
        if (!string.IsNullOrEmpty(deviceId)) await _coord.ReturnToSlidesAsync(deviceId);
    }

    /// <summary>
    /// The tablet reports which build of the kiosk page it is running. Deliberately a separate
    /// call rather than an argument to RegisterKiosk: SignalR matches hub methods by exact
    /// argument count, so adding a parameter would make every tablet still running an older page
    /// fail to register at all. A tablet that never calls this is simply on an older page, which
    /// is exactly what the operator needs to be told.
    /// </summary>
    public async Task ReportVersion(string? appVersion)
    {
        var deviceId = DeviceId;
        if (string.IsNullOrEmpty(deviceId) || string.IsNullOrWhiteSpace(appVersion)) return;
        _tracker.SetAppVersion(deviceId, appVersion);
        // Версия приходит уже после RegisterKiosk, а список планшетов в админке обновляется
        // только по событию. Без этого уведомления карточка показывала пустую версию до
        // следующего постороннего события, и понять, на какой странице планшет, было нельзя.
        await _coord.NotifyAdminsDevicesAsync();
    }

    /// <summary>
    /// Планшет сообщает размер своего экрана: ширину и высоту области просмотра в точках
    /// разметки и плотность пикселей. Окно наблюдения показывает уменьшенный экран планшета
    /// один в один, и настоящие размеры знает только сам планшет.
    ///
    /// Отдельный вызов, а не аргументы RegisterKiosk, ровно по той же причине, что и
    /// ReportVersion: SignalR сопоставляет методы хаба по имени и числу аргументов, и лишний
    /// параметр у регистрации оставил бы без регистрации весь парк, который ещё не перезагрузил
    /// страницу. Планшет, который сюда не звонит, просто остаётся без размеров, и это само по
    /// себе ответ оператору.
    ///
    /// Личность берётся из токена, а не из аргументов: иначе один планшет мог бы переписать
    /// размеры чужой карточки.
    /// </summary>
    /// <returns>Принял ли сервер сведения. Планшет запоминает отправленное только по этому
    /// ответу: иначе он считал бы доставленным то, что сервер отверг, и не повторил бы, когда
    /// повод для отказа исчез.</returns>
    public async Task<bool> ReportScreenSize(double width, double height, double pixelRatio)
    {
        var deviceId = DeviceId;
        if (string.IsNullOrEmpty(deviceId)) return false;
        // Отсев до приведения к целому: приведение бесконечности или NaN к int даёт мусорное
        // число, а не ошибку. Сравнения с NaN ложны сами по себе, поэтому он отсеивается здесь же.
        if (!(width >= 1 && width <= 10000) || !(height >= 1 && height <= 10000)) return false;
        var итог = _storage.SetDeviceScreen(deviceId, (int)Math.Round(width), (int)Math.Round(height), pixelRatio);
        // Уведомление только на настоящем изменении: планшет сообщает размер на каждом
        // подключении, и без этого условия любое переподключение парка гнало бы в админки
        // обновление списка ни о чём.
        if (итог == DeviceScreenUpdate.Changed) await _coord.NotifyAdminsDevicesAsync();
        return итог != DeviceScreenUpdate.Rejected;
    }

    /// <summary>Called by a tablet once a code has been scanned, so it returns to whatever it
    /// should be showing (its ads, or the document it was on).</summary>
    public async Task FinishScan()
    {
        var deviceId = DeviceId;
        if (!string.IsNullOrEmpty(deviceId)) await _coord.StopScanAsync(deviceId);
    }

    public override async Task OnDisconnectedAsync(Exception? exception)
    {
        // Оператор закрыл вкладку или потерял связь: планшет должен перестать рассказывать о
        // себе, иначе он говорил бы в пустоту до самой перезагрузки.
        if (Context.Items.TryGetValue(WatchItemKey, out var watched) && watched is string watchedId)
            await _coord.SetWatchAsync(watchedId, Context.ConnectionId, false);

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
