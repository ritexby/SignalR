using System.Text.Json.Serialization;
using System.Linq;

namespace SignatureKiosk.Models;

// ---------- Kiosk / slideshow state ----------

/// <summary>Per-device (or default) screen state.</summary>
public class KioskState
{
    public string Mode { get; set; } = "slides"; // "slides" | "document"
    public List<string> PlaylistImageIds { get; set; } = new();
    public int IntervalSec { get; set; } = 6;
    public Dictionary<string, string> Fields { get; set; } = new();       // per-signer values for {{tags}}
    public List<DocCheckbox> DynamicCheckboxes { get; set; } = new();     // per-signer checkboxes from the API
    // Состояние именованных элементов, присланное внешней системой: отметки чекбоксов по ключу и
    // выбранный вариант в каждой группе. Хранится вместе с остальным состоянием планшета, чтобы
    // после переподключения он получил ровно то же самое.
    public Dictionary<string, bool> CheckboxStates { get; set; } = new();
    public Dictionary<string, string> GroupSelections { get; set; } = new();
    /// <summary>
    /// Тексты, присланные внешней системой для того, что уже стоит в документе: подпись
    /// чекбокса, заголовок двойных зависимых чекбоксов и подписи их вариантов. Нужны, когда
    /// формулировка зависит от заказа, а место в документе всегда одно и то же.
    /// Ключ это имя чекбокса или группы, а для варианта - «группа/вариант». Имена не могут
    /// содержать косую черту, поэтому разночтения быть не может.
    /// </summary>
    public Dictionary<string, string> Texts { get; set; } = new();
    /// <summary>
    /// Варианты двойных зависимых чекбоксов, присланные внешней системой. Заказ может приходить
    /// со своим списком ответов, и тогда он заменяет тот, что стоит в документе.
    /// </summary>
    public Dictionary<string, List<DocGroupOption>> GroupOptions { get; set; } = new();
    public DateTime? DocumentSetUtc { get; set; }                          // when the document was put on this device
    /// <summary>
    /// Имя сессии подписания. Выдаётся при показе документа и указывает на снимок разобранного
    /// документа рядом с состоянием. Пока клиент подписывает, оператор может править шаблон:
    /// без снимка переподключившийся планшет и итоговая запись собирались бы из нового шаблона,
    /// а подписал человек старый.
    /// </summary>
    public string? SessionId { get; set; }

    public KioskState Clone() => new()
    {
        Mode = Mode,
        PlaylistImageIds = new List<string>(PlaylistImageIds),
        IntervalSec = IntervalSec,
        Fields = new Dictionary<string, string>(Fields),
        DynamicCheckboxes = DynamicCheckboxes.Select(c => new DocCheckbox { Key = c.Key, Label = c.Label, Required = c.Required, Checked = c.Checked }).ToList(),
        CheckboxStates = new Dictionary<string, bool>(CheckboxStates),
        GroupSelections = new Dictionary<string, string>(GroupSelections),
        Texts = new Dictionary<string, string>(Texts),
        GroupOptions = GroupOptions.ToDictionary(kv => kv.Key,
            kv => kv.Value.Select(o => new DocGroupOption { Key = o.Key, Label = o.Label }).ToList()),
        DocumentSetUtc = DocumentSetUtc,
        SessionId = SessionId
    };
}

/// <summary>Persisted collection of states: one shared default plus per-device overrides.</summary>
public class StateStore
{
    public KioskState Default { get; set; } = new();
    public Dictionary<string, KioskState> Devices { get; set; } = new();
}

// ---------- Devices, groups, workstations, enrollment ----------

/// <summary>An enrolled tablet. Authenticated by a per-device secret (hash stored here).</summary>
public class Device
{
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
    public string SecretHash { get; set; } = "";              // SHA-256 hex of the device secret
    public List<string> GroupIds { get; set; } = new();
    public string? WorkstationId { get; set; }
    public DateTime EnrolledUtc { get; set; }
    public DateTime LastSeenUtc { get; set; }
    public string? LastIp { get; set; }                       // client IP seen at the last connection
    // Address of the tablet's own FreeKiosk REST API. Usually the same as LastIp, but it must be
    // set by hand when the tablet reaches the server through a router, because then LastIp is the
    // router's address and not the tablet's.
    public string? ControlIp { get; set; }
    public int? ControlPort { get; set; }                     // overrides the fleet-wide port
    public string Status { get; set; } = "active";            // "active" | "revoked"

    // Размер экрана планшета, каким его сообщила его собственная страница. Нужен окну
    // наблюдения: оно показывает уменьшенный экран планшета один в один, и без настоящих
    // размеров рисовало бы рамку наугад. Нужен и оператору в карточке: по нему видно, какое
    // железо стоит на рабочем месте.
    //
    // Помнится последнее известное, а не только для планшета на связи: окно наблюдения должно
    // открыться правильной формы ещё до первого кадра, а карточка отключённого планшета всё
    // равно рассказывает, что это за железо.
    //
    // Пусто, а не ноль, у планшета, который размер не сообщал: страница старая и метода не
    // знает. Пустое поле честно говорит «неизвестно», а ноль соврал бы про экран нулевой
    // ширины, и окно наблюдения свернулось бы в точку.

    /// <summary>Ширина области просмотра в точках разметки (не в пикселях матрицы).</summary>
    public int? ScreenWidth { get; set; }
    /// <summary>Высота области просмотра в тех же точках.</summary>
    public int? ScreenHeight { get; set; }
    /// <summary>Плотность пикселей планшета (devicePixelRatio). Оператору она нужна словами,
    /// чтобы разбирать жалобы «текст мелкий»: в расчёте размеров не участвует.</summary>
    public double? ScreenPixelRatio { get; set; }
}

/// <summary>Что сервер сделал с размером экрана, о котором доложил планшет.</summary>
public enum DeviceScreenUpdate
{
    /// <summary>Не принято: планшета нет или он отозван. Планшету отвечают отказом, чтобы он не
    /// считал сведения доставленными и повторил их, когда снова будет иметь на это право.</summary>
    Rejected,
    /// <summary>Принято, но сервер это уже знал: писать на диск и будить админки не о чем.</summary>
    Unchanged,
    /// <summary>Принято и запомнено заново.</summary>
    Changed
}

public class DeviceGroup
{
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
}

public class Workstation
{
    public string Id { get; set; } = "";
    public string ExternalId { get; set; } = "";              // key for the customer's external system
    public string Name { get; set; } = "";
    public string Location { get; set; } = "";
}

/// <summary>A one-time enrollment code that a tablet redeems for a device token.</summary>
public class Enrollment
{
    public string Code { get; set; } = "";
    public string? Name { get; set; }
    public string? WorkstationId { get; set; }
    public List<string> GroupIds { get; set; } = new();
    public DateTime CreatedUtc { get; set; }
    public DateTime ExpiresUtc { get; set; }
    public string? UsedByDeviceId { get; set; }               // null until redeemed
}

/// <summary>An API key for the external integration surface (/api/ext).</summary>
public class ApiKey
{
    public string Id { get; set; } = "";
    public string KeyHash { get; set; } = "";                 // SHA-256 hex of the key
    public string Label { get; set; } = "";
    public DateTime CreatedUtc { get; set; }
    /// <summary>
    /// Ключ выключен: он есть в списке, но доступа не даёт. Нужен, потому что «убрать доступ»
    /// и «забыть, что такой доступ был» это разные действия: интеграцию останавливают на время
    /// разбирательства, а удаление ключа необратимо и требует заново настраивать чужую систему.
    /// </summary>
    public bool Disabled { get; set; }
}

// ---------- Images ----------

public class ImageInfo
{
    public string Id { get; set; } = "";
    public string FileName { get; set; } = "";
    public string OriginalName { get; set; } = "";
    public DateTime UploadedUtc { get; set; }
    /// <summary>
    /// С какого дня показывать эту картинку в рекламе, включительно. Пусто означает «с самого
    /// начала». Дата, а не время: реклама живёт днями, а не минутами, и час начала показа никому
    /// не нужен. Хранится как yyyy-MM-dd, чтобы не зависеть от часового пояса читающего.
    /// </summary>
    public string? ShowFrom { get; set; }
    /// <summary>По какой день показывать, включительно. Пусто означает «без конца».</summary>
    public string? ShowTo { get; set; }
    /// <summary>
    /// Группы планшетов, где эту картинку показывать. Пустой список означает «везде»: именно так
    /// ведут себя все картинки, загруженные до появления этой настройки, поэтому старые наборы
    /// продолжают работать как раньше.
    /// </summary>
    public List<string> GroupIds { get; set; } = new();
    /// <summary>
    /// Группы планшетов, где эту картинку не показывать. Запрет сильнее разрешения: планшет,
    /// попавший и в «показывать», и в «кроме», картинку не увидит. Иначе одна и та же настройка
    /// значила бы разное в зависимости от порядка чтения.
    /// </summary>
    public List<string> ExceptGroupIds { get; set; } = new();
}

// ---------- Signing document ----------

public class DocCheckbox
{
    // Optional name the external system uses to address this exact checkbox. Checkbox names live
    // in their own namespace, separate from the {{tags}}: one name must never mean two things.
    public string Key { get; set; } = "";
    public string Label { get; set; } = "";
    /// <summary>
    /// Оформленный текст пункта: жирный, курсив, цвет, размер, как у обычного абзаца. Когда он
    /// задан, Label хранит то же самое простым текстом: по нему пункт узнают в записи подписи,
    /// в API и в списке недостающего, и там оформление ни к чему.
    /// </summary>
    public List<TextRun> LabelRuns { get; set; } = new();
    /// <summary>
    /// Что дописать к тексту, который уже стоит в документе. Имеет смысл только в запросе по
    /// API и в самом документе никогда не хранится: Label заменяет текст целиком, LabelAppend
    /// добавляет к нему. Нужно, когда внешняя система не знает формулировку в документе, но
    /// должна уточнить её под конкретный заказ.
    /// </summary>
    public string? LabelAppend { get; set; }
    public bool Required { get; set; } = true;
    public bool Checked { get; set; } = false; // initial state (used by API-supplied checkboxes)
    /// <summary>
    /// Какую отметку просил заказ. Пусто, если заказ про этот пункт ничего не говорил. Хранится
    /// отдельно от Checked, потому что Checked к моменту записи это уже ответ клиента, а вопрос
    /// «кто поставил галочку» и вопрос «с чем клиент ушёл» это разные вопросы. Заранее
    /// проставленная отметка сама по себе согласием не считается: согласие это действие
    /// человека, поэтому в архиве обязано быть видно, что пункт пришёл уже отмеченным.
    /// </summary>
    public bool? CheckedFromApi { get; set; }
    // Shown only while its condition holds. A condition on another checkbox is evaluated on the
    // tablet as the signer ticks; a condition on a tag is evaluated on the server, as before.
    public VisibleWhen? VisibleWhen { get; set; }
    // Место элемента внутри страницы. Блоки текста, чекбоксы и группы стоят в одном общем порядке,
    // поэтому номер сквозной для всех трёх видов. -1 означает "не задан": так выглядят документы,
    // сохранённые до появления свободного порядка, и им номера проставляются при сохранении.
    public int Ord { get; set; } = -1;

    /// <summary>
    /// Пришло из заказа, а в шаблоне документа этого не было. Ставится только там, где внешняя
    /// система добавляет в документ то, чего оператор не ставил. Пункт, чьё имя совпало с
    /// шаблонным, так не помечается: это элемент документа, заказ лишь задал ему состояние.
    /// </summary>
    public bool Api { get; set; }
    /// <summary>
    /// Элемент шаблонный, а надпись на нём пришла из заказа: label заменил её целиком или
    /// labelAppend дописал к ней. Это другой факт, чем Api, и в разбирательстве через год
    /// вопросы к ним разные: кто добавил пункт и кто написал его текст.
    /// </summary>
    public bool ApiText { get; set; }
    /// <summary>
    /// Что стояло в документе до того, как заказ переписал надпись. Пусто, когда ApiText не
    /// стоит. Хранится потому, что сама пометка через год ничего не объясняет: видно должно
    /// быть и то, что написал оператор, и то, что увидел клиент.
    /// </summary>
    public string? LabelBefore { get; set; }
}

/// <summary>
/// Таблица: строки одинаковой ширины столбцов. Ячейки это обычный текст без оформления: так
/// таблица остаётся читаемой и в редакторе, и в PDF, а оформленный текст живёт в блоках рядом.
/// </summary>
public class DocTable
{
    /// <summary>Строки, каждая это список ячеек. Число ячеек выравнивается по самой длинной.</summary>
    public List<List<string>> Rows { get; set; } = new();
    /// <summary>Ширины столбцов в процентах. Пусто означает поровну.</summary>
    public List<int> Widths { get; set; } = new();
    /// <summary>Первая строка это шапка: полужирная и с плашкой.</summary>
    public bool HeaderRow { get; set; } = true;
}

/// <summary>
/// Поле ввода на планшете: клиент вписывает значение с экранной клавиатуры. Значение живёт как
/// тег: работает в условиях, подставляется в текст ниже, попадает в запись и в PDF.
/// </summary>
public class DocInput
{
    public string Key { get; set; } = "";
    public string Label { get; set; } = "";
    /// <summary>Вид значения: "text" | "number" | "date" | "phone". От него зависят клавиатура
    /// на планшете и проверка на сервере.</summary>
    public string Type { get; set; } = "text";
    public string? Placeholder { get; set; }
    public bool Required { get; set; }
    /// <summary>Заранее заполненное значение: обычно приходит из тега API с тем же именем.</summary>
    public string? Value { get; set; }
    public VisibleWhen? VisibleWhen { get; set; }
    public int Ord { get; set; } = -1;
}

/// <summary>
/// Правило поверх отметок страницы. "exclusive": из перечисленных пунктов отмечен может быть
/// только один, отметка снимает остальные. "minchecked": пунктов из перечня должно быть отмечено
/// не меньше N, иначе дальше не пройти. Проверяют и планшет, и сервер.
/// </summary>
public class CheckRule
{
    public string Kind { get; set; } = "exclusive";
    public List<string> Keys { get; set; } = new();
    public int N { get; set; } = 1;
}

/// <summary>One option inside a group. Its key is what the API sends to select it.</summary>
public class DocGroupOption
{
    public string Key { get; set; } = "";
    public string Label { get; set; } = "";
    /// <summary>Оформленный текст варианта, см. DocCheckbox.LabelRuns.</summary>
    public List<TextRun> LabelRuns { get; set; } = new();
    /// <summary>Что дописать к тексту варианта. Только для запроса по API, см. DocCheckbox.LabelAppend.</summary>
    public string? LabelAppend { get; set; }
    /// <summary>
    /// Пришло из заказа, а в шаблоне документа этого не было. Ставится только там, где внешняя
    /// система добавляет в документ то, чего оператор не ставил. Пункт, чьё имя совпало с
    /// шаблонным, так не помечается: это элемент документа, заказ лишь задал ему состояние.
    /// </summary>
    public bool Api { get; set; }
    /// <summary>
    /// Элемент шаблонный, а надпись на нём пришла из заказа: label заменил её целиком или
    /// labelAppend дописал к ней. Это другой факт, чем Api, и в разбирательстве через год
    /// вопросы к ним разные: кто добавил пункт и кто написал его текст.
    /// </summary>
    public bool ApiText { get; set; }
    /// <summary>
    /// Что стояло в документе до того, как заказ переписал надпись. Пусто, когда ApiText не
    /// стоит. Хранится потому, что сама пометка через год ничего не объясняет: видно должно
    /// быть и то, что написал оператор, и то, что увидел клиент.
    /// </summary>
    public string? LabelBefore { get; set; }
}

/// <summary>
/// A set of options where at most one is chosen: "разрешаю / запрещаю", and choosing neither is a
/// third, valid state. Drawn as checkboxes rather than radio buttons on purpose, so tapping the
/// chosen one clears it and the signer can get back to having chosen nothing.
/// </summary>
public class DocGroup
{
    public string Key { get; set; } = "";
    public string Title { get; set; } = "";
    /// <summary>Оформленный заголовок группы, см. DocCheckbox.LabelRuns.</summary>
    public List<TextRun> TitleRuns { get; set; } = new();
    public List<DocGroupOption> Options { get; set; } = new();
    public bool Required { get; set; } = false;   // true: nothing chosen blocks the signer
    public string? Selected { get; set; }         // option key, or null for nothing chosen
    public VisibleWhen? VisibleWhen { get; set; }
    // Место элемента внутри страницы. Блоки текста, чекбоксы и группы стоят в одном общем порядке,
    // поэтому номер сквозной для всех трёх видов. -1 означает "не задан": так выглядят документы,
    // сохранённые до появления свободного порядка, и им номера проставляются при сохранении.
    public int Ord { get; set; } = -1;
    /// <summary>Заголовок выбора пришёл из заказа, см. DocCheckbox.ApiText.</summary>
    public bool ApiText { get; set; }
    /// <summary>Что стояло заголовком выбора до заказа, см. DocCheckbox.LabelBefore.</summary>
    public string? TitleBefore { get; set; }
}

/// <summary>A styled piece of text. Formatting is a curated set so it renders identically on the
/// tablet and in the PDF: bold, italic, a size keyword ("n"/"l"/"h") and an optional hex colour.</summary>
public class TextRun
{
    public string Text { get; set; } = "";
    public bool Bold { get; set; }
    public bool Italic { get; set; }
    public string? Color { get; set; }   // "#rrggbb" (from the editor palette); null = default text colour
    public string? Size { get; set; }    // "n" (normal) | "l" (large) | "h" (huge); null/other = normal
    /// <summary>Выделение фоном, как маркером: "#rrggbb". Пусто означает без выделения.</summary>
    public string? Mark { get; set; }
    /// <summary>
    /// Свой размер шрифта в точках, 8..40. Ноль означает «по ступени Size». Точки, а не проценты:
    /// это те же единицы, что в PDF, и на бумаге получается ровно то, что задано.
    /// </summary>
    public int SizePt { get; set; }
}

/// <summary>A condition on an API field, used to show or hide a block or a whole page.
/// op: eq | ne | empty | notempty | in. For "in", Value is a comma-separated list.</summary>
public class VisibleWhen
{
    public string Field { get; set; } = "";
    public string Op { get; set; } = "eq";
    public string Value { get; set; } = "";

    /// <summary>
    /// Дополнительные условия: содержимое показывается, только если выполнены и они тоже
    /// (Пол равно F И UG равно true). Список плоский, без вложенности: «и» ассоциативно, а
    /// скобки оператору не нужны и понятной формой на экране не показываются.
    /// </summary>
    public List<VisibleWhen>? And { get; set; }

    /// <summary>
    /// Другие наборы условий: содержимое показывается, если целиком выполнен хотя бы один из
    /// них («Пол равно Ж И возраст меньше 14» ИЛИ «представитель отмечен»). Каждый набор здесь
    /// это своя часть со своим списком «и». Вложенности нет: любое условие раскладывается в
    /// «или» из «и», а скобки оператору на экране показать нечем.
    /// </summary>
    public List<VisibleWhen>? Or { get; set; }

    /// <summary>
    /// Отрицание этой части: содержимое показывается, когда она НЕ выполнена. В паре с «и» это
    /// и есть «и не» («Пол равно Ж И НЕ представитель отмечен»), в паре с «или» это «или не», а
    /// на первой части просто «не». Отдельной пометкой, а не отдельными операциями: «ни одно из»
    /// и «не в окне годовщины» иначе выразить нечем, а у остальных сравнений обратное уже есть.
    /// </summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)]
    public bool Not { get; set; }
}

/// <summary>A block inside a page: either rich text (Runs) or an image (ImageUrl). Shown only when
/// its condition (if any) matches.</summary>
public class DocBlock
{
    public List<TextRun> Runs { get; set; } = new();
    /// <summary>
    /// Выравнивание абзаца: left, center, right, justify. Свойство абзаца, а не куска текста:
    /// выровнять половину строки нельзя. Пусто означает по левому краю.
    /// </summary>
    public string? Align { get; set; }
    public string? ImageUrl { get; set; }        // "/media/{file}" when this block is an image
    /// <summary>
    /// Имя тега картинки, присылаемой внешней системой. Когда оно задано, на место этого блока
    /// встаёт картинка из запроса, а ImageUrl остаётся запасным: он показывается, если картинку
    /// не прислали. Не прислали и запасной нет - блока не будет вовсе, пустая рамка хуже.
    /// </summary>
    public string? ImageTag { get; set; }
    public int ImageWidth { get; set; } = 100;   // image width as a percent of the content width (10..100)
    /// <summary>
    /// Обтекание картинки текстом: "left" картинка слева и текст справа от неё, "right" наоборот.
    /// Пусто означает картинку отдельной строкой, как было всегда. Работает одинаково на планшете,
    /// в предпросмотре и в PDF.
    /// </summary>
    public string? Wrap { get; set; }
    /// <summary>
    /// Отступ от картинки до обтекающего текста, в точках. Ноль означает вплотную, и это почти
    /// всегда плохо читается, поэтому по умолчанию небольшой отступ.
    /// </summary>
    public int WrapGap { get; set; } = 10;
    public VisibleWhen? VisibleWhen { get; set; }
    // Место элемента внутри страницы. Блоки текста, чекбоксы и группы стоят в одном общем порядке,
    // поэтому номер сквозной для всех трёх видов. -1 означает "не задан": так выглядят документы,
    // сохранённые до появления свободного порядка, и им номера проставляются при сохранении.
    public int Ord { get; set; } = -1;
    /// <summary>
    /// Особый вид блока: "divider" это горизонтальная черта, "pagebreak" это разрыв страницы в
    /// PDF (на планшете не рисуется: там свои экраны). Пусто это обычный текст или картинка.
    /// </summary>
    public string? Kind { get; set; }

    /// <summary>Режим списка: "bullet" маркированный, "number" нумерованный. Каждая строка блока
    /// становится пунктом. Пусто это обычный абзац.</summary>
    public string? List { get; set; }

    /// <summary>Фон блока, "#rrggbb". Пусто означает без плашки.</summary>
    public string? Bg { get; set; }
    /// <summary>Рамка блока, "#rrggbb". Пусто означает без рамки.</summary>
    public string? BorderColor { get; set; }
    /// <summary>Внутренний отступ плашки или рамки, в точках, 0..40.</summary>
    public int Pad { get; set; }
    /// <summary>Межстрочный интервал в процентах, 100..250. Ноль означает обычный.</summary>
    public int LineHeight { get; set; }

    /// <summary>Таблица. Блок с таблицей не несёт текста и картинки: у него только она.</summary>
    public DocTable? Table { get; set; }

    /// <summary>
    /// Печатать ли этот блок в PDF. У блока ограничений нет: текст, картинка и таблица ничего
    /// не подтверждают сами по себе, поэтому исключить можно любой.
    /// </summary>
    public bool InPdf { get; set; } = true;
}

public class DocPage
{
    /// <summary>
    /// Что это за экран: пусто это обычная страница текста, "signature" это экран подписи,
    /// "scan" это экран сканирования кода. Подпись и сканирование это отдельные экраны, а не
    /// элементы посреди текста: клиент на них занят одним делом и ничем больше.
    /// Само поле по-прежнему лежит в Signatures или Scans, поэтому в записи подписи, в PDF и в
    /// раскладке ничего не меняется.
    /// </summary>
    public string? Kind { get; set; }

    /// <summary>Выравнивание заголовка страницы: left, center, right, justify.</summary>
    public string? HeadingAlign { get; set; }

    /// <summary>
    /// Печатать ли эту страницу в PDF. Вступительный экран «внимательно прочитайте» нужен
    /// клиенту, но в подписанной бумаге он только мешает. Страницу, на которой клиент что-то
    /// отмечает, выбирает, вписывает, подписывает или сканирует, исключить нельзя: в PDF
    /// оказалась бы галочка без того, под чем она стоит.
    /// </summary>
    public bool InPdf { get; set; } = true;

    public string Heading { get; set; } = "";                  // legacy plain heading (fallback)
    public List<TextRun> HeadingRuns { get; set; } = new();    // rich heading
    public string Body { get; set; } = "";                     // legacy plain body (fallback)
    public List<DocBlock> Blocks { get; set; } = new();        // rich, optionally-conditional content
    public VisibleWhen? VisibleWhen { get; set; }              // page-level condition
    public List<DocCheckbox> Checkboxes { get; set; } = new();
    public List<DocGroup> Groups { get; set; } = new();
    /// <summary>Поля подписи внутри страницы: документ может требовать несколько подписей.</summary>
    public List<DocSignature> Signatures { get; set; } = new();
    /// <summary>Сканирование кода внутри страницы: штрихкод пробирки, QR из направления.</summary>
    public List<DocScan> Scans { get; set; } = new();
    /// <summary>Поля ввода внутри страницы: телефон, номер полиса, что угодно вписываемое.</summary>
    public List<DocInput> Inputs { get; set; } = new();
    /// <summary>Правила поверх отметок этой страницы.</summary>
    public List<CheckRule> CheckRules { get; set; } = new();
    /// <summary>Кнопка «отметить всё» над пунктами страницы: для длинных списков согласий.</summary>
    public bool ShowCheckAll { get; set; }
    public bool IncludeDynamic { get; set; } = false; // anchor: API-supplied checkboxes render here

    /// <summary>
    /// Управление размером текста на планшете: клиент сам делает буквы крупнее, если плохо видит.
    /// Признак стоит у страницы, но действует на весь показ: хватает одной отмеченной страницы,
    /// чтобы управление появилось. Иначе оператор, поставивший отметку не на той странице,
    /// получил бы документ, где ничего не происходит, и не понял бы почему.
    /// На бумагу не влияет: размер шрифта в PDF задаёт оператор, и выбор клиента его не трогает.
    /// </summary>
    public bool BigText { get; set; }
}

/// <summary>
/// Один документ в библиотеке: чем он адресуется по API и как называется у оператора.
/// Сам текст документа лежит отдельным файлом, чтобы список открывался, не читая их все.
/// </summary>
public class DocumentInfo
{
    public string Id { get; set; } = "";
    /// <summary>
    /// Код для API: его пишет оператор, им адресуется документ в запросе. Внутренний
    /// идентификатор опаковый и меняется при пересоздании, а код стабилен, читается в чужом коде
    /// и переживает перенос на другой сервер. Так же устроены рабочие места.
    /// </summary>
    public string Code { get; set; } = "";
    public string Name { get; set; } = "";
    /// <summary>Этот документ показывается, когда запрос пришёл без кода.</summary>
    public bool IsDefault { get; set; }
    /// <summary>
    /// Вид документа, повторённый из него самого: "info" или пусто. Хранится здесь, чтобы
    /// список документов открывался, не читая тексты всех. Правда лежит в самом документе, а
    /// это отражение, которое обновляется при каждом сохранении.
    /// </summary>
    public string? Kind { get; set; }
    public DateTime UpdatedUtc { get; set; }
}

/// <summary>Библиотека: список документов. Тексты документов лежат по отдельным файлам.</summary>
public class DocumentLibrary
{
    public List<DocumentInfo> Documents { get; set; } = new();
}

public class DocumentConfig
{
    /// <summary>
    /// Для чего этот документ. Пусто или "sign" это обычный подписной: страницы, экран подписи,
    /// запись и PDF. "info" это информационный: его существование в том, чтобы показать клиенту
    /// то, что прислала внешняя система, картинку или текст. У него нет экрана подписи, на
    /// последней странице стоит «Готово», и после него не остаётся ни записи, ни PDF.
    /// </summary>
    public string? Kind { get; set; }

    public string Title { get; set; } = "Документ";
    public List<DocPage> Pages { get; set; } = new();
    public string SignPrompt { get; set; } = "Пожалуйста, поставьте вашу подпись в поле ниже";
    // Custom content on the signature screen. SignBlocks sits above the signature field and
    // SignBlocksBelow under it, so a stamp, a note or company details can go on either side.
    public List<DocBlock> SignBlocks { get; set; } = new();
    public List<DocBlock> SignBlocksBelow { get; set; } = new();
    public string ThankYouText { get; set; } = "Спасибо! Ваша подпись принята.";
    public int IdleReturnSec { get; set; } = 180; // auto-return to ads after this idle time (0 = off)

    /// <summary>
    /// Раскладка подписей на листах PDF, если оператор расставил их вручную на вкладке «PDF».
    /// Подпись, для которой раскладки нет, печатается там же, где стоит её поле в документе.
    /// </summary>
    public List<SignaturePlacement> SignaturePlacements { get; set; } = new();

    /// <summary>
    /// Размер шрифта в PDF, в процентах от того, что видит клиент на планшете. Экран и бумага
    /// это разные носители: на планшете крупный шрифт нужен, чтобы читалось с расстояния, а в
    /// PDF тот же размер раздувает документ на лишние страницы. 100 означает как на планшете.
    /// </summary>
    public int PdfFontScale { get; set; } = 100;

    /// <summary>
    /// Размер места под подпись в PDF, в процентах от обычного (280 x 100 точек). Отдельно от
    /// шрифта: подпись может занимать на бумаге слишком много, даже когда текст уже мелкий.
    /// На подпись, которой задано своё место на листе, не влияет: у неё свой прямоугольник.
    /// </summary>
    public int PdfSignatureScale { get; set; } = 100;

    /// <summary>Колонтитул внизу каждой страницы PDF: номер страницы «N из M».</summary>
    public bool PdfPageNumbers { get; set; }
    /// <summary>Колонтитул: название документа.</summary>
    public bool PdfFooterTitle { get; set; }
    /// <summary>Колонтитул: номер записи подписи.</summary>
    public bool PdfFooterRecordId { get; set; }
    /// <summary>Колонтитул: штрихкод номера записи, чтобы бумажный лист находился по сканеру.</summary>
    public bool PdfFooterBarcode { get; set; }

    /// <summary>
    /// Экран благодарности как обычная страница: заголовок, текст и картинки с тем же
    /// оформлением, что и везде. Пусто означает старый вид, где показывалась одна строка
    /// ThankYouText: документы, собранные раньше, продолжают работать как работали.
    /// </summary>
    public List<TextRun> ThankYouRuns { get; set; } = new();
    public string? ThankYouAlign { get; set; }
    public List<DocBlock> ThankYouBlocks { get; set; } = new();

    /// <summary>
    /// Сколько секунд держать экран благодарности, прежде чем вернуться к рекламе. Меньше двух
    /// секунд человек не успевает прочитать, больше минуты планшет впустую занят.
    /// </summary>
    public int ThankYouSec { get; set; } = 6;
}

/// <summary>
/// Settings for talking to the FreeKiosk app running on the tablets (its local REST API).
/// The server must be able to reach the tablet directly on this port, so this only works when the
/// tablets are on the same network as the server (or reachable over a VPN).
/// </summary>
public class KioskControlSettings
{
    public bool Enabled { get; set; } = false;      // off until the operator configures the key
    public int Port { get; set; } = 8080;           // FreeKiosk REST API default
    public string ApiKey { get; set; } = "";        // sent as X-Api-Key
    public int TimeoutSec { get; set; } = 5;
    public bool AutoHeal { get; set; } = false;     // try to revive a tablet that dropped off air
    public int AutoHealAfterMinutes { get; set; } = 5;
    public int BatteryWarnPercent { get; set; } = 20;
    public int StorageWarnPercent { get; set; } = 10;   // free space below this raises an alert
}

/// <summary>Last known health of a tablet, read from its FreeKiosk API.</summary>
public class KioskHealth
{
    public DateTime CheckedUtc { get; set; }
    public bool Reachable { get; set; }
    public string? Error { get; set; }
    public int? BatteryPercent { get; set; }
    public bool? Charging { get; set; }
    public int? WifiSignalPercent { get; set; }
    public string? WifiSsid { get; set; }
    public int? StorageFreePercent { get; set; }
    public int? MemoryFreePercent { get; set; }
    public int? BrightnessPercent { get; set; }
    public bool? ScreenOn { get; set; }
    public bool? DeviceOwner { get; set; }
    public string? AppVersion { get; set; }
    public string? AndroidVersion { get; set; }
    public string? Model { get; set; }
}

/// <summary>An operational alert the operator must react to (a tablet went off air, errors piling up).</summary>
public class Alert
{
    public string Id { get; set; } = "";          // stable key, e.g. "offline:dev-123" - one alert per cause
    public string Kind { get; set; } = "";        // offline | errors | test
    public string Severity { get; set; } = "warn";// warn | error
    public string Title { get; set; } = "";
    public string Detail { get; set; } = "";
    public DateTime SinceUtc { get; set; }        // when the condition started
    public DateTime UpdatedUtc { get; set; }
    public string? DeviceId { get; set; }
    public string? DeviceName { get; set; }
    public bool Acknowledged { get; set; }        // the operator has seen it; stays until it clears
}

/// <summary>Operator-configurable alerting thresholds.</summary>
public class AlertSettings
{
    public bool Enabled { get; set; } = true;
    public int OfflineMinutes { get; set; } = 10;      // alert when a tablet has been off air this long
    public int ErrorCount { get; set; } = 5;           // alert when this many errors happen...
    public int ErrorWindowMinutes { get; set; } = 10;  // ...within this window
}

/// <summary>One operational log entry shown on the admin "Логи" tab.</summary>
public class LogEntry
{
    public long Id { get; set; }
    public DateTime Utc { get; set; }
    public string Level { get; set; } = "error";   // error | warn | info
    public string Source { get; set; } = "";       // server component or "tablet"
    public string Message { get; set; } = "";
    public string? Detail { get; set; }            // stack trace / extra context
    public string? DeviceId { get; set; }
    public string? DeviceName { get; set; }
}

public record ClientLogDto(string? Level, string? Message, string? Detail);

/// <summary>A barcode / QR code scanned on a tablet.</summary>
public class ScanRecord
{
    public string Id { get; set; } = "";
    public DateTime CreatedUtc { get; set; }
    public string Code { get; set; } = "";        // the decoded payload
    public string Format { get; set; } = "";      // QR_CODE, EAN_13, EAN_8, CODE_128, ...
    public string? DeviceId { get; set; }
    public string? DeviceName { get; set; }
    public string? WorkstationId { get; set; }
    public string? WorkstationName { get; set; }
}

public class ScanSubmission
{
    public string Code { get; set; } = "";
    public string Format { get; set; } = "";
}

/// <summary>Export/import envelope for the document template, so a backup file can be identified
/// and validated before it replaces the live template.</summary>
public class DocumentBackup
{
    public const string KindValue = "helix-signtablet-document";
    public string Kind { get; set; } = KindValue;
    /// <summary>
    /// 1 это файл без картинок: в нём только ссылки вида /media/имя. 2 добавляет сами картинки,
    /// поэтому шаблон переносится на другой сервер целиком. Файл версии 1 по-прежнему читается,
    /// просто картинок в нём нет.
    /// </summary>
    public int Version { get; set; } = 2;
    public DateTime ExportedUtc { get; set; }
    public DocumentConfig? Document { get; set; }
    /// <summary>Картинки, на которые ссылается документ. Без них шаблон на другом сервере
    /// оказался бы с пустыми рамками вместо печатей и гербов.</summary>
    public List<BackupImage>? Images { get; set; }
}

/// <summary>Одна картинка внутри файла шаблона: имя файла в медиатеке и его содержимое.</summary>
public class BackupImage
{
    public string File { get; set; } = "";
    /// <summary>Содержимое файла в base64, без префикса data:.</summary>
    public string Data { get; set; } = "";
}

// ---------- Signature submission / record ----------

public class SubmittedItem
{
    public string Key { get; set; } = "";     // empty for a checkbox the operator did not name
    public string Label { get; set; } = "";
    /// <summary>С чем клиент ушёл. Это и есть его ответ.</summary>
    public bool Checked { get; set; }
    /// <summary>Какую отметку просил заказ, см. DocCheckbox.CheckedFromApi.</summary>
    public bool? CheckedFromApi { get; set; }
    /// <summary>
    /// Клиент сам изменил то состояние, в котором пункт был ему показан. Считается сравнением
    /// показанного с итогом, но пишется явно: тот, кто через год откроет архив, не должен
    /// считать это в уме. Снятая клиентом отметка это самое сильное доказательство из
    /// возможных: человек совершил действие, значит видел пункт и решил про него.
    /// </summary>
    public bool ChangedBySigner { get; set; }
    /// <summary>
    /// Пришло из заказа, а в шаблоне документа этого не было. Ставится только там, где внешняя
    /// система добавляет в документ то, чего оператор не ставил. Пункт, чьё имя совпало с
    /// шаблонным, так не помечается: это элемент документа, заказ лишь задал ему состояние.
    /// </summary>
    public bool Api { get; set; }
    /// <summary>
    /// Элемент шаблонный, а надпись на нём пришла из заказа: label заменил её целиком или
    /// labelAppend дописал к ней. Это другой факт, чем Api, и в разбирательстве через год
    /// вопросы к ним разные: кто добавил пункт и кто написал его текст.
    /// </summary>
    public bool ApiText { get; set; }
    /// <summary>
    /// Что стояло в документе до того, как заказ переписал надпись. Пусто, когда ApiText не
    /// стоит. Хранится потому, что сама пометка через год ничего не объясняет: видно должно
    /// быть и то, что написал оператор, и то, что увидел клиент.
    /// </summary>
    public string? LabelBefore { get; set; }
}

/// <summary>What the signer chose in a group: the option key, or empty for nothing chosen.</summary>
public class SubmittedGroup
{
    public string Key { get; set; } = "";
    public string Title { get; set; } = "";
    public string Selected { get; set; } = "";
    public string SelectedLabel { get; set; } = "";
    public List<DocGroupOption> Options { get; set; } = new();
}

/// <summary>Одна из подписей внутри документа: имя поля, надпись и сама картинка.</summary>
public class SubmittedSignature
{
    public string Key { get; set; } = "";
    public string Label { get; set; } = "";
    public string Image { get; set; } = "";   // data URL (image/png)
}

/// <summary>Код, отсканированный внутри документа.</summary>
public class SubmittedScan
{
    public string Key { get; set; } = "";
    public string Label { get; set; } = "";
    public string Code { get; set; } = "";
    public string Format { get; set; } = "";
}

/// <summary>Подпись внутри страницы в сохранённой записи: картинка лежит отдельным файлом.</summary>
public class SignedSignature
{
    public string Key { get; set; } = "";
    public string Label { get; set; } = "";
    /// <summary>Имя файла рядом с записью, например signature-guardian.png.</summary>
    public string File { get; set; } = "";
}

/// <summary>Что клиент вписал в поле ввода.</summary>
public class SubmittedInput
{
    public string Key { get; set; } = "";
    public string Label { get; set; } = "";
    public string Value { get; set; } = "";
}

public class SignatureSubmission
{
    public List<SubmittedItem> Items { get; set; } = new();
    public List<SubmittedGroup> Groups { get; set; } = new();
    /// <summary>Подписи, поставленные внутри страниц. Итоговая подпись приходит в Signature.</summary>
    public List<SubmittedSignature> Signatures { get; set; } = new();
    /// <summary>Коды, отсканированные внутри страниц.</summary>
    public List<SubmittedScan> Scans { get; set; } = new();
    /// <summary>Вписанные значения полей ввода.</summary>
    public List<SubmittedInput> Inputs { get; set; } = new();
    public string Signature { get; set; } = ""; // data URL (image/png)
    // Identifies one signing session. If the response is lost and the tablet retries, the server
    // returns the record it already stored instead of creating a second, data-less duplicate.
    public string? SubmissionId { get; set; }
    /// <summary>
    /// Имя показа, под которым планшет получил этот документ. Сервер сверяет его со своим: если
    /// они разошлись, значит на планшет уже успели послать другой документ, и отметки этого
    /// клиента легли бы в снимок следующего. Дешёвая страховка от самого дорогого исхода:
    /// подписи одного человека под данными другого.
    /// </summary>
    public string? SessionId { get; set; }
}

public class SignatureRecord
{
    public string Id { get; set; } = "";
    public DateTime CreatedUtc { get; set; }
    public string DocumentTitle { get; set; } = "";
    /// <summary>Код документа из библиотеки. Заголовки повторяются и меняются со временем, а по
    /// коду через год видно, что именно подписали.</summary>
    public string? DocumentCode { get; set; }
    public string? DocumentName { get; set; }
    public string? DeviceId { get; set; }
    public string? DeviceName { get; set; }
    public string? WorkstationId { get; set; }
    public string? WorkstationName { get; set; }
    public List<SubmittedItem> Items { get; set; } = new();
    public List<SubmittedGroup> Groups { get; set; } = new();
    /// <summary>Подписи внутри страниц. Картинки лежат рядом с записью отдельными файлами.</summary>
    public List<SignedSignature> Signatures { get; set; } = new();
    /// <summary>Коды, отсканированные внутри документа.</summary>
    public List<SubmittedScan> Scans { get; set; } = new();
    /// <summary>Вписанные клиентом значения полей ввода.</summary>
    public List<SubmittedInput> Inputs { get; set; } = new();
    public Dictionary<string, string>? Fields { get; set; } // signer data used to fill {{tags}}
    public string? SubmissionId { get; set; }               // dedupes a retried submit
}

/// <summary>
/// Поле подписи внутри страницы. Документ может требовать несколько подписей: согласие на
/// обработку данных, отдельное согласие законного представителя, подтверждение отказа. Раньше
/// подпись была одна и только в самом конце.
/// </summary>
public class DocSignature
{
    /// <summary>
    /// Ширина места под подпись, в точках. Те же единицы, что и у высоты, и те же, что в PDF:
    /// оператор задаёт размер один раз и получает ровно его и на бумаге, и на экране. Обычные
    /// 280 на 100 это размер, с которого всё начиналось, поэтому старые документы не меняются.
    /// </summary>
    public int Width { get; set; } = 280;
    /// <summary>Высота места под подпись, в точках. Меньше сорока расписаться уже негде.</summary>
    public int Height { get; set; } = 100;
    /// <summary>Где стоит место под подпись: left, center, right. Пусто означает по левому краю.</summary>
    public string? Align { get; set; }

    /// <summary>Имя для API и для записи подписи. Пустое имя получает номер при сохранении.</summary>
    public string Key { get; set; } = "";
    /// <summary>Надпись над полем: что именно человек подписывает.</summary>
    public string Label { get; set; } = "";
    public bool Required { get; set; } = true;
    public int Ord { get; set; } = -1;
    public VisibleWhen? VisibleWhen { get; set; }
}

/// <summary>
/// Сканирование кода внутри страницы: клиент подносит к камере штрихкод пробирки или QR из
/// направления, и код попадает в запись подписи рядом с тем, что он подписал.
/// </summary>
public class DocScan
{
    public string Key { get; set; } = "";
    /// <summary>Что просить отсканировать.</summary>
    public string Label { get; set; } = "";
    public bool Required { get; set; } = true;
    public int Ord { get; set; } = -1;
    public VisibleWhen? VisibleWhen { get; set; }
}

/// <summary>
/// Куда поставить подпись на листе PDF. Координаты в долях страницы, а не в точках: так они
/// переживают смену размера листа и не зависят от того, в каком масштабе оператор смотрел макет.
/// Key совпадает с именем поля подписи; пустое имя означает итоговую подпись под документом.
/// </summary>
public class SignaturePlacement
{
    public string Key { get; set; } = "";
    /// <summary>Страница PDF, считая с нуля.</summary>
    public int Page { get; set; }
    /// <summary>Доли ширины и высоты листа: 0 это левый верхний угол, 1 это правый нижний.</summary>
    public double X { get; set; }
    public double Y { get; set; }
    public double W { get; set; } = 0.35;
    public double H { get; set; } = 0.08;
}

// ---------- Раскладка PDF ----------

/// <summary>
/// Один нарисованный элемент PDF со своим местом в точках. Координаты те же, что использует
/// генератор, поэтому предпросмотр в админке показывает не похожее на PDF, а его самого.
/// Page считается с нуля, Y отсчитывается от верха листа.
/// </summary>
public record PdfLayoutItem(int Page, string Kind, double X, double Y, double W, double H,
    string Text, double Size, bool Bold, bool Italic, string Color);

/// <summary>Размер листа и всё, что на нём нарисовано.</summary>
public record PdfLayout(double PageWidth, double PageHeight, int PageCount, List<PdfLayoutItem> Items);

// ---------- Расписание управления планшетами ----------

/// <summary>
/// Одно правило расписания: во сколько, в какие дни, что сделать и с какими планшетами.
/// Время местное для сервера: оператор задаёт «6:50 утра», а не UTC, и при переходе на летнее
/// время правило остаётся в 6:50 по стенным часам.
/// </summary>
public class ScheduleRule
{
    public string Id { get; set; } = "";
    public bool Enabled { get; set; } = true;

    /// <summary>Время в формате ЧЧ:ММ по часам сервера.</summary>
    public string Time { get; set; } = "07:00";

    /// <summary>Дни недели, 1 = понедельник … 7 = воскресенье. Пусто означает каждый день.</summary>
    public List<int> Days { get; set; } = new();

    /// <summary>Что сделать. Список действий задан в ScheduleActions.</summary>
    public string Action { get; set; } = "screen-on";

    /// <summary>Значение для яркости и громкости, 0..100.</summary>
    public int Value { get; set; } = 100;

    /// <summary>Текст для сообщения на экране планшета.</summary>
    public string Text { get; set; } = "";

    /// <summary>
    /// Кому: all (все планшеты), group:{id} (группа), device:{id} (один планшет) или
    /// devices (произвольный набор, перечисленный в DeviceIds).
    /// </summary>
    public string Target { get; set; } = "all";

    /// <summary>
    /// Отмеченные планшеты, когда Target = devices. Набор задаётся прямо в правиле, чтобы не
    /// приходилось заводить группу ради одного расписания: часто нужно «эти три планшета в
    /// зале», а группировать их больше незачем.
    /// </summary>
    public List<string> DeviceIds { get; set; } = new();

    /// <summary>
    /// Не трогать планшет, на котором прямо сейчас открыт документ. По умолчанию включено:
    /// погасить экран или перезагрузить планшет под рукой у подписывающего человека значит
    /// потерять его подпись и заставить всё начинать заново.
    /// </summary>
    public bool SkipBusy { get; set; } = true;

    public string Note { get; set; } = "";

    // Итог последнего запуска, чтобы оператор видел, работает ли правило.
    public DateTime? LastRunUtc { get; set; }
    public string LastResult { get; set; } = "";

    /// <summary>Местная дата последнего запуска (гггг-ММ-дд): правило срабатывает раз в сутки.</summary>
    public string LastRunLocalDate { get; set; } = "";
}

public class ScheduleStore
{
    public List<ScheduleRule> Rules { get; set; } = new();
}

// ---------- Realtime payloads (server -> kiosk) ----------

public class SlidesPayload
{
    public List<string> Images { get; set; } = new(); // resolved URLs
    public int IntervalSec { get; set; } = 6;
}

public class CurrentCommand
{
    public string Mode { get; set; } = "slides"; // "slides" | "document"
    public SlidesPayload? Slides { get; set; }
    public DocumentConfig? Document { get; set; }
    /// <summary>Имя сессии подписания. По нему планшет понимает при переподключении, что это
    /// тот же самый документ, и не сбрасывает клиенту прогресс.</summary>
    public string? SessionId { get; set; }
}

/// <summary>
/// Снимок сессии подписания: документ ровно в том виде, в каком его получил планшет. Хранится
/// отдельным файлом на время сессии. Запись и PDF собираются из него, а не из текущего шаблона:
/// шаблон могли править, пока человек подписывал, а подписал он то, что видел.
/// </summary>
public class DocSession
{
    public string SessionId { get; set; } = "";
    public DocumentConfig Document { get; set; } = new();
    /// <summary>Поля подписанта, отобранные по шаблону на момент показа: только те, что документ
    /// действительно использует. Считаются при показе, потому что при отправке шаблон уже мог
    /// быть другим.</summary>
    public Dictionary<string, string>? RecordFields { get; set; }
    /// <summary>Из какого документа библиотеки сделан снимок: попадёт в запись подписи.</summary>
    public string? DocumentCode { get; set; }
    public string? DocumentName { get; set; }
    public DateTime ShownUtc { get; set; }
}

// ---------- API DTOs ----------

public record LoginDto(string? Password);
/// <summary>DeviceIds задаёт произвольный набор планшетов, когда Target = devices.</summary>
public record PlaylistSaveDto(string? Target, List<string>? ImageIds, int IntervalSec, List<string>? DeviceIds = null);
public record TargetDto(string? Target);
public record ShowDocumentDto(string? Target, Dictionary<string, string>? Fields, List<ApiCheckboxDto>? Checkboxes, List<GroupSelectionDto>? Groups,
    Dictionary<string, string>? Images = null, string? DocumentCode = null);

public record EnrollRequest(string? Code);
public record CreateEnrollmentDto(string? Name, string? WorkstationId, List<string>? GroupIds, int? TtlMinutes);
public record DeviceUpdateDto(string? Name, List<string>? GroupIds, string? WorkstationId);
public record GroupDto(string? Name);
/// <summary>Сроки показа картинки в рекламе. Пустая дата снимает ограничение с этой стороны.</summary>
public record ImageDatesDto(string? ShowFrom, string? ShowTo);
public record ImageGroupsDto(List<string>? GroupIds, List<string>? ExceptGroupIds);
public record WorkstationDto(string? ExternalId, string? Name, string? Location);
public record ApiKeyDto(string? Label);

public record ExtEnrollmentDto(string? WorkstationExternalId, string? Name);
public record ExtWorkstationAssignDto(string? ExternalId);
/// <summary>
/// Images: картинки, присылаемые вместе с заказом. Ключ это имя тега картинки в документе,
/// значение это сама картинка строкой BASE64, с приставкой data:image/... или без неё.
/// </summary>
public record ExtShowDocumentDto(string? DeviceId, string? WorkstationExternalId, Dictionary<string, string>? Fields, List<ApiCheckboxDto>? Checkboxes, List<GroupSelectionDto>? Groups,
    Dictionary<string, string>? Images = null, string? DocumentCode = null);

/// <summary>
/// Пункт согласия, присланный внешней системой. Отдельный вид от DocCheckbox ровно из-за
/// обязательности: у пункта в документе она включена по умолчанию, потому что оператор ставит
/// пункт затем, чтобы клиент его отметил. У присланного по API наоборот: не сказали про
/// обязательность, значит не обязателен. Иначе запрос без единого слова про required давал пункт
/// со звёздочкой, который клиент не может пропустить, и интегратор об этом не знал.
/// </summary>
public class ApiCheckboxDto
{
    public string Key { get; set; } = "";
    public string Label { get; set; } = "";
    public string? LabelAppend { get; set; }
    public bool? Required { get; set; }
    public bool Checked { get; set; }
    public VisibleWhen? VisibleWhen { get; set; }

    /// <summary>Пункт документа из присланного. Обязательность только та, о которой сказали явно.</summary>
    public DocCheckbox ВПункт() => new()
    {
        Key = Key, Label = Label, LabelAppend = LabelAppend,
        Required = Required ?? false, Checked = Checked, VisibleWhen = VisibleWhen
    };
}
public record ExtScanRequestDto(string? DeviceId, string? WorkstationExternalId, int? TimeoutSec);
public record AckDto(string? Id);
/// <summary>Выбор варианта в группе, присланный внешней системой.</summary>
/// <summary>
/// Выбор в двойных зависимых чекбоксах, присланный по API. Title и Options позволяют заодно
/// прислать и текст: заголовок группы и подписи вариантов, если формулировка зависит от заказа.
/// </summary>
public record GroupSelectionDto(string? Key, string? Selected, string? Title, string? TitleAppend,
    List<DocGroupOption>? Options);

public record ControlAddressDto(string? Ip, int? Port);
/// <summary>What the admin panel sends when saving tablet control settings. The API key is
/// write-only: blank keeps the stored key, and removing it is an explicit request.</summary>
public record KioskControlSettingsDto(bool Enabled, int Port, string? ApiKey, bool ClearApiKey,
    int TimeoutSec, bool AutoHeal, int AutoHealAfterMinutes, int BatteryWarnPercent, int StorageWarnPercent);
public record ValueDto(int? Value);
public record TextDto(string? Text);
/// <summary>Создание и переименование документа в библиотеке.</summary>
public record DocumentMetaDto(string? Code, string? Name, string? CopyOfId);

public record PreviewDto(DocumentConfig? Document, Dictionary<string, string>? Fields, List<ApiCheckboxDto>? Checkboxes, List<GroupSelectionDto>? Groups,
    Dictionary<string, string>? Images = null, string? DocumentId = null);
