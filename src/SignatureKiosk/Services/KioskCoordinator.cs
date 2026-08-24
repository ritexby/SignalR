using System.Collections.Concurrent;
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
    private readonly ILogger<KioskCoordinator> _log;

    public KioskCoordinator(IHubContext<KioskHub> hub, StorageService storage, DeviceTracker tracker,
        ILogger<KioskCoordinator> log)
    {
        _hub = hub;
        _storage = storage;
        _tracker = tracker;
        _log = log;
        _ = Task.Run(DevicesNotifyLoopAsync);
    }

    public static string DeviceGroup(string deviceId) => "dev:" + deviceId;
    public static string RoomGroup(string groupId) => "grp:" + groupId;

    private enum Kind { All, Group, Device, Devices }
    private static (Kind kind, string id) Parse(string? target)
    {
        if (string.IsNullOrWhiteSpace(target) || target == AllTarget) return (Kind.All, "");
        if (target.StartsWith("group:", StringComparison.Ordinal)) return (Kind.Group, target["group:".Length..]);
        if (target.StartsWith("device:", StringComparison.Ordinal)) return (Kind.Device, target["device:".Length..]);
        // Произвольный набор планшетов: список приходит отдельным параметром, а не в строке
        // адресата, потому что в строке он был бы неограниченной длины.
        if (string.Equals(target, "devices", StringComparison.Ordinal)) return (Kind.Devices, "");
        return (Kind.Device, target); // bare id → device
    }

    /// <summary>
    /// Resolve a target to the concrete set of device ids from storage (the source of truth
    /// for group membership), so targeting reflects the current device configuration without
    /// waiting for a reconnect. "All" resolves to the currently online devices.
    /// </summary>
    private List<string> DeviceIds(Kind kind, string id, IReadOnlyList<string>? chosen = null) => kind switch
    {
        Kind.All => _tracker.OnlineDeviceIds().ToList(),
        Kind.Group => _storage.GetDevices().Where(d => d.GroupIds.Contains(id)).Select(d => d.Id).ToList(),
        // Только те планшеты, которые действительно существуют: удалённый из набора просто
        // выпадает, а остальные продолжают получать рекламу.
        Kind.Devices => _storage.GetDevices().Where(d => (chosen ?? Array.Empty<string>()).Contains(d.Id)).Select(d => d.Id).ToList(),
        _ => new List<string> { id }
    };

    // ---------- Build payloads ----------

    public SlidesPayload BuildSlidesPayload(KioskState state, string? deviceId = null)
    {
        // Картинка со сроком показа выпадает из списка сама, когда срок не наступил или прошёл.
        // Считается на сервере и по дню, а не по часам: реклама живёт днями, и час начала показа
        // никому не нужен. Планшет получает уже готовый список и ничего про сроки не знает.
        var today = DateTime.Now.Date;
        var images = _storage.GetImages().ToDictionary(i => i.Id, i => i);
        var device = string.IsNullOrEmpty(deviceId) ? null : _storage.GetDevice(deviceId!);
        return СобратьСлайды(state, device, images, today);
    }

    /// <summary>
    /// Сборка списка для одного планшета из уже прочитанных картинок. Отдельный метод нужен там,
    /// где планшетов много: при двухстах читать список картинок на каждого значило бы двести
    /// разборов одного и того же файла подряд.
    /// </summary>
    private static SlidesPayload СобратьСлайды(KioskState state, Device? device,
        IReadOnlyDictionary<string, ImageInfo> images, DateTime today)
    {
        var urls = new List<string>();
        foreach (var imgId in state.PlaylistImageIds)
            if (images.TryGetValue(imgId, out var info) && ImageShowsToday(info, today) && ImageShowsOnDevice(info, device))
                urls.Add("/media/" + info.FileName);
        return new SlidesPayload { Images = urls, IntervalSec = state.IntervalSec };
    }

    /// <summary>
    /// Разослать рекламу заново всем планшетам, которые её показывают. Нужно, когда состав
    /// картинок мог измениться сам: наступил или кончился срок показа. Планшет, на котором идёт
    /// документ, не трогается: реклама никогда не перебивает подписание.
    /// </summary>
    public async Task RefreshSlidesAsync()
    {
        // Состояние читается один раз на всех: при двухстах планшетах чтение на каждого
        // означало бы двести разборов одного и того же файла подряд.
        var states = _storage.GetStates();
        var images = _storage.GetImages().ToDictionary(i => i.Id, i => i);
        var today = DateTime.Now.Date;
        foreach (var dev in _storage.GetDevices())
        {
            var state = states.Devices.TryGetValue(dev.Id, out var s) ? s : states.Default;
            if (state.Mode == "document") continue;
            await _hub.Clients.Group(DeviceGroup(dev.Id))
                .SendAsync("ShowSlides", СобратьСлайды(state, dev, images, today));
        }
    }

    /// <summary>
    /// Показывается ли картинка на этом планшете, по заданным ей группам. Пустые списки означают
    /// «везде»: именно так ведут себя все картинки, которым группы не задавали.
    /// </summary>
    public static bool ImageShowsOnDevice(ImageInfo info, Device? device)
    {
        var только = info.GroupIds ?? new List<string>();
        var кроме = info.ExceptGroupIds ?? new List<string>();
        if (только.Count == 0 && кроме.Count == 0) return true;
        var свои = device?.GroupIds ?? new List<string>();
        // Запрет сильнее разрешения: планшет, попавший и в «показывать», и в «кроме», картинку не
        // увидит. Иначе одна и та же настройка значила бы разное в зависимости от порядка чтения.
        if (кроме.Count > 0 && свои.Any(g => кроме.Contains(g))) return false;
        if (только.Count == 0) return true;
        return свои.Any(g => только.Contains(g));
    }

    /// <summary>Показывается ли картинка сегодня, по заданным ей срокам.</summary>
    public static bool ImageShowsToday(ImageInfo info, DateTime today)
    {
        var from = DocumentTemplating.ParseDate(info.ShowFrom);
        if (from is not null && today < from.Value) return false;
        var to = DocumentTemplating.ParseDate(info.ShowTo);
        if (to is not null && today > to.Value) return false;
        return true;
    }

    /// <summary>
    /// A signer session must not outlive the client. If a tablet is powered off (or crashes) in the
    /// middle of signing, its client-side idle timer never fires, so the server enforces its own
    /// ceiling: an abandoned document is dropped rather than shown to whoever comes next.
    /// </summary>
    // Deliberately generous: this is a backstop for a tablet that is gone (switched off, crashed,
    // taken away), not an idle timeout. A tablet that is still connected governs itself with the
    // operator-configured idle timeout, so a slow signer is never cut off mid-document.
    private static readonly TimeSpan SignerSessionMaxAge = TimeSpan.FromHours(2);

    private static bool IsExpired(KioskState state) =>
        state.Mode == "document" && state.DocumentSetUtc is { } set && DateTime.UtcNow - set > SignerSessionMaxAge;

    /// <summary>
    /// Clear every abandoned signer session, without waiting for the tablet to reconnect. A tablet
    /// that is switched off (or broken, or returned) mid-signing would otherwise leave the client's
    /// personal data at rest indefinitely. Returns how many were cleared.
    /// </summary>
    public int SweepExpiredSessions()
    {
        // Only tablets that are NOT connected: an online tablet is showing the document to someone
        // right now and manages its own return-to-ads. Sweeping it would wipe the session under an
        // active signer, whose signature would then be refused.
        var online = _tracker.OnlineDeviceIds();
        var candidates = _storage.GetStates().Devices
            .Where(kv => !online.Contains(kv.Key) && IsExpired(kv.Value))
            .Select(kv => kv.Key).ToList();
        if (candidates.Count == 0) return 0;   // never rewrite the file for nothing

        // Снимки сессий уходят вместе с данными подписанта. Удаляются после записи состояния:
        // наоборот осталось бы окно, где состояние ещё «документ», а снимка уже нет.
        var swept = new List<string>();
        try
        {
            return _storage.MutateStates(states =>
        {
            var n = 0;
            foreach (var deviceId in candidates)
            {
                if (!states.Devices.TryGetValue(deviceId, out var s) || !IsExpired(s)) continue;
                s.Mode = "slides";
                s.Fields.Clear();
                s.DynamicCheckboxes.Clear();
                s.CheckboxStates.Clear();
                s.GroupSelections.Clear();
                s.Texts.Clear();
                s.GroupOptions.Clear();
                s.DocumentSetUtc = null;
                s.SessionId = null;
                swept.Add(deviceId);
                n++;
            }
            return n;
        });
        }
        finally
        {
            foreach (var id in swept) _storage.DeleteDocSession(id);
        }
    }

    public CurrentCommand BuildCurrentCommand(string deviceId)
    {
        var state = _storage.ResolveState(deviceId);
        if (IsExpired(state))
        {
            // Abandoned session: clear it now and show ads instead of the previous client's data.
            ClearSignerSession(deviceId);
            state = _storage.ResolveState(deviceId);
        }
        if (state.Mode == "document")
        {
            // Переподключившийся планшет получает снимок, сделанный при показе, а не пересборку
            // из текущего шаблона: шаблон могли править, пока клиент подписывал, и документ
            // менялся бы у него на глазах посреди подписания.
            if (!string.IsNullOrEmpty(state.SessionId))
            {
                var session = _storage.GetDocSession(deviceId);
                if (session is not null && session.SessionId == state.SessionId)
                    return new CurrentCommand { Mode = "document", Document = session.Document, SessionId = session.SessionId };
            }
            // Снимка нет: сессия начата до появления снимков. Прежний путь, с данными только
            // этого планшета: чужого он не получит и здесь.
            var doc = DocumentTemplating.Resolve(_storage.GetDocument(), state.Fields, state.DynamicCheckboxes,
                state.GroupSelections, state.CheckboxStates, state.Texts, state.GroupOptions);
            return new CurrentCommand { Mode = "document", Document = doc, SessionId = state.SessionId };
        }
        return new CurrentCommand { Mode = "slides", Slides = BuildSlidesPayload(state, deviceId) };
    }

    // ---------- State mutation ----------

    /// <summary>Set a device override's mode, signer fields and per-signer checkboxes (creating it from the default when absent).</summary>
    private static void SetDeviceState(StateStore states, IEnumerable<string> deviceIds, string mode,
        Dictionary<string, string> fields, List<DocCheckbox> checkboxes,
        Dictionary<string, bool>? checkboxStates = null, Dictionary<string, string>? groupSelections = null,
        Dictionary<string, string>? texts = null,
        Dictionary<string, List<DocGroupOption>>? groupOptions = null, string? sessionId = null)
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
            s.DynamicCheckboxes = checkboxes.Select(c => new DocCheckbox { Key = c.Key, Label = c.Label, Required = c.Required, Checked = c.Checked }).ToList();
            s.CheckboxStates = checkboxStates is null ? new Dictionary<string, bool>() : new Dictionary<string, bool>(checkboxStates);
            s.GroupSelections = groupSelections is null ? new Dictionary<string, string>() : new Dictionary<string, string>(groupSelections);
            s.Texts = texts is null ? new Dictionary<string, string>() : new Dictionary<string, string>(texts);
            s.GroupOptions = groupOptions is null
                ? new Dictionary<string, List<DocGroupOption>>()
                : groupOptions.ToDictionary(kv => kv.Key,
                    kv => kv.Value.Select(o => new DocGroupOption { Key = o.Key, Label = o.Label }).ToList());
            s.DocumentSetUtc = mode == "document" ? DateTime.UtcNow : null;
            s.SessionId = mode == "document" ? sessionId : null;
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
    /// <summary>Возвращает, скольким планшетам реклама действительно ушла прямо сейчас.</summary>
    public async Task<int> SaveAndShowSlidesAsync(string target, List<string> imageIds, int intervalSec,
        IReadOnlyList<string>? deviceIds = null)
    {
        intervalSec = Math.Clamp(intervalSec, 1, 3600);
        var (kind, id) = Parse(target);
        var playlist = new List<string>(imageIds);

        // Resolve the concrete device set outside the state lock (these read other files):
        // "all" resolves to the currently online devices, group/device to storage membership.
        var targets = DeviceIds(kind, id, deviceIds);

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

        // Список у каждого свой: картинке можно задать группы, где её показывать и где не
        // показывать, поэтому один общий набор на всех больше не годится. Картинки и планшеты
        // читаются один раз на всех, а не на каждого.
        var картинки = _storage.GetImages().ToDictionary(i => i.Id, i => i);
        var сегодня = DateTime.Now.Date;
        var планшеты = _storage.GetDevices().ToDictionary(d => d.Id, d => d);
        var набор = new KioskState { PlaylistImageIds = playlist, IntervalSec = intervalSec };
        // Считаем только тех, кто действительно на связи: сохранить настройку и показать её на
        // экране это разные события, и оператору важно знать, случилось ли второе.
        var online = _tracker.OnlineDeviceIds();
        var дошло = 0;
        foreach (var deviceId in recipients)
        {
            планшеты.TryGetValue(deviceId, out var планшет);
            await _hub.Clients.Group(DeviceGroup(deviceId))
                .SendAsync("ShowSlides", СобратьСлайды(набор, планшет, картинки, сегодня));
            if (online.Contains(deviceId)) дошло++;
        }
        return дошло;
    }

    private static bool IsShowingDocument(StateStore states, string deviceId) =>
        states.Devices.TryGetValue(deviceId, out var s) && s.Mode == "document";

    /// <summary>
    /// Show the signing document on exactly ONE tablet, filling {{tags}} with <paramref name="fields"/>
    /// and injecting any per-signer <paramref name="checkboxes"/>. A document is never shown to more
    /// than one tablet: the signer data lives only on this device, so it can never reach anyone else.
    /// </summary>
    // Signer data is stored per device and re-read on every hub connect, sign and scan-stop, so it
    // must stay small. These bounds are far above any real consent form.
    private const int MaxFields = 100;
    private const int MaxFieldNameLength = 200;
    private const int MaxFieldValueLength = 4000;
    private const int MaxDynamicCheckboxes = 100;
    private const int MaxCheckboxLabelLength = 2000;

    private static string Cut(string? s, int max) =>
        string.IsNullOrEmpty(s) ? "" : (s.Length <= max ? s : s[..max]);

    /// <summary>Сколько картинок можно прислать с одним заказом и какого размера каждая.</summary>
    private const int MaxApiImages = 8;
    private const int MaxApiImageChars = 2 * 1024 * 1024;   // длина строки BASE64 вместе с приставкой

    /// <summary>
    /// Разобрать картинки, присланные внешней системой. Каждая проверяется по первым байтам, а
    /// не по тому, что о ней написали: приставку data:image/png можно поставить к чему угодно.
    /// Годятся только те виды, которые умеет вложить в себя PDF: иначе клиент увидел бы картинку,
    /// а в подписанном документе её бы не оказалось, и запись перестала бы совпадать с
    /// подписанным. Возвращает готовые к показу значения или сообщение об ошибке.
    /// </summary>
    public static string? ParseApiImages(IReadOnlyDictionary<string, string>? images,
        out Dictionary<string, string> готовые)
    {
        готовые = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        if (images is null || images.Count == 0) return null;
        if (images.Count > MaxApiImages)
            return "Слишком много картинок в одном запросе: не больше " + MaxApiImages + ".";

        foreach (var kv in images)
        {
            // Пустой тег и пустое значение это ошибка заказа, а не «ничего не присылали»: все
            // прочие беды с картинками отвечают отказом с именем тега, и молчать тут значит
            // отдать «ок» на документ, в котором картинки не окажется.
            var tag = (kv.Key ?? "").Trim();
            if (tag.Length == 0)
                return "У картинки не задано имя тега: непонятно, куда её ставить.";
            var raw = (kv.Value ?? "").Trim();
            if (raw.Length == 0)
                return "Картинка «" + tag + "» пришла пустой.";
            if (raw.Length > MaxApiImageChars)
                return "Картинка «" + tag + "» слишком большая: не больше двух мегабайт в BASE64.";

            // Приставка не обязательна: внешняя система вправе прислать голый BASE64.
            var base64 = raw;
            var запятая = raw.IndexOf(',');
            if (raw.StartsWith("data:", StringComparison.OrdinalIgnoreCase) && запятая > 0)
                base64 = raw[(запятая + 1)..];

            byte[] bytes;
            try { bytes = Convert.FromBase64String(base64.Trim()); }
            catch (FormatException) { return "Картинка «" + tag + "» это не BASE64."; }

            var вид = ImageKind(bytes);
            if (вид is null)
                return "Картинка «" + tag + "» не PNG, не JPG и не BMP. Другие виды нельзя вложить в PDF, " +
                       "и подписанный документ не совпал бы с тем, что видел клиент.";

            готовые[tag] = "data:" + вид + ";base64," + Convert.ToBase64String(bytes);
        }
        return null;
    }

    /// <summary>Вид картинки по её первым байтам, или null для всего остального.</summary>
    private static string? ImageKind(byte[] b)
    {
        if (b.Length >= 8 && b[0] == 0x89 && b[1] == 0x50 && b[2] == 0x4E && b[3] == 0x47) return "image/png";
        if (b.Length >= 3 && b[0] == 0xFF && b[1] == 0xD8 && b[2] == 0xFF) return "image/jpeg";
        if (b.Length >= 2 && b[0] == 0x42 && b[1] == 0x4D) return "image/bmp";
        return null;
    }

    /// <param name="отброшено">
    /// Что не поместилось в пределы и до клиента не доехало. Внешней системе нельзя показать
    /// предупреждение, у неё есть только ответ: молчаливая обрезка означала бы «ок» на заказ, из
    /// которого клиент части не увидел, и обязательного пункта в том числе.
    /// </param>
    public async Task ShowDocumentAsync(string deviceId, IReadOnlyDictionary<string, string>? fields = null,
        IReadOnlyList<DocCheckbox>? checkboxes = null, IReadOnlyList<GroupSelectionDto>? groups = null,
        IReadOnlyDictionary<string, string>? images = null, DocumentInfo? документ = null,
        List<string>? отброшено = null)
    {
        var fieldMap = new Dictionary<string, string>();
        if (fields is not null)
        {
            if (fields.Count > MaxFields)
                отброшено?.Add("тегов прислано " + fields.Count + ", взято " + MaxFields + ": лишние не подставлены");
            foreach (var kv in fields.Take(MaxFields))
            {
                if ((kv.Value?.Length ?? 0) > MaxFieldValueLength)
                    отброшено?.Add("значение тега «" + kv.Key + "» обрезано до " + MaxFieldValueLength + " знаков");
                fieldMap[Cut(kv.Key, MaxFieldNameLength)] = Cut(kv.Value, MaxFieldValueLength);
            }
        }

        // Какой документ показывать, решает вызывающий: он уже проверил код и отказал, если
        // такого документа нет. Здесь остаётся взять его текст.
        документ ??= _storage.DefaultDocumentInfo();
        var template = _storage.GetDocument(документ.Id);
        // Имена, которые вообще есть в шаблоне. Чекбокс с известным именем не дописывается вниз
        // страницы, а задаёт состояние тому, который уже стоит в нужном месте документа.
        var known = DocumentTemplating.LiveKeys(template);

        var cbs = new List<DocCheckbox>();
        var states = new Dictionary<string, bool>(StringComparer.OrdinalIgnoreCase);
        // Тексты для того, что уже стоит в документе: формулировка зависит от заказа, а место
        // в документе всегда одно и то же. Label заменяет текст целиком, LabelAppend дописывает
        // к тому, что уже стоит: внешняя система не обязана знать формулировку документа.
        var texts = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        var current = DocumentTemplating.CurrentTexts(template);
        void SetText(string name, string? replace, string? append)
        {
            var text = string.IsNullOrWhiteSpace(replace)
                ? (current.TryGetValue(name, out var have) ? have : "")
                : replace!;
            if (!string.IsNullOrWhiteSpace(append))
            {
                var tail = append!.Trim();
                // Пробел ставится не всегда: дописка, начинающаяся со знака препинания, должна
                // прилипнуть к предыдущему слову, иначе получится «НЕТ , не соблюдал».
                var glue = tail.Length > 0 && ",.;:!?)»".IndexOf(tail[0]) >= 0 ? "" : " ";
                text = (text.TrimEnd() + glue + tail).Trim();
            }
            if (!string.IsNullOrWhiteSpace(replace) || !string.IsNullOrWhiteSpace(append))
                texts[name] = Cut(text, MaxCheckboxLabelLength);
        }
        foreach (var c in (checkboxes ?? Array.Empty<DocCheckbox>()).Where(c => c is not null))
        {
            var key = DocumentTemplating.CleanKey(c.Key);
            if (key.Length > 0 && known.Contains(key))
            {
                states[key] = c.Checked;
                SetText(key, c.Label, c.LabelAppend);
                continue;
            }
            if (cbs.Count >= MaxDynamicCheckboxes)
            {
                отброшено?.Add("пункт «" + key + "» не показан: пунктов сверх " + MaxDynamicCheckboxes + " не бывает");
                continue;
            }
            cbs.Add(new DocCheckbox
            {
                Key = key,
                // Условие показа приходило в запросе, принималось кодом 200 и молча терялось:
                // пункт, присланный скрытым и уже отмеченным, показывался клиенту и попадал в
                // запись и в бумагу.
                VisibleWhen = c.VisibleWhen,
                Label = Cut(c.Label, MaxCheckboxLabelLength),
                Required = c.Required,
                Checked = c.Checked
            });
        }

        var selections = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        var options = new Dictionary<string, List<DocGroupOption>>(StringComparer.OrdinalIgnoreCase);
        foreach (var g in (groups ?? Array.Empty<GroupSelectionDto>()).Where(g => g is not null).Take(MaxDynamicCheckboxes))
        {
            var key = DocumentTemplating.CleanKey(g.Key);
            if (key.Length == 0) continue;
            selections[key] = DocumentTemplating.CleanKey(g.Selected);
            SetText(key, g.Title, g.TitleAppend);
            // Варианты, присланные вместе с заказом. Если их прислали, они и есть список:
            // складывать их с теми, что в документе, значило бы показать клиенту два набора.
            var sent = new List<DocGroupOption>();
            foreach (var o in (g.Options ?? new List<DocGroupOption>()).Where(o => o is not null).Take(MaxDynamicCheckboxes))
            {
                var ok = DocumentTemplating.CleanKey(o.Key);
                if (ok.Length == 0) continue;
                SetText(key + "/" + ok, o.Label, o.LabelAppend);
                sent.Add(new DocGroupOption { Key = ok, Label = Cut(o.Label, MaxCheckboxLabelLength) });
            }
            if (sent.Count > 0) options[key] = sent;
        }

        var doc = DocumentTemplating.Resolve(template, fieldMap, cbs, selections, states, texts, options, images);

        // Снимок сессии: документ ровно в том виде, в каком он сейчас уедет на планшет. Из него
        // соберётся запись и PDF, его же получит переподключившийся планшет и окно наблюдения.
        // Поля подписанта отбираются по шаблону сейчас, при показе: при отправке подписи шаблон
        // уже может быть другим, и по нему отбор был бы неверным.
        // Порядок намеренный: сначала файл снимка, потом состояние с его именем, потом отправка.
        // Обратный порядок оставлял бы окно, где состояние ссылается на снимок, которого нет.
        var sessionId = Guid.NewGuid().ToString("N");
        var used = DocumentTemplating.UsedFields(template);
        var recordFields = fieldMap.Where(kv => used.Contains(kv.Key))
            .ToDictionary(kv => kv.Key, kv => kv.Value);
        _storage.SaveDocSession(deviceId, new DocSession
        {
            SessionId = sessionId,
            Document = doc,
            RecordFields = recordFields.Count > 0 ? recordFields : null,
            // Снимок помнит, из какого документа он сделан: это попадёт в запись подписи, и
            // через год по коду будет видно, что именно подписали.
            DocumentCode = документ.Code,
            DocumentName = документ.Name,
            ShownUtc = DateTime.UtcNow
        });
        _storage.MutateStates(st => SetDeviceState(st, new[] { deviceId }, "document", fieldMap, cbs, states, selections, texts, options, sessionId));

        await _hub.Clients.Group(DeviceGroup(deviceId)).SendAsync("ShowDocument", doc, sessionId);
        // На планшете сменился документ: тот, кто смотрит, должен перечитать его заново, иначе
        // рисовал бы старый документ поверх нового состояния.
        await NotifyWatchersReloadAsync(deviceId);
        // И админка должна узнать, что документ поехал: отправить его могла внешняя система, а
        // не оператор, и тогда он об этом иначе не узнает вовсе.
        var dev = _storage.GetDevice(deviceId);
        await _hub.Clients.Group("admins").SendAsync("DocumentShown", new { deviceId, name = dev?.Name ?? deviceId });
        await NotifyAdminsDevicesAsync();
    }

    /// <summary>
    /// Планшет отозван. Отзыв должен значить «этот экран больше ничего нашего не показывает»,
    /// поэтому здесь три действия сразу: стереть данные подписанта, сказать самому планшету, что
    /// он отвязан, и разорвать его соединение. Одной пометки в списке планшетов не хватало:
    /// личность в хабе проверяется один раз, на рукопожатии, и уже открытое соединение
    /// продолжало получать документы следующих клиентов. Ровно от этого отзыв и нужен, когда
    /// планшет украли или один код используется на двух экранах.
    /// </summary>
    public async Task RevokeDeviceAsync(string deviceId)
    {
        ClearSignerSession(deviceId);
        try { await _hub.Clients.Group(DeviceGroup(deviceId)).SendAsync("Revoked"); }
        catch { /* планшета может уже не быть на связи: разрыв ниже всё равно нужен */ }
        foreach (var id in _tracker.ConnectionIds(deviceId))
        {
            // Каждое соединение отдельно: один и тот же код мог быть заведён на нескольких
            // экранах, и закрыть надо все, а не первое попавшееся.
            try { await _hub.Clients.Client(id).SendAsync("Revoked"); } catch { /* уже отвалилось */ }
        }
    }

    /// <summary>Return one tablet to advertising and clear its signer data, then push its slides.</summary>
    public async Task ReturnToSlidesAsync(string deviceId)
    {
        ClearSignerSession(deviceId);
        var payload = BuildSlidesPayload(_storage.ResolveState(deviceId), deviceId);
        await _hub.Clients.Group(DeviceGroup(deviceId)).SendAsync("ShowSlides", payload);
        await NotifyWatchersReloadAsync(deviceId);
    }

    /// <summary>
    /// Clear a device's signer data and return it to slides mode in storage WITHOUT pushing a
    /// command (the tablet is showing its local thank-you screen). This closes the window where a
    /// reconnect right after signing could redisplay the just-signed document with its data.
    /// </summary>
    /// <param name="толькоСессию">
    /// Стирать только этот показ. Между чтением снимка и очисткой оператор мог послать на тот же
    /// планшет следующий документ: без сверки стиралась бы уже его сессия, и новый клиент, у
    /// которого документ на экране, получал бы на подписи «на этом планшете ничего не
    /// подписывают». Пусто означает «стереть то, что есть», как при возврате к рекламе.
    /// </param>
    public void ClearSignerSession(string deviceId, string? толькоСессию = null)
    {
        var стёрли = false;
        _storage.MutateStates(states =>
        {
            // Always write a per-device slides override (creating it if needed) so this device
            // returns to ads regardless of what the shared default is set to.
            if (!states.Devices.TryGetValue(deviceId, out var s))
            {
                s = states.Default.Clone();
                states.Devices[deviceId] = s;
            }
            if (толькоСессию is not null && !string.Equals(s.SessionId ?? "", толькоСессию, StringComparison.Ordinal))
                return;   // на планшете уже другой показ: он не наш, и трогать его нельзя
            стёрли = true;
            s.Mode = "slides";
            s.Fields.Clear();
            s.DynamicCheckboxes.Clear();
            s.CheckboxStates.Clear();
            s.GroupSelections.Clear();
            // Формулировки и варианты, присланные под конкретный заказ, это тоже его данные:
            // оставлять их лежать в состоянии после подписания незачем.
            s.Texts.Clear();
            s.GroupOptions.Clear();
            s.DocumentSetUtc = null;
            s.SessionId = null;
        });
        // Снимок сессии это тоже данные подписанта: уходит вместе с ними. Но только если мы
        // действительно стёрли свой показ, а не наткнулись на чужой.
        if (стёрли) _storage.DeleteDocSession(deviceId);
    }

    /// <summary>
    /// Ask ONE tablet to open its camera and scan a barcode / QR code. Scanning is a transient
    /// screen: it is not stored as a mode, so a reconnect returns the tablet to its normal screen
    /// and no scan session can outlive the tablet's session.
    /// </summary>
    public Task StartScanAsync(string deviceId) =>
        _hub.Clients.Group(DeviceGroup(deviceId)).SendAsync("StartScan");

    /// <summary>Cancel scanning on one tablet and return it to whatever it should be showing.</summary>
    public async Task StopScanAsync(string deviceId)
    {
        await _hub.Clients.Group(DeviceGroup(deviceId)).SendAsync("StopScan");
        var cmd = BuildCurrentCommand(deviceId);
        if (cmd.Mode == "document")
            // Имя сессии обязательно: по нему планшет понимает, что документ тот же самый, и не
            // начинает его заново. Без имени возврат с камеры стирал всё, что клиент заполнил.
            await _hub.Clients.Group(DeviceGroup(deviceId)).SendAsync("ShowDocument", cmd.Document, cmd.SessionId);
        else
            await _hub.Clients.Group(DeviceGroup(deviceId)).SendAsync("ShowSlides", cmd.Slides);
    }

    /// <summary>Tell admins the alert set changed so the bell and the alerts page update live.</summary>
    public Task NotifyAdminsAlertsAsync() => _hub.Clients.Group("admins").SendAsync("AlertsChanged");

    /// <summary>Tell admins a scan arrived so the scan page updates live.</summary>
    public Task NotifyAdminsScanAsync(ScanRecord rec) =>
        _hub.Clients.Group("admins").SendAsync("ScanReceived", new
        {
            id = rec.Id,
            createdUtc = rec.CreatedUtc,
            code = rec.Code,
            format = rec.Format,
            deviceId = rec.DeviceId,
            deviceName = rec.DeviceName,
            workstationName = rec.WorkstationName
        });

    /// <summary>Flash an identifying marker on one device; returns the code shown so the operator can match it.</summary>
    public async Task<string> IdentifyAsync(string deviceId)
    {
        var code = RandomNumberGenerator.GetInt32(100, 1000).ToString();
        var dev = _storage.GetDevice(deviceId);
        await _hub.Clients.Group(DeviceGroup(deviceId)).SendAsync("Identify", new { code, name = dev?.Name ?? deviceId });
        return code;
    }

    // ---------- Admin notifications ----------

    // Массовое переподключение планшетов, скажем после моргнувшего Wi-Fi или перезапуска службы,
    // это двести событий подряд. Каждое рассылалось во все открытые админки, и каждая в ответ
    // запрашивала полный список планшетов: двести запросов и двести полных списков за пару
    // секунд, хотя достаточно одного, потому что список всё равно приходит целиком.
    // Уведомления собираются в пачку: сразу после отправки берётся пауза, и всё случившееся за
    // это время схлопывается в одно уведомление. Последнее изменение при этом не теряется
    // никогда, оно лишь может прийти позже на длину паузы.
    private static readonly TimeSpan DevicesNotifyWindow = TimeSpan.FromMilliseconds(400);
    private readonly SemaphoreSlim _devicesSignal = new(0, 1);
    private int _devicesDirty;

    public Task NotifyAdminsDevicesAsync()
    {
        // Сигнал ставится только на переходе «чисто» в «грязно»: сто событий подряд оставляют
        // ровно один, и семафор ёмкостью в единицу никогда не переполняется.
        if (Interlocked.Exchange(ref _devicesDirty, 1) == 0) _devicesSignal.Release();
        return Task.CompletedTask;
    }

    private async Task DevicesNotifyLoopAsync()
    {
        while (true)
        {
            await _devicesSignal.WaitAsync();
            // Сброс до отправки, а не после: изменение, случившееся во время самой отправки,
            // поставит новый сигнал и будет разослано следующим кругом, а не пропадёт.
            Interlocked.Exchange(ref _devicesDirty, 0);
            try { await _hub.Clients.Group("admins").SendAsync("DevicesChanged"); }
            catch (Exception ex)
            {
                // Разослать не удалось: это не повод уронить цикл и остаться без уведомлений
                // до перезапуска службы.
                _log.LogWarning(ex, "Не удалось разослать обновление списка планшетов");
            }
            await Task.Delay(DevicesNotifyWindow);
        }
    }

    // ---------- Наблюдение за экраном планшета ----------
    // Кто за каким планшетом смотрит. Нужно, чтобы планшет рассказывал о себе только тогда,
    // когда его действительно смотрят: иначе он тратил бы батарею и канал круглые сутки.
    // Хранится в памяти и только на время соединений: наблюдение не оставляет следов.
    // Учёт ведётся под одним замком целиком. Раньше набор наблюдателей брался из словаря, а
    // замок ставился уже на него: последний уходящий наблюдатель убирал набор из словаря, и
    // тот, кто успел взять этот же набор мгновением раньше, вставал в список, которого в словаре
    // уже нет. Наблюдение при этом молча переставало существовать для сервера: планшет,
    // переподключившись, больше не получал «за тобой смотрят», и оператор смотрел на застывшую
    // картинку. Случай редкий, но при двухстах планшетах окна наблюдения открывают и закрывают
    // постоянно.
    private readonly Dictionary<string, HashSet<string>> _watchers = new(StringComparer.Ordinal);
    private readonly object _watchLock = new();

    /// <summary>
    /// Оператор начал или перестал смотреть за планшетом. Планшету сообщается только на границе:
    /// когда появился первый наблюдатель и когда ушёл последний.
    /// </summary>
    public async Task SetWatchAsync(string deviceId, string connectionId, bool on)
    {
        if (string.IsNullOrEmpty(deviceId) || string.IsNullOrEmpty(connectionId)) return;

        bool changed;
        lock (_watchLock)
        {
            _watchers.TryGetValue(deviceId, out var set);
            var was = set is { Count: > 0 };
            if (on)
            {
                set ??= new HashSet<string>(StringComparer.Ordinal);
                set.Add(connectionId);
                _watchers[deviceId] = set;
            }
            else if (set is not null)
            {
                set.Remove(connectionId);
                if (set.Count == 0) _watchers.Remove(deviceId);
            }
            changed = was != (set is { Count: > 0 });
        }
        if (!changed) return;
        await _hub.Clients.Group(DeviceGroup(deviceId)).SendAsync(on ? "WatchOn" : "WatchOff");
    }

    /// <summary>Сказать наблюдателям, что показанное на планшете сменилось целиком.</summary>
    public Task NotifyWatchersReloadAsync(string deviceId) =>
        IsWatched(deviceId) ? _hub.Clients.Group("watch:" + deviceId).SendAsync("WatchReload") : Task.CompletedTask;

    /// <summary>Смотрит ли кто-нибудь за этим планшетом прямо сейчас.</summary>
    public bool IsWatched(string deviceId)
    {
        lock (_watchLock) return _watchers.TryGetValue(deviceId, out var set) && set.Count > 0;
    }

    public Task NotifyAdminsSignatureAsync(SignatureRecord rec) =>
        _hub.Clients.Group("admins").SendAsync("SignatureReceived", new
        {
            id = rec.Id,
            createdUtc = rec.CreatedUtc,
            documentTitle = rec.DocumentTitle,
            deviceId = rec.DeviceId,
            deviceName = rec.DeviceName,
            workstationName = rec.WorkstationName,
            checkedCount = rec.Items.Count(i => i is { Checked: true }),
            totalCount = rec.Items.Count
        });
}
