using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using SignatureKiosk.Models;

namespace SignatureKiosk.Services;

/// <summary>
/// File-based persistence for the prototype: JSON documents + image/signature files
/// under a single data directory. No external database required.
/// </summary>
public class StorageService
{
    private readonly string _dataDir;
    private readonly object _lock = new();
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
    {
        WriteIndented = true
    };

    public StorageService(IConfiguration config, IHostEnvironment env)
    {
        var configured = config["DataDir"];
        _dataDir = string.IsNullOrWhiteSpace(configured)
            ? Path.Combine(env.ContentRootPath, "data")
            : configured!;
        Directory.CreateDirectory(_dataDir);
        Directory.CreateDirectory(ImagesDir);
        Directory.CreateDirectory(SignaturesDir);
        Directory.CreateDirectory(PdfDir);
    }

    public string DataDir => _dataDir;
    public string ImagesDir => Path.Combine(_dataDir, "images");
    public string SignaturesDir => Path.Combine(_dataDir, "signatures");
    public string PdfDir => Path.Combine(_dataDir, "pdf");

    public string? GetPdfPath(string id)
    {
        if (!IsSafeId(id)) return null;
        var path = Path.Combine(PdfDir, id + ".pdf");
        if (File.Exists(path)) return path;
        // Номер мог прийти прописными, прочитанный со штрихкода: Code 39 строчных букв не знает.
        // На Linux это другое имя файла, и бумага не находила сама себя.
        if (!Directory.Exists(PdfDir)) return null;
        foreach (var f in Directory.EnumerateFiles(PdfDir, "*.pdf"))
            if (string.Equals(Path.GetFileNameWithoutExtension(f), id, StringComparison.OrdinalIgnoreCase)) return f;
        return null;
    }
    private string StatesPath => Path.Combine(_dataDir, "states.json");
    private string DevicesPath => Path.Combine(_dataDir, "devices.json");
    private string GroupsPath => Path.Combine(_dataDir, "groups.json");
    private string WorkstationsPath => Path.Combine(_dataDir, "workstations.json");
    private string EnrollmentsPath => Path.Combine(_dataDir, "enrollments.json");
    private string ApiKeysPath => Path.Combine(_dataDir, "apikeys.json");
    private string DocumentPath => Path.Combine(_dataDir, "document.json");
    private string ImagesIndexPath => Path.Combine(_dataDir, "images.json");

    // ---------------- States ----------------

    public StateStore GetStates()
    {
        lock (_lock) return ReadOr(StatesPath, () => new StateStore());
    }

    /// <summary>
    /// Atomically read-modify-write the state store under the storage lock, so concurrent
    /// admin operations cannot lose each other's updates (no read/modify/write race).
    /// The mutate callback runs while the lock is held; it must not perform I/O or block.
    /// Returns whatever the callback computes (e.g. the list of devices to notify).
    /// </summary>
    public T MutateStates<T>(Func<StateStore, T> mutate)
    {
        lock (_lock)
        {
            var states = ReadOr(StatesPath, () => new StateStore());
            var result = mutate(states);
            Write(StatesPath, states);
            return result;
        }
    }

    public void MutateStates(Action<StateStore> mutate) =>
        MutateStates<object?>(states => { mutate(states); return null; });

    /// <summary>Resolve the effective state for a device (its override, or a copy of the default).</summary>
    public KioskState ResolveState(string deviceId)
    {
        lock (_lock)
        {
            var states = ReadOr(StatesPath, () => new StateStore());
            return states.Devices.TryGetValue(deviceId, out var s) ? s.Clone() : states.Default.Clone();
        }
    }

    // ---------------- Devices ----------------

    public List<Device> GetDevices()
    {
        lock (_lock) return ReadOr(DevicesPath, () => new List<Device>());
    }

    public Device? GetDevice(string id)
    {
        lock (_lock) return ReadOr(DevicesPath, () => new List<Device>()).FirstOrDefault(d => d.Id == id);
    }

    public void TouchDevice(string id, string? ip = null)
    {
        lock (_lock)
        {
            var list = ReadOr(DevicesPath, () => new List<Device>());
            var dev = list.FirstOrDefault(d => d.Id == id);
            if (dev == null) return;
            dev.LastSeenUtc = DateTime.UtcNow;
            if (!string.IsNullOrWhiteSpace(ip)) dev.LastIp = ip;
            Write(DevicesPath, list);
        }
    }

    // Разумные пределы для размера экрана. Числа приходят от страницы планшета, а её можно
    // открыть в чём угодно, вплоть до окна в один пиксель: заведомо бессмысленное значение
    // лучше не запоминать вовсе, чем показать оператору как размер его железа.
    private const int ScreenSideMin = 1;
    private const int ScreenSideMax = 10000;

    /// <summary>
    /// Планшет сообщил размер своего экрана. Записывается и рассылается только настоящее
    /// изменение: поворот планшета иначе означал бы запись файла на каждое промежуточное
    /// состояние разметки. Отказ отличается от «уже знаю» намеренно: по отказу планшет поймёт,
    /// что сведения не приняты, и не будет считать их доставленными.
    /// </summary>
    public DeviceScreenUpdate SetDeviceScreen(string id, int width, int height, double pixelRatio)
    {
        if (width < ScreenSideMin || width > ScreenSideMax) return DeviceScreenUpdate.Rejected;
        if (height < ScreenSideMin || height > ScreenSideMax) return DeviceScreenUpdate.Rejected;
        // Плотность округляется до сотых: дальше идут только погрешности вычисления масштаба, а
        // из-за них планшет сообщал бы «изменение» на ровном месте и заставлял все открытые
        // админки перечитывать список планшетов.
        // Негодная плотность означает «неизвестно», а не единицу. Раньше сюда подставлялась
        // единица, и карточка планшета уверенно писала «плотность 1» и считала по ней число
        // пикселей: выдуманное число, поданное как измеренное. Поле необязательное, и пусто в
        // нём уже значит «неизвестно», ровно как у ширины и высоты у планшета на старой
        // странице. Числа, которых мы не знаем, показывать нельзя.
        double? ratio = double.IsNaN(pixelRatio) || double.IsInfinity(pixelRatio) || pixelRatio <= 0 || pixelRatio > 20
            ? null
            : Math.Round(pixelRatio, 2, MidpointRounding.AwayFromZero);
        lock (_lock)
        {
            var list = ReadOr(DevicesPath, () => new List<Device>());
            var dev = list.FirstOrDefault(d => d.Id == id);
            if (dev == null) return DeviceScreenUpdate.Rejected;
            // Отозванный планшет не рассказывает о себе ничего. Отзыв закрывает вход по токену,
            // но соединение, открытое до отзыва, живёт до своего разрыва, и без этой проверки
            // отозванный планшет продолжал бы обновлять свою карточку в админке.
            if (dev.Status != "active") return DeviceScreenUpdate.Rejected;
            if (dev.ScreenWidth == width && dev.ScreenHeight == height && dev.ScreenPixelRatio == ratio)
                return DeviceScreenUpdate.Unchanged;
            dev.ScreenWidth = width;
            dev.ScreenHeight = height;
            dev.ScreenPixelRatio = ratio;
            Write(DevicesPath, list);
            return DeviceScreenUpdate.Changed;
        }
    }

    /// <param name="местоСменилось">
    /// Планшет действительно уехал с одного рабочего места на другое или был снят с места. Это
    /// не то же самое, что «место было в теле запроса»: запрос мог назвать то самое место, где
    /// планшет и так стоит. Вызывающий по этому признаку уводит экран планшета на рекламу, а
    /// зря уведённый экран это оборванное подписание у живого человека.
    /// </param>
    public bool UpdateDevice(string id, string? name, List<string>? groupIds, string? workstationId,
                             bool touchWorkstation, out bool местоСменилось)
    {
        местоСменилось = false;
        lock (_lock)
        {
            var list = ReadOr(DevicesPath, () => new List<Device>());
            var dev = list.FirstOrDefault(d => d.Id == id);
            if (dev == null) return false;
            if (!string.IsNullOrWhiteSpace(name)) dev.Name = name!.Trim();
            if (groupIds != null) dev.GroupIds = groupIds;
            if (touchWorkstation)
            {
                var новое = string.IsNullOrWhiteSpace(workstationId) ? null : workstationId;
                местоСменилось = !string.Equals(dev.WorkstationId, новое, StringComparison.Ordinal);
                dev.WorkstationId = новое;
            }
            Write(DevicesPath, list);
            return true;
        }
    }

    public bool SetDeviceStatus(string id, string status)
    {
        lock (_lock)
        {
            var list = ReadOr(DevicesPath, () => new List<Device>());
            var dev = list.FirstOrDefault(d => d.Id == id);
            if (dev == null) return false;
            dev.Status = status;
            Write(DevicesPath, list);
            return true;
        }
    }

    public bool DeleteDevice(string id)
    {
        lock (_lock)
        {
            var list = ReadOr(DevicesPath, () => new List<Device>());
            var dev = list.FirstOrDefault(d => d.Id == id);
            if (dev == null) return false;
            list.Remove(dev);
            Write(DevicesPath, list);
            var states = ReadOr(StatesPath, () => new StateStore());
            if (states.Devices.Remove(id)) Write(StatesPath, states);
            // И снимок открытой сессии. Его убирает уборка, но она ходит по списку состояний, из
            // которого запись уже вычеркнута строкой выше: файл с данными подписанта оставался
            // лежать на диске навсегда и не читался больше никем.
            DeleteDocSessionNoLock(id);
            return true;
        }
    }

    /// <summary>Чем кончилась привязка планшета к рабочему месту.</summary>
    public enum РезультатПривязки { Готово, НетПланшета, НетМеста }

    /// <summary>
    /// Assign a device to a workstation identified by the external system's id. Пустой код
    /// означает отвязку, и решает это вызывающий: молча отвязать планшет по недосланному полю
    /// нельзя, потому что снаружи это выглядит как обычное «ок».
    /// </summary>
    /// <remarks>
    /// Раньше возвращалось одно «нет» на два разных случая, и внешняя система получала
    /// «device or workstation not found», не зная, что чинить: несуществующий номер планшета или
    /// код рабочего места, которого ещё не завели.
    /// </remarks>
    public РезультатПривязки AssignWorkstationByExternalId(string deviceId, string? externalId) =>
        AssignWorkstationByExternalId(deviceId, externalId, out _);

    /// <param name="местоСменилось">
    /// Планшет действительно уехал с места или был снят с него. Повторная привязка к тому же
    /// месту сменой не считается: по этому признаку вызывающий уводит экран на рекламу, а зря
    /// уведённый экран это оборванное подписание у живого человека.
    /// </param>
    public РезультатПривязки AssignWorkstationByExternalId(string deviceId, string? externalId, out bool местоСменилось)
    {
        местоСменилось = false;
        lock (_lock)
        {
            // Планшет проверяется первым: он адресат запроса, и если его нет, всё остальное уже
            // неважно.
            var list = ReadOr(DevicesPath, () => new List<Device>());
            var dev = list.FirstOrDefault(d => d.Id == deviceId);
            if (dev == null) return РезультатПривязки.НетПланшета;

            var wsId = (string?)null;
            var код = (externalId ?? "").Trim();
            if (код.Length > 0)
            {
                // Код рабочего места сравнивается без учёта регистра и без окружающих пробелов,
                // как и везде: завести два места с кодами «Room-1» и «room-1» система не даёт,
                // значит и искать место по коду надо одинаково во всех местах.
                var ws = ReadOr(WorkstationsPath, () => new List<Workstation>())
                    .FirstOrDefault(w => string.Equals((w.ExternalId ?? "").Trim(), код, StringComparison.OrdinalIgnoreCase));
                if (ws == null) return РезультатПривязки.НетМеста;
                wsId = ws.Id;
            }
            местоСменилось = !string.Equals(dev.WorkstationId, wsId, StringComparison.Ordinal);
            dev.WorkstationId = wsId;
            Write(DevicesPath, list);
            return РезультатПривязки.Готово;
        }
    }

    // ---------------- Groups ----------------

    public List<DeviceGroup> GetGroups()
    {
        lock (_lock) return ReadOr(GroupsPath, () => new List<DeviceGroup>());
    }

    public DeviceGroup AddGroup(string name)
    {
        lock (_lock)
        {
            var list = ReadOr(GroupsPath, () => new List<DeviceGroup>());
            var g = new DeviceGroup { Id = "grp-" + ShortId(), Name = string.IsNullOrWhiteSpace(name) ? "Группа" : name.Trim() };
            list.Add(g);
            Write(GroupsPath, list);
            return g;
        }
    }

    public bool RenameGroup(string id, string name)
    {
        lock (_lock)
        {
            var list = ReadOr(GroupsPath, () => new List<DeviceGroup>());
            var g = list.FirstOrDefault(x => x.Id == id);
            if (g == null) return false;
            g.Name = string.IsNullOrWhiteSpace(name) ? g.Id : name.Trim();
            Write(GroupsPath, list);
            return true;
        }
    }

    public bool DeleteGroup(string id)
    {
        lock (_lock)
        {
            var list = ReadOr(GroupsPath, () => new List<DeviceGroup>());
            var g = list.FirstOrDefault(x => x.Id == id);
            if (g == null) return false;
            list.Remove(g);
            Write(GroupsPath, list);
            // remove membership from devices
            var devs = ReadOr(DevicesPath, () => new List<Device>());
            bool changed = false;
            foreach (var d in devs) changed |= d.GroupIds.Remove(id);
            if (changed) Write(DevicesPath, devs);
            // Картинки тоже ссылаются на группы. Оставить ссылку на удалённую группу значит
            // молча выключить картинку везде: список «показывать в группах» не пуст, а совпасть
            // с ним уже некому.
            var imgs = ReadOr(ImagesIndexPath, () => new List<ImageInfo>());
            bool картинкиИзменились = false;
            foreach (var i in imgs)
            {
                картинкиИзменились |= i.GroupIds.Remove(id);
                картинкиИзменились |= i.ExceptGroupIds.Remove(id);
            }
            if (картинкиИзменились) Write(ImagesIndexPath, imgs);
            return true;
        }
    }

    // ---------------- Workstations ----------------

    public List<Workstation> GetWorkstations()
    {
        lock (_lock) return ReadOr(WorkstationsPath, () => new List<Workstation>());
    }

    /// <summary>
    /// Занят ли код рабочего места кем-то, кроме названной записи. Сравнение то же, что и везде,
    /// где код места читается: без учёта регистра и окружающих пробелов.
    /// </summary>
    private static Workstation? КодЗанят(List<Workstation> список, string код, string? кромеId) =>
        список.FirstOrDefault(w => !string.Equals(w.Id, кромеId, StringComparison.Ordinal)
            && string.Equals((w.ExternalId ?? "").Trim(), код, StringComparison.OrdinalIgnoreCase));

    /// <summary>
    /// Завести рабочее место. Второй возвращаемый это причина отказа или null.
    /// </summary>
    /// <remarks>
    /// Проверка на повтор кода стоит здесь, в хранилище, а не в обработчике: раньше она была
    /// только на внешнем пути POST /api/ext/workstations, а админский путь, которым место и
    /// заводит оператор, пропускал повтор молча.
    ///
    /// Чем это кончалось, замерено: два места с кодом «3244», планшет привязан ко второму, на
    /// связи, карточка в порядке. Заказ по коду «3244» отвечает 404 «на этом месте нет
    /// планшета», потому что отбор берёт первое совпадение и до второго не доходит. Оператор
    /// идёт искать поломку в планшете и в сети, а поломка в списке мест. Второй исход хуже:
    /// два живых планшета в разных кабинетах с одним кодом, и документ молча уходит к тому,
    /// кто в списке раньше, то есть к чужому человеку.
    ///
    /// Для кода документа такая проверка есть и отказ произносится вслух. Код места, который на
    /// карточке планшета так и подписан «код для API», стоял без неё.
    /// </remarks>
    public (Workstation? Место, string? Ошибка) AddWorkstation(string? externalId, string? name, string? location)
    {
        lock (_lock)
        {
            var list = ReadOr(WorkstationsPath, () => new List<Workstation>());
            var код = (externalId ?? "").Trim();
            if (код.Length > 0)
            {
                var чужое = КодЗанят(list, код, null);
                if (чужое is not null)
                    return (null, "Код «" + код + "» уже занят рабочим местом «" + чужое.Name + "». " +
                                  "Код рабочего места это адрес, по которому внешняя система шлёт документ, " +
                                  "и он должен быть один на всю систему. Регистр и пробелы по краям не " +
                                  "считаются: «" + код + "» и «" + код.ToUpperInvariant() + "» это один код.");
            }
            var w = new Workstation
            {
                Id = "ws-" + ShortId(),
                ExternalId = код,
                Name = string.IsNullOrWhiteSpace(name) ? "Рабочее место" : name!.Trim(),
                Location = (location ?? "").Trim()
            };
            list.Add(w);
            Write(WorkstationsPath, list);
            return (w, null);
        }
    }

    /// <summary>Чем кончилась правка рабочего места.</summary>
    public enum РезультатПравкиМеста { Готово, НетМеста, КодЗанят }

    /// <summary>
    /// Изменить рабочее место. Отдельный случай КодЗанят: раньше правка могла вписать записи чужой
    /// код, и работавший адрес умирал на месте. Замер: место «КАБ-77» с живым планшетом показывает
    /// документ; PUT вписывает «КАБ-77» другой, пустой записи; сразу после этого заказ по «КАБ-77»
    /// отвечает 404, а планшет возвращается на рекламу. Ни одного предупреждения по дороге.
    /// </summary>
    public РезультатПравкиМеста UpdateWorkstation(string id, string? externalId, string? name,
                                                  string? location, out string? ошибка)
    {
        ошибка = null;
        lock (_lock)
        {
            var list = ReadOr(WorkstationsPath, () => new List<Workstation>());
            var w = list.FirstOrDefault(x => x.Id == id);
            if (w == null) return РезультатПравкиМеста.НетМеста;
            if (externalId != null)
            {
                var код = externalId.Trim();
                if (код.Length > 0)
                {
                    var чужое = КодЗанят(list, код, id);
                    if (чужое is not null)
                    {
                        ошибка = "Код «" + код + "» уже занят рабочим местом «" + чужое.Name + "». " +
                                 "Код рабочего места это адрес, по которому внешняя система шлёт документ, " +
                                 "и он должен быть один на всю систему.";
                        return РезультатПравкиМеста.КодЗанят;
                    }
                }
                w.ExternalId = код;
            }
            if (!string.IsNullOrWhiteSpace(name)) w.Name = name.Trim();
            if (location != null) w.Location = location.Trim();
            Write(WorkstationsPath, list);
            return РезультатПравкиМеста.Готово;
        }
    }

    /// <summary>
    /// Удалить рабочее место. Возвращается список планшетов, которые этим с места сняты, или
    /// null, если места с таким номером нет. Список нужен вызывающему: у снятого планшета на
    /// экране может стоять открытый документ с данными клиента, и его надо увести на рекламу.
    /// </summary>
    public List<string>? DeleteWorkstation(string id)
    {
        lock (_lock)
        {
            var list = ReadOr(WorkstationsPath, () => new List<Workstation>());
            var w = list.FirstOrDefault(x => x.Id == id);
            if (w == null) return null;
            list.Remove(w);
            Write(WorkstationsPath, list);
            var devs = ReadOr(DevicesPath, () => new List<Device>());
            var снятые = new List<string>();
            foreach (var d in devs) if (d.WorkstationId == id) { d.WorkstationId = null; снятые.Add(d.Id); }
            if (снятые.Count > 0) Write(DevicesPath, devs);
            return снятые;
        }
    }

    // ---------------- Enrollment ----------------

    public Enrollment CreateEnrollment(string? name, string? workstationId, List<string>? groupIds, int ttlMinutes)
    {
        lock (_lock)
        {
            var list = ReadOr(EnrollmentsPath, () => new List<Enrollment>());
            // prune used or long-expired codes to keep the file small
            var now = DateTime.UtcNow;
            list.RemoveAll(e => e.UsedByDeviceId != null || e.ExpiresUtc < now.AddDays(-1));
            var e = new Enrollment
            {
                Code = FriendlyCode(),
                Name = string.IsNullOrWhiteSpace(name) ? null : name!.Trim(),
                WorkstationId = string.IsNullOrWhiteSpace(workstationId) ? null : workstationId,
                GroupIds = groupIds ?? new List<string>(),
                CreatedUtc = now,
                ExpiresUtc = now.AddMinutes(ttlMinutes > 0 ? ttlMinutes : 60)
            };
            list.Add(e);
            Write(EnrollmentsPath, list);
            return e;
        }
    }

    /// <summary>Redeem a code: create a device and return it plus the one-time token (id.secret).</summary>
    public (Device device, string token)? RedeemEnrollment(string? code)
    {
        if (string.IsNullOrWhiteSpace(code)) return null;
        code = code.Trim().ToUpperInvariant();
        lock (_lock)
        {
            var enrolls = ReadOr(EnrollmentsPath, () => new List<Enrollment>());
            var e = enrolls.FirstOrDefault(x => x.Code == code);
            if (e == null || e.UsedByDeviceId != null || e.ExpiresUtc < DateTime.UtcNow) return null;

            var devices = ReadOr(DevicesPath, () => new List<Device>());
            var id = "dev-" + ShortId();
            var secret = RandomToken(24);
            var now = DateTime.UtcNow;
            var dev = new Device
            {
                Id = id,
                Name = string.IsNullOrWhiteSpace(e.Name) ? "Планшет " + id[^4..] : e.Name!,
                SecretHash = Sha256Hex(secret),
                GroupIds = e.GroupIds ?? new List<string>(),
                WorkstationId = e.WorkstationId,
                EnrolledUtc = now,
                LastSeenUtc = now,
                Status = "active"
            };
            devices.Add(dev);
            Write(DevicesPath, devices);

            e.UsedByDeviceId = id;
            Write(EnrollmentsPath, enrolls);

            return (dev, id + "." + secret);
        }
    }

    // ---------------- API keys ----------------

    public List<ApiKey> GetApiKeys()
    {
        lock (_lock) return ReadOr(ApiKeysPath, () => new List<ApiKey>());
    }

    public (ApiKey key, string plaintext) CreateApiKey(string? label)
    {
        lock (_lock)
        {
            var list = ReadOr(ApiKeysPath, () => new List<ApiKey>());
            var plaintext = "sk_" + RandomToken(30);
            var k = new ApiKey
            {
                Id = "key-" + ShortId(),
                KeyHash = Sha256Hex(plaintext),
                Label = string.IsNullOrWhiteSpace(label) ? "API key" : label!.Trim(),
                CreatedUtc = DateTime.UtcNow
            };
            list.Add(k);
            Write(ApiKeysPath, list);
            return (k, plaintext);
        }
    }

    public bool DeleteApiKey(string id)
    {
        lock (_lock)
        {
            var list = ReadOr(ApiKeysPath, () => new List<ApiKey>());
            var k = list.FirstOrDefault(x => x.Id == id);
            if (k == null) return false;
            list.Remove(k);
            Write(ApiKeysPath, list);
            return true;
        }
    }

    /// <summary>
    /// Выключить или включить ключ, не удаляя его. Раньше ключ можно было только удалить, а это
    /// необратимо: чтобы на час перекрыть доступ подозрительной интеграции, приходилось стирать
    /// ключ и потом заново настраивать чужую систему. Возвращает false, если такого ключа нет.
    /// </summary>
    public bool SetApiKeyDisabled(string id, bool disabled)
    {
        lock (_lock)
        {
            var list = ReadOr(ApiKeysPath, () => new List<ApiKey>());
            var k = list.FirstOrDefault(x => x.Id == id);
            if (k == null) return false;
            if (k.Disabled == disabled) return true;          // менять нечего, файл не трогаем
            k.Disabled = disabled;
            Write(ApiKeysPath, list);
            return true;
        }
    }

    public bool ValidateApiKey(string? key)
    {
        if (string.IsNullOrWhiteSpace(key)) return false;
        var hash = Sha256Hex(key);
        lock (_lock)
        {
            // Сравнение за постоянное время, как и для токена планшета: по времени ответа не
            // должно быть видно, насколько присланный ключ близок к настоящему.
            var bytes = Encoding.UTF8.GetBytes(hash);
            var found = false;
            foreach (var k in ReadOr(ApiKeysPath, () => new List<ApiKey>()))
                // Выключенный ключ сравнивается наравне с остальными и только потом отбрасывается:
                // иначе по времени ответа было бы видно, что ключ угадан верно, просто выключен.
                if (CryptographicOperations.FixedTimeEquals(bytes, Encoding.UTF8.GetBytes(k.KeyHash ?? "")) && !k.Disabled)
                    found = true;
            return found;
        }
    }

    // ---------------- Images ----------------

    /// <summary>
    /// В каких документах библиотеки стоит эта картинка. Отдаются названия для человека, а не
    /// внутренние номера: список показывается оператору в отказе на удаление.
    /// </summary>
    /// <remarks>
    /// Ссылка в блоке хранится как «/media/имя-файла», а иногда с запросом на конце. Поэтому
    /// сравнивается имя файла, а не строка целиком.
    /// </remarks>
    public List<string> ГдеСтоитКартинка(string? имяФайла)
    {
        var файл = (имяФайла ?? "").Trim();
        var где = new List<string>();
        if (файл.Length == 0) return где;
        lock (_lock)
        {
            foreach (var info in ЧитатьСписокNoLock())
            {
                var док = GetDocumentNoLock(info.Id);
                if (док is null) continue;
                var нашлось = false;
                foreach (var стр in док.Pages ?? new List<DocPage>())
                {
                    foreach (var б in стр.Blocks ?? new List<DocBlock>())
                    {
                        var url = (б?.ImageUrl ?? "").Trim();
                        if (url.Length == 0) continue;
                        var имя = url.Split('?')[0].Split('/').LastOrDefault() ?? "";
                        if (string.Equals(имя, файл, StringComparison.OrdinalIgnoreCase)) { нашлось = true; break; }
                    }
                    if (нашлось) break;
                }
                if (нашлось) где.Add(ИмяДляСписка(док.Title, info.Name, info.Code));
            }
        }
        return где;
    }

    public List<ImageInfo> GetImages()
    {
        lock (_lock) return ReadOr(ImagesIndexPath, () => new List<ImageInfo>());
    }

    public ImageInfo AddImage(Stream content, string originalName, string ext)
    {
        var id = Guid.NewGuid().ToString("N");
        ext = ext.StartsWith('.') ? ext : "." + ext;
        var fileName = id + ext;

        // Copy the (possibly large, network-backed) upload to disk WITHOUT holding the storage
        // lock, so a slow upload cannot stall concurrent state mutations or SignalR pushes. The
        // file name is a fresh GUID, so there is no collision with any other writer.
        using (var fs = File.Create(Path.Combine(ImagesDir, fileName)))
            content.CopyTo(fs);

        var info = new ImageInfo
        {
            Id = id,
            FileName = fileName,
            OriginalName = originalName,
            UploadedUtc = DateTime.UtcNow
        };
        lock (_lock)
        {
            var list = ReadOr(ImagesIndexPath, () => new List<ImageInfo>());
            list.Add(info);
            Write(ImagesIndexPath, list);
        }
        return info;
    }

    /// <summary>
    /// Вернуть картинку из файла шаблона под тем именем, на которое ссылается документ. Файл и
    /// запись в указателе появляются вместе: файл без записи не виден в медиатеке, а запись без
    /// файла показывает пустую рамку. Уже существующее имя не трогается: его могли заменить
    /// нарочно. Возвращает true, если картинка действительно добавлена.
    /// </summary>
    public bool RestoreImage(string fileName, byte[] bytes, string originalName)
    {
        var name = Path.GetFileName(fileName ?? "");
        if (name.Length == 0 || name != fileName || bytes is null || bytes.Length == 0) return false;
        var id = Path.GetFileNameWithoutExtension(name);
        if (id.Length == 0) return false;

        lock (_lock)
        {
            var list = ReadOr(ImagesIndexPath, () => new List<ImageInfo>());
            if (list.Any(i => string.Equals(i.FileName, name, StringComparison.OrdinalIgnoreCase))) return false;

            var path = Path.Combine(ImagesDir, name);
            if (!File.Exists(path)) File.WriteAllBytes(path, bytes);
            list.Add(new ImageInfo
            {
                Id = id,
                FileName = name,
                OriginalName = string.IsNullOrWhiteSpace(originalName) ? name : originalName,
                UploadedUtc = DateTime.UtcNow
            });
            Write(ImagesIndexPath, list);
            return true;
        }
    }

    /// <summary>Задать сроки показа картинки. Пусто означает «без ограничения» с этой стороны.</summary>
    public bool SetImageDates(string id, string? showFrom, string? showTo)
    {
        lock (_lock)
        {
            var list = ReadOr(ImagesIndexPath, () => new List<ImageInfo>());
            var img = list.FirstOrDefault(i => i.Id == id);
            if (img is null) return false;
            img.ShowFrom = string.IsNullOrWhiteSpace(showFrom) ? null : showFrom;
            img.ShowTo = string.IsNullOrWhiteSpace(showTo) ? null : showTo;
            Write(ImagesIndexPath, list);
            return true;
        }
    }

    /// <summary>
    /// Задать, где показывать картинку: в каких группах и в каких не показывать. Пустые списки
    /// означают «везде»: так ведут себя все картинки, которым группы не задавали.
    /// </summary>
    public bool SetImageGroups(string id, IEnumerable<string>? groupIds, IEnumerable<string>? exceptGroupIds)
    {
        lock (_lock)
        {
            var list = ReadOr(ImagesIndexPath, () => new List<ImageInfo>());
            var img = list.FirstOrDefault(i => i.Id == id);
            if (img is null) return false;
            // Оставляем только существующие группы: удалённая группа иначе висела бы в настройке
            // вечно и молча вырезала картинку у всех, не давая понять почему.
            var живые = ReadOr(GroupsPath, () => new List<DeviceGroup>()).Select(g => g.Id).ToHashSet(StringComparer.Ordinal);
            img.GroupIds = (groupIds ?? Array.Empty<string>()).Where(живые.Contains).Distinct(StringComparer.Ordinal).ToList();
            img.ExceptGroupIds = (exceptGroupIds ?? Array.Empty<string>()).Where(живые.Contains).Distinct(StringComparer.Ordinal).ToList();
            Write(ImagesIndexPath, list);
            return true;
        }
    }

    public bool DeleteImage(string id)
    {
        lock (_lock)
        {
            var list = ReadOr(ImagesIndexPath, () => new List<ImageInfo>());
            var img = list.FirstOrDefault(i => i.Id == id);
            if (img == null) return false;
            list.Remove(img);
            Write(ImagesIndexPath, list);

            var path = Path.Combine(ImagesDir, img.FileName);
            if (File.Exists(path)) File.Delete(path);

            var states = ReadOr(StatesPath, () => new StateStore());
            bool changed = states.Default.PlaylistImageIds.Remove(id);
            foreach (var s in states.Devices.Values)
                changed |= s.PlaylistImageIds.Remove(id);
            if (changed) Write(StatesPath, states);
            return true;
        }
    }

    // ---------------- Document ----------------

    // ---------------- Библиотека документов ----------------
    // Документов может быть несколько: согласие, договор, анкета. Каждый лежит своим файлом,
    // а список с кодами и названиями отдельно: список открывается, не читая тексты всех
    // документов сразу. Документ по умолчанию показывается, когда запрос пришёл без кода, и
    // ровно он же лежит в document.json, чтобы всё написанное до библиотеки работало как было.

    private string DocumentsDir => Path.Combine(_dataDir, "documents");
    private string LibraryPath => Path.Combine(_dataDir, "documents.json");

    /// <summary>Сколько документов может быть в библиотеке. Больше и список перестаёт быть списком.</summary>
    public const int MaxDocuments = 50;

    private string? DocFilePath(string id)
    {
        var v = (id ?? "").Trim();
        if (v.Length == 0 || v.Length > 64 || !v.All(ch => char.IsLetterOrDigit(ch) || ch == '-' || ch == '_'))
            return null;
        return Path.Combine(DocumentsDir, v + ".json");
    }

    /// <summary>
    /// Как зовётся документ. Имя одно, и это его заголовок: заголовок оператор видит в редакторе
    /// и правит, значит он и есть имя. Отдельное «название» остаётся только документу без
    /// заголовка, а если пусто и оно, имя это код документа: безымянных документов не бывает.
    /// </summary>
    private static string ИмяДляСписка(string? title, string? запасное, string? code)
    {
        var t = (title ?? "").Trim();
        if (t.Length > 0) return t;
        var з = (запасное ?? "").Trim();
        if (з.Length > 0) return з;
        return (code ?? "").Trim();
    }

    /// <summary>
    /// Заголовок из файла документа, дёшево. Сверка имён идёт на каждое чтение списка, и читать
    /// ради неё все тексты нельзя: при пятидесяти документах это пятьдесят разборов JSON на
    /// каждый показ документа. Метка времени и размер это один вопрос файловой системе, а разбор
    /// случается только у файла, который с прошлого раза менялся. Сам текст берётся из общего
    /// кэша, поэтому лишнего чтения с диска сверка не добавляет.
    /// null означает «не знаю»: файла нет или он не разбирается. Повреждённый файл здесь не
    /// подменяется и не уносится в карантин: сверка пассивна и чужого имени документу не даёт.
    /// </summary>
    private readonly Dictionary<string, (DateTime Stamp, long Length, string? Title)> _docTitle = new(StringComparer.Ordinal);

    private sealed class ТолькоЗаголовок { public string? Title { get; set; } }

    private string? ЗаголовокФайла(string path)
    {
        var info = new FileInfo(path);
        if (!info.Exists) { _docTitle.Remove(path); return null; }
        if (_docTitle.TryGetValue(path, out var было)
            && было.Stamp == info.LastWriteTimeUtc && было.Length == info.Length)
            return было.Title;
        string? текст;
        try { текст = ReadText(path); } catch { текст = null; }
        if (текст is null) { _docTitle.Remove(path); return null; }
        string? title = null;
        try { title = JsonSerializer.Deserialize<ТолькоЗаголовок>(текст, Json)?.Title; }
        catch { title = null; }
        info.Refresh();
        _docTitle[path] = (info.LastWriteTimeUtc, info.Length, title);
        return title;
    }

    /// <summary>
    /// Свести имена в списке с заголовками документов. Возвращает true, если что-то изменилось и
    /// список надо записать. Это же чинит данные, слежавшиеся до правила «имя это заголовок»:
    /// они выравниваются при первом чтении списка и больше не расходятся.
    /// Документ, чей файл пропал или не разбирается, не трогается вовсе: на «не знаю» честный
    /// ответ это «не знаю», а не подмена имени. Пустой заголовок имя тоже не затирает.
    /// </summary>
    private bool СвестиИмена(List<DocumentInfo> список)
    {
        var изменилось = false;
        foreach (var info in список)
        {
            var path = info.IsDefault ? DocumentPath : DocFilePath(info.Id);
            if (path is null) continue;
            var title = ЗаголовокФайла(path);
            if (title is null) continue;
            var имя = ИмяДляСписка(title, info.Name, info.Code);
            if (имя.Length == 0 || имя == info.Name) continue;
            info.Name = имя;
            изменилось = true;
        }
        return изменилось;
    }

    /// <summary>
    /// Список документов. Библиотеки может не быть вовсе: так выглядит установка, обновлённая с
    /// прежней версии. Тогда она заводится из единственного document.json, и он же становится
    /// документом по умолчанию. Ничего не теряется и не переезжает: файл остаётся на месте.
    /// </summary>
    public List<DocumentInfo> GetDocuments()
    {
        lock (_lock) return ЧитатьСписокNoLock();
    }

    private List<DocumentInfo> ЧитатьСписокNoLock()
    {
        var lib = ReadOr(LibraryPath, () => new DocumentLibrary());
        if (lib.Documents.Count == 0)
        {
            var первый = new DocumentInfo
            {
                Id = "main",
                Code = "main",
                Name = ИмяДляСписка(ReadOr(DocumentPath, DefaultDocument).Title, "Документ", "main"),
                IsDefault = true,
                UpdatedUtc = DateTime.UtcNow
            };
            lib.Documents.Add(первый);
            Write(LibraryPath, lib);
            return lib.Documents;
        }
        // Записываем только когда действительно что-то разошлось: иначе каждое чтение списка,
        // а оно случается на каждый показ документа, превращалось бы в запись файла.
        if (СвестиИмена(lib.Documents)) Write(LibraryPath, lib);
        return lib.Documents;
    }

    public DocumentInfo? GetDocumentInfo(string? id)
    {
        var v = (id ?? "").Trim();
        return GetDocuments().FirstOrDefault(d => string.Equals(d.Id, v, StringComparison.OrdinalIgnoreCase));
    }

    /// <summary>Документ по коду. Код сравнивается без учёта регистра, как и всё остальное.</summary>
    public DocumentInfo? FindByCode(string? code)
    {
        var v = (code ?? "").Trim();
        if (v.Length == 0) return null;
        return GetDocuments().FirstOrDefault(d => string.Equals(d.Code, v, StringComparison.OrdinalIgnoreCase));
    }

    public DocumentInfo DefaultDocumentInfo()
    {
        var list = GetDocuments();
        return list.FirstOrDefault(d => d.IsDefault) ?? list[0];
    }

    /// <summary>
    /// Текст документа по его идентификатору. Документ по умолчанию читается из document.json:
    /// так установка, обновлённая с прежней версии, продолжает работать без переноса файлов.
    /// </summary>
    public DocumentConfig GetDocument(string? id = null)
    {
        lock (_lock) return GetDocumentNoLock(id);
    }

    /// <summary>
    /// Чем отвечать, когда файла документа нет или он не читается. Текст образцовый, а имя своё:
    /// иначе документ, открытый после потери файла, зовётся чужим заголовком при своём имени в
    /// списке, и вкладка переименовывается при переходе на неё. Как зовётся документ, не зависит
    /// от того, цел ли его текст.
    /// </summary>
    private static DocumentConfig ОбразецДля(DocumentInfo? info)
    {
        var doc = DefaultDocument();
        var имя = ИмяДляСписка(null, info?.Name, info?.Code);
        if (имя.Length > 0) doc.Title = имя;
        return doc;
    }

    /// <summary>Запись о документе по умолчанию, не заводя библиотеку, если её ещё нет.</summary>
    private DocumentInfo? DefaultInfoNoLock()
    {
        var lib = ReadOr(LibraryPath, () => new DocumentLibrary());
        return lib.Documents.FirstOrDefault(d => d.IsDefault) ?? lib.Documents.FirstOrDefault();
    }

    /// <summary>
    /// Текст документа по номеру, но честно: неизвестный номер это false, а не документ по
    /// умолчанию. Нужно там, где номер приходит снаружи: показать оператору чужой текст под
    /// именем запрошенного документа хуже, чем сказать, что такого документа нет.
    /// </summary>
    public bool TryGetDocument(string? id, out DocumentConfig doc)
    {
        lock (_lock)
        {
            if (string.IsNullOrWhiteSpace(id)) { doc = GetDocumentNoLock(null); return true; }
            var info = GetDocumentInfoNoLock(id!);
            if (info is null) { doc = DefaultDocument(); return false; }
            doc = GetDocumentNoLock(info.Id);
            return true;
        }
    }

    private DocumentInfo? GetDocumentInfoNoLock(string id)
    {
        var lib = ReadOr(LibraryPath, () => new DocumentLibrary());
        return lib.Documents.FirstOrDefault(d => string.Equals(d.Id, (id ?? "").Trim(), StringComparison.OrdinalIgnoreCase));
    }

    /// <summary>
    /// Записать текст документа. Неизвестный идентификатор это отказ, а не запись в документ по
    /// умолчанию: молчаливая подмена означала бы, что «сохрани документ X» затирает совсем другой
    /// документ. Возвращает false, если такого документа нет.
    /// </summary>
    public bool SaveDocument(string? id, DocumentConfig doc)
    {
        lock (_lock)
        {
            var info = id is null ? null : GetDocumentInfoNoLock(id);
            if (id is not null && info is null) return false;
            // false здесь означает, что имя документа не годится для файла: писать некуда.
            if (!ЗаписатьТекстNoLock(info, doc)) return false;
            TouchDocument(info?.Id ?? DefaultIdNoLock(), doc.Title, doc.Kind);
            return true;
        }
    }

    private string DefaultIdNoLock()
    {
        var lib = ReadOr(LibraryPath, () => new DocumentLibrary());
        var def = lib.Documents.FirstOrDefault(d => d.IsDefault) ?? lib.Documents.FirstOrDefault();
        return def?.Id ?? "main";
    }

    /// <summary>
    /// Отметить правку документа в списке. Название берётся из заголовка самого документа: два
    /// имени у одной вещи это путаница, из-за которой на закладке было написано одно, а в поле
    /// «Заголовок документа» другое. Заголовок оператор видит и правит, значит он и есть имя.
    /// Вид повторяется здесь же, чтобы список рисовался, не читая тексты всех документов.
    /// </summary>
    private void TouchDocument(string id, string? title, string? kind = null)
    {
        var lib = ReadOr(LibraryPath, () => new DocumentLibrary());
        var info = lib.Documents.FirstOrDefault(d => d.Id == id);
        if (info is null) return;
        info.UpdatedUtc = DateTime.UtcNow;
        info.Kind = kind;
        // Пустой заголовок имя не затирает: документ без заголовка остался бы безымянным.
        // Тогда именем остаётся прежнее название, а если нет и его, код документа.
        info.Name = ИмяДляСписка(title, info.Name, info.Code);
        Write(LibraryPath, lib);
    }

    /// <summary>Завести документ. Возвращает его или сообщение, почему нельзя.</summary>
    public (DocumentInfo? Info, string? Error) AddDocument(string? code, string? name, string? copyOfId)
    {
        lock (_lock)
        {
            var список = GetDocumentsNoLock();
            if (список.Count >= MaxDocuments)
                return (null, "Больше " + MaxDocuments + " документов не бывает: список перестанет быть списком.");
            var чистыйКод = CleanDocCode(code);
            if (чистыйКод.Length == 0)
                return (null, "Код документа обязателен: по нему документ вызывается из внешней системы.");
            if (список.Any(d => string.Equals(d.Code, чистыйКод, StringComparison.OrdinalIgnoreCase)))
                return (null, "Код «" + чистыйКод + "» уже занят другим документом.");

            // Копия делается с уже сохранённого документа. А новый начинается чистым: одна пустая
            // страница и заголовок, который оператор только что ввёл. Прежде новый заводился
            // копией образцового согласия, и человек, нажавший «Новый документ», получал чужой
            // готовый текст про обработку персональных данных и не понимал, откуда он взялся.
            // Копия неизвестного документа это отказ, а не копия документа по умолчанию: «сделай
            // копию документа X» отдавало копию совсем другого, и оператор об этом не узнавал.
            if (!string.IsNullOrWhiteSpace(copyOfId) && GetDocumentInfoNoLock(copyOfId!) is null)
                return (null, "Документ, с которого делается копия, не найден.");
            var заданное = (name ?? "").Trim();
            var копия = !string.IsNullOrWhiteSpace(copyOfId);
            var текст = копия
                ? GetDocumentNoLock(copyOfId!)
                : new DocumentConfig
                {
                    Pages = new List<DocPage> { new() { HeadingRuns = new List<TextRun> { new() { Text = "Страница 1" } } } }
                };
            // Заголовок нового документа задаётся здесь и один раз: имя в списке потом снимается
            // с него, а не живёт второй строкой. У копии, если оператор своего имени не дал,
            // заголовок делается из исходного и не остаётся его тёзкой: две одинаковые строки в
            // списке это и есть та путаница, из-за которой всё чинится третий раз.
            if (копия && заданное.Length == 0)
            {
                var исходный = GetDocumentInfoNoLock(copyOfId!);
                var основа = ИмяДляСписка(текст.Title, исходный?.Name, исходный?.Code);
                текст.Title = СвободноеИмяКопии(основа.Length > 0 ? основа : чистыйКод, список);
            }
            else
            {
                текст.Title = ИмяДляСписка(заданное, null, чистыйКод);
            }

            var info = new DocumentInfo
            {
                Id = Guid.NewGuid().ToString("N")[..12],
                Code = чистыйКод,
                Name = ИмяДляСписка(текст.Title, заданное, чистыйКод),
                IsDefault = false,
                // Вид берётся из самого текста, а не остаётся пустым. Копия информационного
                // документа заводилась записью без вида, то есть подписной, и на её закладке
                // стояло перо, а в редакторе рядом было написано «Этот документ не подписывают».
                // Закладка спорила с редактором на одном экране, пока оператор не сохранял
                // документ: вид в запись клал только TouchDocument, то есть первое сохранение.
                Kind = текст.Kind,
                UpdatedUtc = DateTime.UtcNow
            };
            var path = DocFilePath(info.Id);
            if (path is null) return (null, "Не удалось создать документ.");
            Directory.CreateDirectory(DocumentsDir);
            Write(path, текст);

            var lib = ReadOr(LibraryPath, () => new DocumentLibrary());
            lib.Documents = список;
            lib.Documents.Add(info);
            Write(LibraryPath, lib);
            return (info, null);
        }
    }

    private List<DocumentInfo> GetDocumentsNoLock() => ЧитатьСписокNoLock();

    /// <summary>
    /// Имя для копии: «исходный (копия)», а при занятости с числом. Занятость смотрится по
    /// именам всего списка, потому что тёзки видны именно в нём.
    /// </summary>
    private static string СвободноеИмяКопии(string основа, List<DocumentInfo> список)
    {
        bool занято(string имя) =>
            список.Any(d => string.Equals((d.Name ?? "").Trim(), имя, StringComparison.OrdinalIgnoreCase));
        var кандидат = основа + " (копия)";
        for (var n = 2; занято(кандидат) && n <= MaxDocuments + 1; n++)
            кандидат = основа + " (копия " + n + ")";
        return кандидат;
    }

    private DocumentConfig GetDocumentNoLock(string? id)
    {
        var info = id is null ? DefaultInfoNoLock() : GetDocumentInfoNoLock(id);
        if (info is null || info.IsDefault) return ReadOr(DocumentPath, () => ОбразецДля(info));
        var path = DocFilePath(info.Id);
        return path is null ? ОбразецДля(info) : ReadOr(path, () => ОбразецДля(info));
    }

    /// <summary>Куда лечь тексту документа: по умолчанию в document.json, остальным своим файлом.</summary>
    private bool ЗаписатьТекстNoLock(DocumentInfo? info, DocumentConfig doc)
    {
        if (info is null || info.IsDefault) { Write(DocumentPath, doc); return true; }
        var path = DocFilePath(info.Id);
        if (path is null) return false;
        Directory.CreateDirectory(DocumentsDir);
        Write(path, doc);
        return true;
    }

    /// <summary>
    /// Переименовать документ или сменить его код. Имя документа это его заголовок, поэтому
    /// переименование правит заголовок в самом документе, а не заводит второе имя рядом: имя,
    /// живущее только в списке, и было тем расхождением, из-за которого закладка переименовывалась
    /// при переходе на неё. Документу без заголовка заголовок не выдумывается: у него имя и есть
    /// отдельное название. Документ, чей файл пропал или не разбирается, текстом не трогается:
    /// иначе на месте потерянного оказался бы образец с новым именем.
    /// </summary>
    public string? UpdateDocumentMeta(string id, string? code, string? name)
    {
        lock (_lock)
        {
            var список = GetDocumentsNoLock();
            var info = список.FirstOrDefault(d => d.Id == id);
            if (info is null) return "Документ не найден.";
            if (!string.IsNullOrWhiteSpace(code))
            {
                var чистый = CleanDocCode(code);
                if (чистый.Length == 0) return "Код документа не может быть пустым.";
                if (список.Any(d => d.Id != id && string.Equals(d.Code, чистый, StringComparison.OrdinalIgnoreCase)))
                    return "Код «" + чистый + "» уже занят другим документом.";
                info.Code = чистый;
            }
            if (!string.IsNullOrWhiteSpace(name))
            {
                var имя = name!.Trim();
                var путь = info.IsDefault ? DocumentPath : DocFilePath(info.Id);
                var былЗаголовок = путь is null ? null : ЗаголовокФайла(путь);
                if (!string.IsNullOrWhiteSpace(былЗаголовок) && былЗаголовок!.Trim() != имя)
                {
                    var текст = GetDocumentNoLock(info.Id);
                    текст.Title = имя;
                    ЗаписатьТекстNoLock(info, текст);
                }
                info.Name = ИмяДляСписка(имя, info.Name, info.Code);
            }
            info.UpdatedUtc = DateTime.UtcNow;
            var lib = ReadOr(LibraryPath, () => new DocumentLibrary());
            lib.Documents = список;
            Write(LibraryPath, lib);
            return null;
        }
    }

    /// <summary>
    /// Сделать документ показываемым по умолчанию. По умолчанию хранится в document.json, потому
    /// файлы меняются местами: прежний по умолчанию уезжает в свой файл, новый занимает его место.
    /// </summary>
    public string? SetDefaultDocument(string id)
    {
        lock (_lock)
        {
            var список = GetDocumentsNoLock();
            var новый = список.FirstOrDefault(d => d.Id == id);
            if (новый is null) return "Документ не найден.";
            if (новый.IsDefault) return null;
            var прежний = список.FirstOrDefault(d => d.IsDefault);

            var текстНового = GetDocumentNoLock(id);
            var текстПрежнего = прежний is null ? null : ReadOr(DocumentPath, DefaultDocument);

            Directory.CreateDirectory(DocumentsDir);
            if (прежний is not null)
            {
                var путьПрежнего = DocFilePath(прежний.Id);
                if (путьПрежнего is null) return "Не удалось переставить документ по умолчанию.";
                Write(путьПрежнего, текстПрежнего!);
                прежний.IsDefault = false;
            }
            Write(DocumentPath, текстНового);
            var путьНового = DocFilePath(новый.Id);
            if (путьНового is not null && File.Exists(путьНового))
            {
                _text.Remove(путьНового); _docTitle.Remove(путьНового); File.Delete(путьНового);
            }
            новый.IsDefault = true;

            var lib = ReadOr(LibraryPath, () => new DocumentLibrary());
            lib.Documents = список;
            Write(LibraryPath, lib);
            return null;
        }
    }

    /// <summary>Удалить документ. Документ по умолчанию не удаляется: сначала назначьте другой.</summary>
    public string? DeleteDocument(string id)
    {
        lock (_lock)
        {
            var список = GetDocumentsNoLock();
            var info = список.FirstOrDefault(d => d.Id == id);
            if (info is null) return "Документ не найден.";
            if (info.IsDefault)
                return "Это документ по умолчанию: он показывается, когда запрос пришёл без кода. " +
                       "Сначала назначьте по умолчанию другой.";
            if (список.Count <= 1) return "Последний документ удалить нельзя.";
            var path = DocFilePath(info.Id);
            if (path is not null && File.Exists(path)) { _text.Remove(path); _docTitle.Remove(path); File.Delete(path); }
            список.Remove(info);
            var lib = ReadOr(LibraryPath, () => new DocumentLibrary());
            lib.Documents = список;
            Write(LibraryPath, lib);
            return null;
        }
    }

    /// <summary>
    /// Код документа: латиница, цифры, дефис и подчёркивание. Так он остаётся пригодным для
    /// строки запроса и одинаково выглядит в чужом коде, в журнале и в адресной строке.
    /// </summary>
    public static string CleanDocCode(string? code)
    {
        var v = (code ?? "").Trim();
        var kept = new string(v.Where(ch => char.IsLetterOrDigit(ch) && ch < 128 || ch is '-' or '_').ToArray());
        return kept.Length > 40 ? kept[..40] : kept;
    }

    /// <summary>
    /// Версия сохранённого документа: хэш его файла. Считается от текста, а не от объекта,
    /// поэтому одинаковый документ всегда даёт одну и ту же версию, а любая правка другую.
    /// Файл ещё не создан - версия «new»: у двух админок над свежей установкой она совпадает.
    /// </summary>
    public string GetDocumentRev(string? id = null)
    {
        lock (_lock)
        {
            var info = id is null ? null : GetDocumentInfoNoLock(id);
            var path = id is null || info is null || info.IsDefault ? DocumentPath : DocFilePath(info.Id);
            var text = path is null ? null : ReadText(path);
            return text is null ? "new" : Sha256Hex(text)[..16];
        }
    }

    // ---------------- Сессии подписания ----------------
    // Снимок разобранного документа на время одной сессии. Отдельным файлом на планшет, а не
    // внутри states.json: состояние читается на каждое подключение всего парка, а снимок нужен
    // только переподключению, наблюдению и самой отправке подписи.

    private string SessionsDir => Path.Combine(_dataDir, "sessions");

    private string? SessionPath(string deviceId)
    {
        // Имя файла строится из имени планшета. Наши имена это dev-и шестнадцатеричные цифры,
        // но файл не то место, где стоит доверять любой строке.
        var id = (deviceId ?? "").Trim();
        if (id.Length == 0 || id.Length > 64 || !id.All(ch => char.IsLetterOrDigit(ch) || ch == '-' || ch == '_'))
            return null;
        return Path.Combine(SessionsDir, id + ".json");
    }

    public void SaveDocSession(string deviceId, DocSession session)
    {
        var path = SessionPath(deviceId);
        if (path is null) return;
        lock (_lock)
        {
            Directory.CreateDirectory(SessionsDir);
            Write(path, session);
        }
    }

    public DocSession? GetDocSession(string deviceId)
    {
        var path = SessionPath(deviceId);
        if (path is null) return null;
        lock (_lock)
        {
            if (!File.Exists(path)) return null;
            return ReadOr<DocSession?>(path, () => null);
        }
    }

    public void DeleteDocSession(string deviceId)
    {
        lock (_lock) DeleteDocSessionNoLock(deviceId);
    }

    /// <summary>То же самое, но под уже взятым замком: вызывается изнутри других записей.</summary>
    private void DeleteDocSessionNoLock(string deviceId)
    {
        var path = SessionPath(deviceId);
        if (path is null) return;
        // Кэш чистится вместе с файлом: следующая сессия не должна прочитать прежнюю.
        _text.Remove(path);
        try { File.Delete(path); }
        catch (IOException) { /* файла уже нет или каталог не создавался - снимка и так нет */ }
        catch (UnauthorizedAccessException) { /* права снесло руками; читать его всё равно никто не будет */ }
    }

    // ---------------- Signatures ----------------

    public SignatureRecord AddSignature(SignatureSubmission sub, DocumentConfig resolvedDoc, Device? device, Workstation? workstation, byte[] pngBytes, Dictionary<string, string>? fields = null,
        List<(string Key, string Label, byte[] Png)>? extraSignatures = null,
        string? documentCode = null, string? documentName = null)
    {
        lock (_lock)
        {
            // Хвост прописными: номер печатается штрихкодом Code 39, а он строчных букв не знает
            // и кодирует их прописными. Со строчным хвостом прочитанный со штрихкода номер
            // отличался от настоящего, и запись по нему приходилось искать без учёта регистра.
            var id = DateTime.UtcNow.ToString("yyyyMMdd-HHmmss-fff") + "-" + Guid.NewGuid().ToString("N")[..6].ToUpperInvariant();
            var dir = Path.Combine(SignaturesDir, id);
            Directory.CreateDirectory(dir);
            var rec = new SignatureRecord
            {
                Id = id,
                CreatedUtc = DateTime.UtcNow,
                DocumentTitle = resolvedDoc.Title,
                DocumentCode = documentCode,
                DocumentName = documentName,
                DeviceId = device?.Id,
                DeviceName = device?.Name,
                WorkstationId = workstation?.Id,
                WorkstationName = workstation?.Name,
                Items = sub.Items ?? new List<SubmittedItem>(),
                Groups = sub.Groups ?? new List<SubmittedGroup>(),
                Inputs = sub.Inputs ?? new List<SubmittedInput>(),
                Fields = fields is { Count: > 0 } ? new Dictionary<string, string>(fields) : null,
                SubmissionId = string.IsNullOrWhiteSpace(sub.SubmissionId) ? null : sub.SubmissionId!.Trim()
            };
            if (rec.SubmissionId is not null && device is not null)
            {
                // Keep this cache small: a retry follows within seconds, so old entries are useless,
                // and the on-disk fallback below still catches anything older.
                if (_recentSubmissions.Count > 500) _recentSubmissions.Clear();
                _recentSubmissions[device.Id + "|" + rec.SubmissionId] = rec.Id;
            }
            // Подписи, поставленные внутри страниц, лежат отдельными файлами рядом с итоговой.
            // Имя файла берётся из имени поля, приведённого к безопасному виду: запись подписи
            // это то, что придётся открывать через год, и имя должно быть читаемым.
            // Имя файла не может повториться. Документ мог быть сохранён прежней версией и уже
            // нести два одинаковых имени поля; тогда вторая картинка ложилась поверх первой, и в
            // записи две подписи показывали одну и ту же руку. Лучше файл с номером, чем потеря.
            var занятыеФайлы = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var extra in extraSignatures ?? new List<(string, string, byte[])>())
            {
                var safe = new string((extra.Key ?? "").Where(c => char.IsLetterOrDigit(c) || c is '-' or '_').ToArray());
                if (safe.Length == 0) safe = "sign" + (rec.Signatures.Count + 1);
                var file = "signature-" + safe + ".png";
                for (var i = 2; занятыеФайлы.Contains(file); i++) file = "signature-" + safe + "-" + i + ".png";
                занятыеФайлы.Add(file);
                File.WriteAllBytes(Path.Combine(dir, file), extra.Png);
                rec.Signatures.Add(new SignedSignature { Key = extra.Key ?? "", Label = extra.Label ?? "", File = file });
            }
            rec.Scans = (sub.Scans ?? new List<SubmittedScan>()).Where(x => x is not null).ToList();

            Write(Path.Combine(dir, "meta.json"), rec);
            File.WriteAllBytes(Path.Combine(dir, "signature.png"), pngBytes);
            // Persist the exact resolved document so a failed PDF can be regenerated later
            // from precisely what the signer saw, not from a template that may have changed.
            Write(Path.Combine(dir, "document.json"), resolvedDoc);
            return rec;
        }
    }

    // Recent "deviceId|submissionId" -> record id, so a retried submit returns the original record
    // instead of creating a duplicate. In memory only: a retry follows within seconds, and after a
    // restart the fallback scan below still finds the record on disk.
    private readonly System.Collections.Concurrent.ConcurrentDictionary<string, string> _recentSubmissions = new();
    private readonly DateTime _startedUtc = DateTime.UtcNow;

    /// <summary>The record already stored for this device+submission, or null if this is the first try.</summary>
    public SignatureRecord? FindSignatureBySubmissionId(string deviceId, string submissionId)
    {
        if (string.IsNullOrWhiteSpace(deviceId) || string.IsNullOrWhiteSpace(submissionId)) return null;
        if (_recentSubmissions.TryGetValue(deviceId + "|" + submissionId, out var id))
        {
            var known = GetSignature(id);
            if (known is not null) return known;
        }
        // Fallback for a retry that spans a restart. Reading the archive is expensive, so it only
        // applies in the first minutes of a process: after that, any retry old enough to miss the
        // in-memory cache is no longer a retry.
        if (DateTime.UtcNow - _startedUtc > TimeSpan.FromMinutes(5)) return null;
        return ListSignatures(50)
            .FirstOrDefault(r => r.DeviceId == deviceId && r.SubmissionId == submissionId);
    }

    /// <summary>The exact document that was signed (for faithful PDF regeneration); null if absent.</summary>
    public DocumentConfig? GetSignatureDocument(string id)
    {
        if (!IsSafeId(id)) return null;
        lock (_lock)
        {
            var dir = SignatureDirNoLock(id);
            if (dir is null) return null;
            var path = Path.Combine(dir, "document.json");
            if (!File.Exists(path)) return null;
            try { return JsonSerializer.Deserialize<DocumentConfig>(File.ReadAllText(path), Json); }
            catch { return null; }
        }
    }

    /// <summary>Картинка подписи, поставленной внутри страницы. null, если файла нет.</summary>
    public byte[]? GetExtraSignatureBytes(string id, string file)
    {
        if (!IsSafeId(id) || string.IsNullOrWhiteSpace(file) || !IsSafeId(file)) return null;
        lock (_lock)
        {
            try
            {
                var dir = SignatureDirNoLock(id);
                if (dir is null) return null;
                var path = Path.Combine(dir, file);
                return File.Exists(path) ? File.ReadAllBytes(path) : null;
            }
            catch { return null; }
        }
    }

    /// <summary>Raw signature PNG bytes for a record; null if the file is missing.</summary>
    public byte[]? GetSignatureImageBytes(string id)
    {
        var path = GetSignatureImagePath(id);
        if (path is null) return null;
        lock (_lock)
        {
            try { return File.ReadAllBytes(path); }
            catch { return null; }
        }
    }

    /// <summary>
    /// The most recent signatures, newest first. Record ids start with a sortable timestamp, so the
    /// newest ones can be picked by directory name and only those files are read. The reads happen
    /// OUTSIDE the storage lock: this used to read every signature ever taken while holding the one
    /// lock that signing, device registration and the API all need.
    /// </summary>
    public List<SignatureRecord> ListSignatures(int limit = 200)
    {
        if (!Directory.Exists(SignaturesDir)) return new List<SignatureRecord>();
        string[] dirs;
        try { dirs = Directory.GetDirectories(SignaturesDir); }
        catch { return new List<SignatureRecord>(); }

        Array.Sort(dirs, (a, b) => string.CompareOrdinal(Path.GetFileName(b), Path.GetFileName(a)));
        var result = new List<SignatureRecord>();
        foreach (var dir in dirs)
        {
            if (result.Count >= Math.Clamp(limit, 1, 5000)) break;
            var meta = Path.Combine(dir, "meta.json");
            if (!File.Exists(meta)) continue;
            try
            {
                var rec = JsonSerializer.Deserialize<SignatureRecord>(File.ReadAllText(meta), Json);
                if (rec != null)
                {
                    rec.Items = (rec.Items ?? new List<SubmittedItem>()).Where(i => i is not null).ToList();
                    result.Add(rec);
                }
            }
            catch { /* skip a corrupt record rather than failing the whole listing */ }
        }
        return result.OrderByDescending(r => r.CreatedUtc).ToList();
    }

    /// <summary>
    /// Каталог записи по её номеру, без учёта регистра. Штрихкод в колонтитуле Code 39 строчных
    /// букв не знает и печатает номер прописными: сканер читает «...-52D432», а каталог называется
    /// «...-52d432», и на Linux это разные имена. Поиск записи по прочитанному со штрихкода номеру
    /// иначе отвечал «не найдено» на собственную же бумагу.
    /// </summary>
    private string? SignatureDirNoLock(string id)
    {
        var прямо = Path.Combine(SignaturesDir, id);
        if (Directory.Exists(прямо)) return прямо;
        if (!Directory.Exists(SignaturesDir)) return null;
        foreach (var d in Directory.EnumerateDirectories(SignaturesDir))
            if (string.Equals(Path.GetFileName(d), id, StringComparison.OrdinalIgnoreCase)) return d;
        return null;
    }

    public SignatureRecord? GetSignature(string id)
    {
        if (!IsSafeId(id)) return null;
        lock (_lock)
        {
            var dir = SignatureDirNoLock(id);
            if (dir is null) return null;
            var meta = Path.Combine(dir, "meta.json");
            if (!File.Exists(meta)) return null;
            try
            {
                var rec = JsonSerializer.Deserialize<SignatureRecord>(File.ReadAllText(meta), Json);
                // A record written before items were validated can contain nulls; drop them so PDF
                // regeneration and the admin view cannot fail on a legacy record.
                if (rec is not null) rec.Items = (rec.Items ?? new List<SubmittedItem>()).Where(i => i is not null).ToList();
                return rec;
            }
            catch { return null; }
        }
    }

    public string? GetSignatureImagePath(string id)
    {
        if (!IsSafeId(id)) return null;
        lock (_lock)
        {
            var dir = SignatureDirNoLock(id);
            if (dir is null) return null;
            var path = Path.Combine(dir, "signature.png");
            return File.Exists(path) ? path : null;
        }
    }

    // ---------------- Alert settings ----------------

    private string AlertSettingsPath => Path.Combine(_dataDir, "alerts.json");

    public AlertSettings GetAlertSettings()
    {
        AlertSettings s;
        lock (_lock) s = ReadOr(AlertSettingsPath, () => new AlertSettings());
        // Clamp on read as well as on write: a hand-edited file with errorCount = 0 would otherwise
        // make the burst condition permanently true and leave an alert nothing could clear.
        s.OfflineMinutes = Math.Clamp(s.OfflineMinutes, 1, 1440);
        s.ErrorCount = Math.Clamp(s.ErrorCount, 1, 1000);
        s.ErrorWindowMinutes = Math.Clamp(s.ErrorWindowMinutes, 1, 1440);
        return s;
    }

    public void SaveAlertSettings(AlertSettings settings)
    {
        // Clamp to sane bounds so a typo cannot disable alerting or make it fire constantly.
        settings.OfflineMinutes = Math.Clamp(settings.OfflineMinutes, 1, 1440);
        settings.ErrorCount = Math.Clamp(settings.ErrorCount, 1, 1000);
        settings.ErrorWindowMinutes = Math.Clamp(settings.ErrorWindowMinutes, 1, 1440);
        lock (_lock) Write(AlertSettingsPath, settings);
    }

    // ---------------- Tablet control (FreeKiosk REST API) ----------------

    private string KioskControlPath => Path.Combine(_dataDir, "kioskcontrol.json");

    public KioskControlSettings GetKioskControlSettings()
    {
        KioskControlSettings s;
        lock (_lock) s = ReadOr(KioskControlPath, () => new KioskControlSettings());
        ClampKioskControl(s);
        return s;
    }

    public void SaveKioskControlSettings(KioskControlSettings settings)
    {
        ClampKioskControl(settings);
        lock (_lock) Write(KioskControlPath, settings);
    }

    // A warning threshold of 100% would be true for every tablet, every time, which is an alert
    // that can never clear. The same reasoning already applies to the error-burst thresholds.
    private const int MaxWarnPercent = 90;

    /// <summary>
    /// Годится ли ключ доступа к планшетам. Возвращает причину отказа или null, если ключ годится.
    ///
    /// Ключ уезжает в заголовок HTTP, а в значении заголовка допустимы только видимые знаки ASCII
    /// (RFC 7230). Кириллица туда не помещается вовсе: платформа отказывается отправлять такой
    /// заголовок и рвёт запрос, а наверх это приходило как «Планшет не отвечает по сети» при живом
    /// планшете, стоящем в соседнем кабинете. Перекодировать ключ (в проценты, в BASE64, в
    /// латиницу) нельзя: на планшете он сравнивается с тем, что там записано, и любая перекодировка
    /// означает другой ключ и отказ уже от самого планшета. Поэтому такой ключ не принимается при
    /// сохранении, и причина называется прямо.
    /// </summary>
    public static string? ПочемуКлючУправленияНеГодится(string? key)
    {
        var k = (key ?? "").Trim();
        if (k.Length == 0) return null;                  // ключ не задан: это не ошибка
        var плохие = k.Where(c => c < ' ' || c > '~').Distinct().Take(5).ToList();
        if (плохие.Count == 0) return null;
        var перечень = string.Join(", ", плохие.Select(c => char.IsWhiteSpace(c) || char.IsControl(c)
            ? "знак с кодом " + ((int)c)
            : "«" + c + "»"));
        return "Ключ доступа к планшетам передаётся в заголовке HTTP, а туда помещаются только " +
               "латиница, цифры и знаки препинания. В присланном ключе есть недопустимое: " + перечень +
               ". Наберите ключ латиницей и задайте такой же в самом FreeKiosk.";
    }

    private static void ClampKioskControl(KioskControlSettings s)
    {
        s.Port = s.Port is > 0 and < 65536 ? s.Port : 8080;
        s.TimeoutSec = Math.Clamp(s.TimeoutSec, 1, 30);
        s.AutoHealAfterMinutes = Math.Clamp(s.AutoHealAfterMinutes, 1, 1440);
        s.BatteryWarnPercent = Math.Clamp(s.BatteryWarnPercent, 0, MaxWarnPercent);
        s.StorageWarnPercent = Math.Clamp(s.StorageWarnPercent, 0, MaxWarnPercent);
        // The key is sent as a header. Control characters would let a value smuggle extra headers
        // into every request, so they are dropped rather than trusted.
        var key = (s.ApiKey ?? "").Trim();
        s.ApiKey = key.Any(char.IsControl) ? new string(key.Where(c => !char.IsControl(c)).ToArray()) : key;
        if (s.ApiKey.Length > 200) s.ApiKey = s.ApiKey[..200];
    }

    /// <summary>Set the control address of a tablet (its own IP and, optionally, a custom port).</summary>
    public bool SetDeviceControlAddress(string id, string? ip, int? port)
    {
        lock (_lock)
        {
            var list = ReadOr(DevicesPath, () => new List<Device>());
            var dev = list.FirstOrDefault(d => d.Id == id);
            if (dev == null) return false;
            dev.ControlIp = string.IsNullOrWhiteSpace(ip) ? null : ip.Trim();
            dev.ControlPort = port is > 0 and < 65536 ? port : null;
            Write(DevicesPath, list);
            return true;
        }
    }

    // ---------------- Расписание управления планшетами ----------------

    private string SchedulePath => Path.Combine(_dataDir, "schedule.json");

    /// <summary>Правила расписания, приведённые к допустимым значениям.</summary>
    public List<ScheduleRule> GetScheduleRules()
    {
        List<ScheduleRule> list;
        lock (_lock) list = ReadOr(SchedulePath, () => new ScheduleStore()).Rules ?? new List<ScheduleRule>();
        foreach (var r in list) ClampRule(r);
        return list;
    }

    /// <summary>Сохранить весь список целиком: правил немного, а частичные изменения дали бы
    /// расхождение между тем, что видит оператор, и тем, что лежит на диске.</summary>
    public List<ScheduleRule> SaveScheduleRules(List<ScheduleRule>? rules)
    {
        var list = (rules ?? new List<ScheduleRule>()).Where(r => r is not null).Take(MaxScheduleRules).ToList();
        foreach (var r in list)
        {
            if (string.IsNullOrWhiteSpace(r.Id)) r.Id = "rule-" + ShortId();
            ClampRule(r);
        }
        lock (_lock)
        {
            // Отметка о последнем запуске принадлежит не панели, а самому правилу. Панель её не
            // присылает, и раньше любое сохранение расписания стирало «сегодня уже выполнено»:
            // правило, отработавшее в семь утра, повторялось на ближайшем такте, если оператор в
            // семь ноль одну поправил примечание в соседнем правиле. Заодно пропадала вся
            // история запусков из карточки.
            var прежние = ReadOr(SchedulePath, () => new ScheduleStore()).Rules ?? new List<ScheduleRule>();
            var поId = прежние.Where(r => r is not null && !string.IsNullOrWhiteSpace(r.Id))
                .GroupBy(r => r.Id, StringComparer.Ordinal)
                .ToDictionary(g => g.Key, g => g.First(), StringComparer.Ordinal);
            foreach (var r in list)
            {
                if (!поId.TryGetValue(r.Id, out var было)) continue;
                r.LastRunUtc = было.LastRunUtc;
                r.LastRunLocalDate = было.LastRunLocalDate;
                r.LastResult = было.LastResult;
            }
            Write(SchedulePath, new ScheduleStore { Rules = list });
        }
        return list;
    }

    /// <summary>Записать итог запуска правила, не трогая остальные его поля.</summary>
    public void MarkScheduleRun(string id, string localDate, string result)
    {
        lock (_lock)
        {
            var store = ReadOr(SchedulePath, () => new ScheduleStore());
            var rule = (store.Rules ?? new List<ScheduleRule>()).FirstOrDefault(r => r.Id == id);
            if (rule is null) return;
            rule.LastRunUtc = DateTime.UtcNow;
            rule.LastRunLocalDate = localDate;
            rule.LastResult = result.Length > 300 ? result[..300] : result;
            Write(SchedulePath, store);
        }
    }

    private const int MaxScheduleRules = 50;
    private const int MaxScheduleDevices = 500;

    private static void ClampRule(ScheduleRule r)
    {
        r.Time = NormalizeTime(r.Time);
        r.Days = (r.Days ?? new List<int>()).Where(d => d is >= 1 and <= 7).Distinct().OrderBy(d => d).ToList();
        // Неизвестное действие раньше молча превращалось во «включить экран»: правило с опечаткой
        // в три часа ночи зажигало экраны всего парка, а в журнале стояло «Расписание «Включить
        // экран»». Такое правило выключается, а не подменяется: выключенное видно в списке и
        // ничего не делает.
        if (ScheduleActions.Find(r.Action) is null)
        {
            r.Enabled = false;
            r.LastResult = "Действие «" + (r.Action ?? "") + "» не опознано: правило выключено, выберите действие заново.";
            r.Action = "screen-on";
        }
        r.Value = Math.Clamp(r.Value, 0, 100);
        r.Text = (r.Text ?? "").Trim();
        if (r.Text.Length > 200) r.Text = r.Text[..200];
        r.Note = (r.Note ?? "").Trim();
        if (r.Note.Length > 200) r.Note = r.Note[..200];
        r.Target = string.IsNullOrWhiteSpace(r.Target) ? "all" : r.Target.Trim();
        r.DeviceIds = (r.DeviceIds ?? new List<string>())
            .Where(id => !string.IsNullOrWhiteSpace(id)).Select(id => id.Trim()).Distinct()
            .Take(MaxScheduleDevices).ToList();
    }

    /// <summary>ЧЧ:ММ или 07:00, если прислали что-то другое. Время задаёт человек руками,
    /// и одна опечатка не должна ронять весь разбор расписания.</summary>
    private static string NormalizeTime(string? time)
    {
        var parts = (time ?? "").Split(':');
        if (parts.Length != 2 || !int.TryParse(parts[0], out var h) || !int.TryParse(parts[1], out var m))
            return "07:00";
        if (h is < 0 or > 23 || m is < 0 or > 59) return "07:00";
        return h.ToString("00") + ":" + m.ToString("00");
    }

    // ---------------- Scans (barcode / QR) ----------------

    private string ScansPath => Path.Combine(_dataDir, "scans.json");
    // Bounded on purpose: this file is rewritten on every scan, and the storage lock is the same one
    // authentication and signing use. 1000 records of at most 512 chars keeps it well under a MB.
    private const int MaxScans = 1000;
    public const int MaxScanCodeLength = 512;

    /// <summary>Recent scans, newest first (bounded).</summary>
    public List<ScanRecord> GetScans(int limit = 200)
    {
        List<ScanRecord> list;
        lock (_lock) list = ReadOr(ScansPath, () => new List<ScanRecord>());
        return list.Take(Math.Clamp(limit, 1, MaxScans)).ToList();
    }

    public ScanRecord AddScan(string code, string format, Device? device, Workstation? workstation)
    {
        var rec = new ScanRecord
        {
            // Хвост прописными: номер записи печатается штрихкодом Code 39, а он строчных букв не
            // знает и кодирует их прописными. Со строчным хвостом прочитанный со штрихкода номер
            // отличался от настоящего, и запись по нему приходилось искать без учёта регистра.
            // Теперь бумага и запись сходятся знак в знак.
            Id = DateTime.UtcNow.ToString("yyyyMMdd-HHmmss-fff") + "-" + Guid.NewGuid().ToString("N")[..6].ToUpperInvariant(),
            CreatedUtc = DateTime.UtcNow,
            Code = code.Length <= MaxScanCodeLength ? code : code[..MaxScanCodeLength],
            Format = format.Length <= 40 ? format : format[..40],
            DeviceId = device?.Id,
            DeviceName = device?.Name,
            WorkstationId = workstation?.Id,
            WorkstationName = workstation?.Name
        };
        lock (_lock)
        {
            var list = ReadOr(ScansPath, () => new List<ScanRecord>());
            list.Insert(0, rec);                                   // newest first
            if (list.Count > MaxScans) list.RemoveRange(MaxScans, list.Count - MaxScans);
            Write(ScansPath, list);
        }
        return rec;
    }

    public bool DeleteScan(string id)
    {
        lock (_lock)
        {
            var list = ReadOr(ScansPath, () => new List<ScanRecord>());
            var n = list.RemoveAll(s => s.Id == id);
            if (n == 0) return false;
            Write(ScansPath, list);
            return true;
        }
    }

    // ---------------- Helpers ----------------

    public static bool IsSafeId(string id) =>
        !string.IsNullOrEmpty(id) && !id.Contains("..") && id.All(c => char.IsLetterOrDigit(c) || c is '-' or '_' or '.');

    public static string Sha256Hex(string s) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(s)));

    private static string RandomToken(int bytes)
    {
        var buf = RandomNumberGenerator.GetBytes(bytes);
        return Convert.ToBase64String(buf).Replace("+", "-").Replace("/", "_").TrimEnd('=');
    }

    private static string ShortId() =>
        Convert.ToHexString(RandomNumberGenerator.GetBytes(5)).ToLowerInvariant();

    /// <summary>Human-friendly enrollment code, e.g. "7QF3-K92X" (no ambiguous chars).</summary>
    private static string FriendlyCode()
    {
        const string alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
        var chars = new char[8];
        var rnd = RandomNumberGenerator.GetBytes(8);
        for (int i = 0; i < 8; i++) chars[i] = alphabet[rnd[i] % alphabet.Length];
        return new string(chars, 0, 4) + "-" + new string(chars, 4, 4);
    }

    /// <summary>
    /// Прочитать файл или вернуть пустое значение. Если файл повреждён, он сначала откладывается
    /// в сторону под именем с меткой времени: иначе следующая запись затёрла бы его пустым
    /// значением и все планшеты, ключи или подписи исчезли бы без следа. Отложенный файл виден
    /// в каталоге данных и упоминается в логе, так что его можно разобрать руками.
    /// </summary>
    // Текст файлов держится в памяти: он меняется только через Write этого же процесса, поэтому
    // повторное чтение с диска ничего не даёт. Разбор при этом остаётся на каждый вызов: тот, кто
    // получил объект, вправе его менять, и отдавать одну и ту же копию всем нельзя.
    // При двухстах планшетах состояние читается на каждое подключение, каждую подпись и каждый
    // список: без этого одно событие сети превращалось в сотни обращений к диску.
    private readonly Dictionary<string, (string Text, DateTime Stamp, long Length)> _text = new(StringComparer.Ordinal);

    /// <summary>
    /// Текст файла из кэша, если он не менялся на диске. Метка времени и размер проверяются
    /// всегда: файл могли поправить руками рядом с работающей службой, и делать вид, что этого
    /// не было, до перезапуска нельзя. Проверка это один запрос к файловой системе вместо
    /// полного чтения и разбора.
    /// </summary>
    private string? ReadText(string path)
    {
        var info = new FileInfo(path);
        if (!info.Exists) { _text.Remove(path); return null; }
        if (_text.TryGetValue(path, out var cached)
            && cached.Stamp == info.LastWriteTimeUtc && cached.Length == info.Length)
            return cached.Text;
        var text = File.ReadAllText(path);
        info.Refresh();
        _text[path] = (text, info.LastWriteTimeUtc, info.Length);
        return text;
    }

    private T ReadOr<T>(string path, Func<T> fallback)
    {
        var text = ReadText(path);
        if (text is null) return fallback();
        try
        {
            var v = JsonSerializer.Deserialize<T>(text, Json);
            if (v is not null) return v;
        }
        catch (Exception ex)
        {
            QuarantineCorrupt(path, ex.Message);
            return fallback();
        }
        // Файл разобрался, но оказался пустым (null в JSON): это тоже не то, что мы записывали.
        QuarantineCorrupt(path, "файл содержит пустое значение");
        return fallback();
    }

    /// <summary>Отложить повреждённый файл в сторону, чтобы его не затёрло следующей записью.</summary>
    private void QuarantineCorrupt(string path, string reason)
    {
        try
        {
            var backup = path + ".corrupt-" + DateTime.UtcNow.ToString("yyyyMMdd-HHmmss");
            File.Move(path, backup, overwrite: true);
            // Испорченный текст из кэша тоже надо убрать, иначе он переживёт карантин файла.
            _text.Remove(path);
            var file = Path.GetFileName(path);
            var backupName = Path.GetFileName(backup);
            // В очередь кладём всегда: из неё фоновая проверка поднимает уведомление оператору.
            // Плюс, если журнал уже создан, пишем в него сразу, не дожидаясь следующего круга.
            CorruptFiles.Enqueue((file, backupName, reason));
            OnCorrupt?.Invoke(file, backupName, reason);
        }
        catch { /* не смогли отложить: терять из-за этого работу сервиса нельзя */ }
    }

    /// <summary>
    /// Повреждённые файлы, отложенные с момента запуска. Читается наружу, чтобы попасть в лог
    /// оператора: молча подменить данные пустыми и не сказать об этом было бы худшим вариантом.
    /// </summary>
    public readonly System.Collections.Concurrent.ConcurrentQueue<(string File, string Backup, string Reason)> CorruptFiles = new();

    /// <summary>
    /// Куда сообщать о повреждённом файле сразу, как только он обнаружен. Ставится один раз при
    /// запуске, когда журнал уже создан. Через свойство, а не через конструктор: журнал сам
    /// зависит от хранилища, и обратная зависимость замкнула бы круг.
    /// </summary>
    public Action<string, string, string>? OnCorrupt { get; set; }

    private void Write<T>(string path, T value)
    {
        var text = JsonSerializer.Serialize(value, Json);
        var tmp = path + ".tmp";
        File.WriteAllText(tmp, text);
        File.Move(tmp, path, overwrite: true);
        // Кэш обновляется тем же текстом, который лёг на диск: следующее чтение получит именно
        // записанное, а не то, что было до записи.
        var info = new FileInfo(path);
        _text[path] = (text, info.LastWriteTimeUtc, info.Length);
        // Разобранный заголовок к записанному тексту отношения уже не имеет. Метка времени файла
        // идёт с точностью файловой системы, и две записи подряд могут в неё не разойтись:
        // тогда сверка имён взяла бы заголовок, которого в файле давно нет.
        _docTitle.Remove(path);
    }

    private static DocumentConfig DefaultDocument() => new()
    {
        Title = "Согласие на обработку персональных данных",
        SignPrompt = "Пожалуйста, поставьте вашу подпись в поле ниже",
        ThankYouText = "Спасибо! Ваша подпись принята.",
        Pages = new List<DocPage>
        {
            new()
            {
                Heading = "Шаг 1. Ознакомление",
                Body = "Пожалуйста, внимательно ознакомьтесь с текстом.\n\n" +
                       "Используйте кнопки «Далее» и «Назад» для перехода между разделами. " +
                       "Вы можете вернуться и перечитать любой раздел в любой момент.\n\n" +
                       "Настоящий документ описывает условия предоставления услуги и порядок обработки ваших персональных данных.",
                Checkboxes = new List<DocCheckbox>()
            },
            new()
            {
                Heading = "Шаг 2. Условия и согласие",
                Body = "Оператор обязуется использовать предоставленные данные исключительно в целях оказания услуги " +
                       "и не передавать их третьим лицам без вашего согласия.\n\n" +
                       "Отметьте пункты ниже, чтобы подтвердить согласие. Отмеченные пункты обязательны для продолжения.",
                Checkboxes = new List<DocCheckbox>
                {
                    new() { Label = "Я ознакомился(лась) с условиями предоставления услуги", Required = true },
                    new() { Label = "Я даю согласие на обработку моих персональных данных", Required = true }
                }
            },
            new()
            {
                Heading = "Шаг 3. Дополнительно",
                Body = "Вы можете отметить дополнительные пункты по желанию - они не обязательны.",
                Checkboxes = new List<DocCheckbox>
                {
                    new() { Label = "Я хочу получать информационную рассылку", Required = false }
                }
            }
        }
    };
}
