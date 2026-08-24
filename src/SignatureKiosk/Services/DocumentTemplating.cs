using System.Text.Json;
using System.Text.RegularExpressions;
using SignatureKiosk.Models;

namespace SignatureKiosk.Services;

/// <summary>
/// Fills a document template for one signer:
///   • substitutes {{placeholder}} tags (for example {{ФИО}}, {{Пол}}, {{date}}) with API values;
///   • evaluates conditions so a block or a whole page is shown only for matching signers;
///   • injects API-supplied checkboxes.
/// Formatting is carried as structured "runs" (text + bold/italic/size/colour), never HTML, so it
/// renders identically on the tablet and in the PDF and cannot inject markup.
/// </summary>
public static partial class DocumentTemplating
{
    // NonBacktracking guarantees linear time: the previous engine degraded quadratically on a long
    // run of unclosed braces, and such text can arrive from the API (a checkbox label) or be saved
    // in the template, which would hang every later render of that document.
    [GeneratedRegex(@"\{\{\s*(.+?)\s*\}\}", RegexOptions.Singleline | RegexOptions.NonBacktracking)]
    private static partial Regex TagRegex();

    /// <summary>Upper bound for any single templated string. Generous for real consent text, but
    /// stops a pathological payload from being stored and re-processed on every render.</summary>
    public const int MaxTextLength = 20000;

    /// <summary>Build the lookup used for substitution. Field names are matched case-insensitively,
    /// so two names differing only in case are the same field: the last one wins instead of throwing
    /// (which used to happen AFTER the device state was already stored, bricking that tablet).</summary>
    private static Dictionary<string, string>? BuildMap(IReadOnlyDictionary<string, string>? fields)
    {
        if (fields is null || fields.Count == 0) return null;
        var map = new Dictionary<string, string>(fields.Count, StringComparer.OrdinalIgnoreCase);
        foreach (var kv in fields) map[kv.Key ?? ""] = kv.Value ?? "";
        return map;
    }

    /// <summary>The documented set of API fields (tags), in the order the editor offers them.</summary>
    public static readonly string[] KnownFields =
    {
        "ФИО", "ДР", "Адрес регистрации", "Пол", "email", "telephone", "document",
        "date", "cross-border", "urine", "UG",
        "text1", "text2", "text3", "text4", "text5", "text6", "text7", "text8", "text9", "text10"
    };

    private static readonly HashSet<string> AllowedSizes = new(StringComparer.Ordinal) { "n", "l", "h" };
    // agelt и agege считают возраст по дате рождения: внешняя система присылает только дату, а
    // документу нужно знать, младше ли человек четырнадцати. Две операции, а не четыре, потому
    // что «младше N» и «N и старше» делят людей ровно надвое, без щели и без нахлёста.
    private static readonly HashSet<string> AllowedOps = new(StringComparer.Ordinal)
        {
            "eq", "ne", "empty", "notempty", "in", "agelt", "agege", "annivwithin",
            // Числа для любых тегов: сумма, количество, что угодно числовое.
            "numlt", "numge", "numin",
            // Момент показа: день недели, период дат, время суток. Поле у таких условий
            // служебное, "@сегодня": значение берётся из часов сервера, а не из тегов, и
            // прислать его снаружи нельзя, оно всё равно не читается.
            "dow", "daterange", "timerange",
            // Отметки: из перечисленных в поле имён отмечено не меньше N. Считается на планшете.
            "minchecked"
        };

    /// <summary>Служебное имя поля для условий по моменту показа.</summary>
    public const string TodayField = "@сегодня";

    public static bool IsClockOp(string? op) => op is "dow" or "daterange" or "timerange";
    public static bool IsNumOp(string? op) => op is "numlt" or "numge" or "numin";

    public static bool IsAgeOp(string? op) =>
        string.Equals(op, "agelt", StringComparison.Ordinal) || string.Equals(op, "agege", StringComparison.Ordinal);

    /// <summary>
    /// Условие по сроку: до годовщины даты из тега осталось или прошло не больше N дней. Считается
    /// день и месяц, год не важен. Это случай дня рождения: сравнивать полную дату там
    /// бессмысленно, она в прошлом на десятки лет.
    /// </summary>
    public static bool IsDaysOp(string? op) =>
        string.Equals(op, "annivwithin", StringComparison.Ordinal);

    /// <summary>Дата из тега. Разбор нестрогий: формат приходит из чужой системы.</summary>
    public static DateTime? ParseDate(string? value)
    {
        var v = (value ?? "").Trim();
        if (v.Length == 0) return null;
        var formats = new[] { "dd.MM.yyyy", "d.M.yyyy", "yyyy-MM-dd", "dd/MM/yyyy", "d/M/yyyy", "dd-MM-yyyy" };
        if (DateTime.TryParseExact(v, formats, System.Globalization.CultureInfo.InvariantCulture,
                System.Globalization.DateTimeStyles.None, out var d)) return d.Date;
        if (DateTime.TryParse(v, System.Globalization.CultureInfo.InvariantCulture,
                System.Globalization.DateTimeStyles.None, out d)) return d.Date;
        return null;
    }

    /// <summary>Число из текста: запятая принимается как точка, пробелы обрезаются.</summary>
    private static bool TryNum(string? value, out decimal n) =>
        decimal.TryParse((value ?? "").Trim().Replace(',', '.'), System.Globalization.NumberStyles.Float,
            System.Globalization.CultureInfo.InvariantCulture, out n);

    /// <summary>Границы диапазона из записи «от..до».</summary>
    private static (string От, string До) SplitRange(string? value)
    {
        var parts = (value ?? "").Split("..", 2);
        return (parts[0].Trim(), parts.Length > 1 ? parts[1].Trim() : "");
    }

    /// <summary>Время из «HH:mm».</summary>
    private static TimeSpan? ParseTime(string? value) =>
        TimeSpan.TryParseExact((value ?? "").Trim(), @"h\:mm", null, out var t) ? t : null;

    /// <summary>Попадает ли «сейчас» в диапазон «от..до». Открытая граница означает без предела.
    /// Ночной диапазон вида 22:00..06:00 честно переворачивается: попадает всё вне середины.</summary>
    private static bool WithinRange<T>(string target, T now, Func<string, T?> parse) where T : struct, IComparable<T>
    {
        var (от, до) = SplitRange(target);
        var a = parse(от);
        var b = parse(до);
        if (a is null && b is null) return false;
        if (a is not null && b is not null && a.Value.CompareTo(b.Value) > 0)
            return now.CompareTo(a.Value) >= 0 || now.CompareTo(b.Value) <= 0;
        if (a is not null && now.CompareTo(a.Value) < 0) return false;
        if (b is not null && now.CompareTo(b.Value) > 0) return false;
        return true;
    }

    /// <summary>
    /// Дни от сегодняшнего дня до даты со знаком: плюс это дата впереди, минус это она уже
    /// прошла. Для годовщины перебираются прошлый, этот и следующий год, потому что до дня
    /// рождения может быть и три дня вперёд, и триста шестьдесят два назад, и годится любая
    /// сторона, лишь бы она уложилась в своё окно.
    /// </summary>
    public static IEnumerable<int> DaysToAll(string? value, bool anniversary, DateTime? today = null)
    {
        var date = ParseDate(value);
        if (date is null) yield break;
        var now = (today ?? DateTime.Now).Date;
        if (!anniversary) { yield return (date.Value - now).Days; yield break; }

        foreach (var year in new[] { now.Year - 1, now.Year, now.Year + 1 })
        {
            // 29 февраля в невисокосный год празднуют 28-го: иначе такая дата не совпала бы
            // никогда, и условие для неё не сработало бы ни разу.
            var day = date.Value.Day;
            var month = date.Value.Month;
            if (month == 2 && day == 29 && !DateTime.IsLeapYear(year)) day = 28;
            yield return (new DateTime(year, month, day) - now).Days;
        }
    }

    /// <summary>
    /// Окно условия по сроку: «7» это семь дней в обе стороны, «14/3» это четырнадцать дней до
    /// даты и три после. Раздельные окна нужны, потому что поздравлять за две недели и
    /// напоминать ещё две недели спустя это разные вещи.
    /// </summary>
    public static (int Before, int After)? ParseWindow(string? value)
    {
        var v = (value ?? "").Trim();
        if (v.Length == 0) return null;
        var parts = v.Split('/', 2);
        if (!int.TryParse(parts[0].Trim(), out var before) || before < 0) return null;
        if (parts.Length == 1) return (before, before);
        if (!int.TryParse(parts[1].Trim(), out var after) || after < 0) return null;
        return (before, after);
    }

    /// <summary>Укладывается ли сегодняшний день в окно вокруг даты из тега.</summary>
    public static bool WithinDays(string? value, bool anniversary, string? window, DateTime? today = null)
    {
        var w = ParseWindow(window);
        if (w is null) return false;
        foreach (var d in DaysToAll(value, anniversary, today))
        {
            // Дата впереди: считается окно «до». Дата прошла: окно «после». Сам день попадает в
            // оба, поэтому нулевое окно с обеих сторон означает ровно этот день.
            if (d >= 0 ? d <= w.Value.Before : -d <= w.Value.After) return true;
        }
        return false;
    }

    /// <summary>
    /// Полных лет на сегодня. Дата принимается в привычных видах: 01.01.1990, 1990-01-01,
    /// 01/01/1990. Разбор нестрогий намеренно: формат даты приходит из чужой системы, и падать
    /// из-за точки вместо дефиса нельзя.
    /// </summary>
    public static int? AgeYears(string? value, DateTime? today = null)
    {
        var v = (value ?? "").Trim();
        if (v.Length == 0) return null;
        var formats = new[] { "dd.MM.yyyy", "d.M.yyyy", "yyyy-MM-dd", "dd/MM/yyyy", "d/M/yyyy", "dd-MM-yyyy" };
        if (!DateTime.TryParseExact(v, formats, System.Globalization.CultureInfo.InvariantCulture,
                System.Globalization.DateTimeStyles.None, out var born) &&
            !DateTime.TryParse(v, System.Globalization.CultureInfo.InvariantCulture,
                System.Globalization.DateTimeStyles.None, out born))
            return null;

        var now = (today ?? DateTime.Now).Date;
        if (born.Date > now) return null;               // дата из будущего это ошибка, а не возраст
        var years = now.Year - born.Year;
        if (born.Date.AddYears(years) > now) years--;   // день рождения в этом году ещё не наступил
        return years;
    }
    private static readonly IReadOnlyDictionary<string, string> EmptyMap =
        new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

    // ---------- Substitution ----------

    /// <summary>Replace {{tags}} in a single string using the supplied fields.</summary>
    public static string Apply(string? text, IReadOnlyDictionary<string, string>? fields)
    {
        if (string.IsNullOrEmpty(text)) return text ?? "";
        if (fields is null || fields.Count == 0) return text;
        return TagRegex().Replace(text, m =>
        {
            var key = m.Groups[1].Value.Trim();
            return fields.TryGetValue(key, out var value) ? value ?? "" : m.Value;
        });
    }

    // Через этот метод проходит ВЕСЬ оформленный текст документа: абзацы, заголовки страниц,
    // подписи пунктов, заголовки и варианты групп, прощание. Всё, что здесь не перечислено,
    // теряется по дороге к планшету, к наблюдению и к бумаге. Так молча пропали выделение
    // маркером и свой размер в точках: их бережно хранили при сохранении и умели рисовать все
    // три отрисовщика, а до них они просто не доезжали.
    private static TextRun ApplyRun(TextRun r, IReadOnlyDictionary<string, string>? map) => new()
    {
        Text = Apply(r.Text, map),
        Bold = r.Bold,
        Italic = r.Italic,
        Color = r.Color,
        Size = r.Size,
        Mark = r.Mark,
        SizePt = r.SizePt
    };

    private static DocCheckbox Cb(DocCheckbox c, IReadOnlyDictionary<string, string>? map,
        HashSet<string>? live = null, IReadOnlyDictionary<string, bool>? states = null,
        IReadOnlyDictionary<string, string>? texts = null)
    {
        var key = (c.Key ?? "").Trim();
        var isChecked = c.Checked;
        if (key.Length > 0 && states is not null && states.TryGetValue(key, out var fromApi)) isChecked = fromApi;
        // Текст мог прийти по API: место в документе одно и то же, а формулировка зависит от
        // заказа. Пустую строку не берём, иначе пункт остался бы без подписи.
        var label = c.Label;
        if (key.Length > 0 && texts is not null && texts.TryGetValue(key, out var t) && !string.IsNullOrWhiteSpace(t))
            label = t;
        // Оформленный текст переживает подстановку тегов так же, как обычный абзац. Присланный
        // по API текст оформления не несёт, поэтому он и заменяет оформленный целиком: внешняя
        // система прислала другую формулировку, а не другой её вид.
        var runs = texts is not null && key.Length > 0 && texts.ContainsKey(key)
            ? new List<TextRun> { new() { Text = label ?? "" } }
            : LabelRuns(c.LabelRuns, label);
        return new DocCheckbox
        {
            Key = key,
            Label = Apply(label, map),
            LabelRuns = runs.Where(r => r is not null).Select(r => ApplyRun(r, map)).ToList(),
            Required = c.Required,
            Checked = isChecked,
            VisibleWhen = live is null ? null : LiveCondition(c.VisibleWhen, map, live),
            Ord = c.Ord
        };
    }

    /// <summary>Resolve one group: substitute its texts and apply a selection sent by the API.</summary>
    private static DocGroup Grp(DocGroup g, IReadOnlyDictionary<string, string>? map,
        HashSet<string> live, IReadOnlyDictionary<string, string>? selections,
        IReadOnlyDictionary<string, string>? texts = null,
        IReadOnlyDictionary<string, List<DocGroupOption>>? apiOptions = null)
    {
        var key = (g.Key ?? "").Trim();
        // Текст варианта тоже может прийти по API, под ключом «группа/вариант». Имена не могут
        // содержать косую черту, поэтому разночтения быть не может.
        string? Text(string name)
        {
            if (texts is null || name.Length == 0) return null;
            return texts.TryGetValue(name, out var t) && !string.IsNullOrWhiteSpace(t) ? t : null;
        }
        // Варианты могут прийти по API целиком: заказ приходит со своим списком ответов, и
        // тогда он и есть список. Присланный список заменяет тот, что в документе, а не
        // складывается с ним: иначе на экране оказались бы и свои варианты, и чужие сразу.
        // Текст варианта, который есть и там и там, всё равно можно дописать через labelAppend.
        var source = g.Options ?? new List<DocGroupOption>();
        if (key.Length > 0 && apiOptions is not null
            && apiOptions.TryGetValue(key, out var sent) && sent is { Count: > 0 })
            source = sent;

        var options = source
            .Where(o => o is not null)
            .Select(o =>
            {
                var ok = (o.Key ?? "").Trim();
                var sentLabel = Text(key + "/" + ok);
                var oruns = sentLabel is not null
                    ? new List<TextRun> { new() { Text = sentLabel } }
                    : LabelRuns(o.LabelRuns, o.Label);
                return new DocGroupOption
                {
                    Key = ok,
                    Label = Apply(sentLabel ?? o.Label, map),
                    LabelRuns = oruns.Where(r => r is not null).Select(r => ApplyRun(r, map)).ToList()
                };
            })
            .Where(o => o.Key.Length > 0)
            .ToList();

        var selected = (g.Selected ?? "").Trim();
        if (key.Length > 0 && selections is not null && selections.TryGetValue(key, out var fromApi))
            selected = (fromApi ?? "").Trim();
        // A selection naming an option that does not exist means nothing chosen, never a phantom.
        if (selected.Length > 0 && !options.Any(o => string.Equals(o.Key, selected, StringComparison.OrdinalIgnoreCase)))
            selected = "";

        return new DocGroup
        {
            Key = key,
            Title = Apply(Text(key) ?? g.Title, map),
            TitleRuns = (Text(key) is not null
                    ? new List<TextRun> { new() { Text = Text(key)! } }
                    : LabelRuns(g.TitleRuns, g.Title))
                .Where(r => r is not null).Select(r => ApplyRun(r, map)).ToList(),
            Options = options,
            Required = g.Required,
            Selected = selected.Length == 0 ? null : selected,
            VisibleWhen = LiveCondition(g.VisibleWhen, map, live),
            Ord = g.Ord
        };
    }

    // ---------- Conditions ----------

    /// <summary>Evaluate a block/page condition against the signer fields. A null condition is always true.</summary>
    /// <summary>
    /// Части составного условия: само условие и всё, что присоединено через «и». Части без имени
    /// поля пропускаются: недозаполненная часть не должна молча скрывать содержимое.
    /// </summary>
    public static IEnumerable<VisibleWhen> Parts(VisibleWhen? cond)
    {
        if (cond is null) yield break;
        if (!string.IsNullOrWhiteSpace(cond.Field)) yield return cond;
        foreach (var extra in cond.And ?? new List<VisibleWhen>())
            if (extra is not null && !string.IsNullOrWhiteSpace(extra.Field)) yield return extra;
    }

    /// <summary>
    /// Наборы условия: первый это оно само со своим списком «и», остальные приходят из списка
    /// «или». Достаточно одного выполненного набора целиком.
    /// </summary>
    public static IEnumerable<VisibleWhen> Groups(VisibleWhen? cond)
    {
        if (cond is null) yield break;
        yield return cond;
        foreach (var alt in cond.Or ?? new List<VisibleWhen>())
            if (alt is not null) yield return alt;
    }

    /// <summary>Выполняется ли условие: хотя бы один набор целиком.</summary>
    public static bool Matches(VisibleWhen? cond, IReadOnlyDictionary<string, string>? fields, bool своиИмена = false)
    {
        if (cond is null) return true;
        foreach (var group in Groups(cond))
            if (MatchesGroup(group, fields, своиИмена)) return true;
        return false;
    }

    /// <summary>Выполнен ли один набор: все его части одновременно.</summary>
    private static bool MatchesGroup(VisibleWhen group, IReadOnlyDictionary<string, string>? fields, bool своиИмена = false)
    {
        foreach (var part in Parts(group))
            if (!MatchesOne(part, fields, своиИмена)) return false;
        return true;
    }

    private static bool MatchesOne(VisibleWhen? cond, IReadOnlyDictionary<string, string>? fields, bool своиИмена = false)
    {
        if (cond is null || string.IsNullOrWhiteSpace(cond.Field)) return true;
        // «Не» переворачивает ответ части целиком, включая случай «даты нет». Иначе «возраст
        // меньше 14» и «не возраст меньше 14» оба оказались бы невыполненными при непришедшей
        // дате рождения, и клиент не увидел бы ни детского варианта, ни взрослого. Отрицание
        // обязано быть в точности обратным, иначе о нём нельзя рассуждать.
        var ok = Holds(cond, fields, своиИмена);
        return cond.Not ? !ok : ok;
    }

    /// <param name="своиИмена">
    /// Значения принадлежат самому документу (отметки, выбор, вписанное), а не заказу. Приведение
    /// к общему виду тогда не делается: оно описывает теги заказа («да» это true, «Ж» это F), а
    /// планшет своих имён так не приводит. С приведением группа «Пол» с вариантом F показывала
    /// блок в бумаге по условию «Пол равно Ж» и не показывала его на экране.
    /// </param>
    private static bool Holds(VisibleWhen cond, IReadOnlyDictionary<string, string>? fields, bool своиИмена = false)
    {
        fields ??= EmptyMap;
        var field = cond.Field.Trim();
        fields.TryGetValue(field, out var raw);
        // Both sides go through the same normalisation, so a boolean tag sent as True matches a
        // condition written as true, and a condition saved before the tag became a boolean
        // (да / нет) keeps working instead of silently never matching.
        var val = своиИмена ? (raw ?? "").Trim() : FieldSchema.Canonical(field, raw);
        var target = своиИмена ? (cond.Value ?? "").Trim() : FieldSchema.Canonical(field, cond.Value);
        if (IsDaysOp(cond.Op))
        {
            // Срок считается из значения тега. Нет даты или её не удалось разобрать: условие не
            // выполнено. Показать «поздравляем с днём рождения» не тому хуже, чем не показать
            // при испорченной дате, о которой всё равно сообщается отдельно.
            if (ParseDate(raw) is null) return false;
            return WithinDays(raw, anniversary: true, target);
        }

        if (IsClockOp(cond.Op))
        {
            // Момент показа: считается по часам сервера в момент разбора. Значение тега тут ни
            // при чём, поэтому подделать его через API нельзя.
            var сейчас = DateTime.Now;
            return cond.Op switch
            {
                "dow" => target.Split(',').Select(x => x.Trim()).Any(x =>
                    int.TryParse(x, out var d) && d == (сейчас.DayOfWeek == DayOfWeek.Sunday ? 7 : (int)сейчас.DayOfWeek)),
                "daterange" => WithinRange(target, сейчас.Date, ParseDate),
                _ => WithinRange(target, сейчас.TimeOfDay, ParseTime)
            };
        }

        if (IsNumOp(cond.Op))
        {
            // Числа сравниваются как числа: «9» меньше «10», хотя как строки наоборот. Нет
            // значения или оно не число: условие не выполнено, и отрицание ведёт себя обратно.
            if (!TryNum(raw, out var n)) return false;
            if (cond.Op == "numin")
            {
                var (от, до) = SplitRange(target);
                return TryNum(от, out var a) && TryNum(до, out var b2) && n >= a && n <= b2;
            }
            if (!TryNum(target, out var lim)) return false;
            return cond.Op == "numlt" ? n < lim : n >= lim;
        }

        // Счёт отметок вычисляет планшет: здесь, при разборе по тегам, перечисленные имена ещё
        // никто не нажимал. Часть с этой операцией всегда живая (см. Split), сюда она попадает
        // только из ApplyLiveConditions, где значения отметок уже известны.
        if (cond.Op == "minchecked")
        {
            var имена = cond.Field.Split(',').Select(x => x.Trim()).Where(x => x.Length > 0);
            if (!int.TryParse((cond.Value ?? "").Trim(), out var n) || n < 1) return false;
            var отмечено = имена.Count(k => fields.TryGetValue(k, out var v) &&
                string.Equals(v?.Trim(), "true", StringComparison.OrdinalIgnoreCase));
            return отмечено >= n;
        }

        if (IsAgeOp(cond.Op))
        {
            // Возраст считается из значения тега. Нет даты или её не удалось разобрать: условие
            // не выполнено, блок не показывается. Показать блок «для законных представителей»
            // взрослому хуже, чем не показать его при испорченной дате, о которой всё равно
            // сообщается отдельно.
            var years = AgeYears(raw);
            if (years is null) return false;
            if (!int.TryParse(target, out var limit)) return false;
            return cond.Op == "agelt" ? years < limit : years >= limit;
        }

        return cond.Op switch
        {
            "ne" => !Eq(val, target),
            "empty" => val.Length == 0,
            "notempty" => val.Length > 0,
            "in" => target.Split(',').Select(s => s.Trim()).Where(s => s.Length > 0).Any(s => Eq(val, s)),
            _ => Eq(val, target) // "eq"
        };
    }

    private static bool Eq(string a, string b) => string.Equals(a, b, StringComparison.OrdinalIgnoreCase);

    // ---------- Normalisation (rich runs, with a fallback to the legacy plain Heading/Body) ----------

    /// <summary>Heading as runs: the rich HeadingRuns if present, else the legacy plain Heading.</summary>
    public static List<TextRun> HeadingRuns(DocPage p)
    {
        if (p.HeadingRuns is { Count: > 0 }) return p.HeadingRuns;
        return string.IsNullOrEmpty(p.Heading) ? new List<TextRun>() : new List<TextRun> { new() { Text = p.Heading } };
    }

    /// <summary>Content blocks: the rich Blocks if present, else the legacy plain Body as one block.</summary>
    public static List<DocBlock> Blocks(DocPage p)
    {
        if (p.Blocks is { Count: > 0 }) return p.Blocks;
        return string.IsNullOrEmpty(p.Body)
            ? new List<DocBlock>()
            : new List<DocBlock> { new() { Runs = new List<TextRun> { new() { Text = p.Body } } } };
    }

    // ---------- Resolve ----------

    /// <summary>
    /// Return a resolved copy of the document for one signer: tags substituted, conditions applied
    /// (non-matching blocks and pages removed), API checkboxes injected. The template is never mutated,
    /// and the tablet only ever receives the blocks it is meant to see.
    /// </summary>
    public static DocumentConfig Resolve(DocumentConfig doc, IReadOnlyDictionary<string, string>? fields,
        IReadOnlyList<DocCheckbox>? dynamicCheckboxes = null,
        IReadOnlyDictionary<string, string>? groupSelections = null,
        IReadOnlyDictionary<string, bool>? checkboxStates = null,
        IReadOnlyDictionary<string, string>? texts = null,
        IReadOnlyDictionary<string, List<DocGroupOption>>? apiOptions = null,
        IReadOnlyDictionary<string, string>? images = null)
    {
        var map = BuildMap(fields);
        var hasDynamic = dynamicCheckboxes is { Count: > 0 };
        // Names of checkboxes and groups in this document. A condition on one of them cannot be
        // settled here: it depends on what the signer does next, so the block travels to the
        // tablet with its condition intact and is evaluated there as they tick.
        var live = LiveKeys(doc);

        var pages = new List<DocPage>();
        foreach (var p in doc.Pages ?? new List<DocPage>())
        {
            if (p is null) continue;                    // tolerate a document stored before Sanitize hardened
            if (!Keep(p.VisibleWhen, map, live)) continue;

            var resolved = new DocPage
            {
                Kind = p.Kind,
                InPdf = p.InPdf,
                HeadingRuns = HeadingRuns(p).Where(r => r is not null).Select(r => ApplyRun(r, map)).ToList(),
                HeadingAlign = p.HeadingAlign,
                Blocks = ResolveBlocks(Blocks(p), map, live, images),
                IncludeDynamic = p.IncludeDynamic,
                VisibleWhen = LiveCondition(p.VisibleWhen, map, live),
                Checkboxes = (p.Checkboxes ?? new List<DocCheckbox>())
                    .Where(c => c is not null && Keep(c.VisibleWhen, map, live))
                    .Select(c => Cb(c, map, live, checkboxStates, texts)).ToList(),
                Groups = (p.Groups ?? new List<DocGroup>())
                    .Where(g => g is not null && Keep(g.VisibleWhen, map, live))
                    .Select(g => Grp(g, map, live, groupSelections, texts, apiOptions)).ToList(),
                Signatures = (p.Signatures ?? new List<DocSignature>())
                    .Where(x => x is not null && Keep(x.VisibleWhen, map, live))
                    .Select(x => new DocSignature
                    {
                        Key = x.Key, Label = Apply(x.Label, map), Required = x.Required,
                        Width = x.Width, Height = x.Height, Align = x.Align,
                        Ord = x.Ord, VisibleWhen = LiveCondition(x.VisibleWhen, map, live)
                    }).ToList(),
                Scans = (p.Scans ?? new List<DocScan>())
                    .Where(x => x is not null && Keep(x.VisibleWhen, map, live))
                    .Select(x => new DocScan
                    {
                        Key = x.Key, Label = Apply(x.Label, map), Required = x.Required,
                        Ord = x.Ord, VisibleWhen = LiveCondition(x.VisibleWhen, map, live)
                    }).ToList(),
                Inputs = (p.Inputs ?? new List<DocInput>())
                    .Where(x => x is not null && Keep(x.VisibleWhen, map, live))
                    .Select(x => new DocInput
                    {
                        Key = x.Key, Label = Apply(x.Label, map), Type = x.Type,
                        Placeholder = x.Placeholder, Required = x.Required,
                        // Значение можно прислать тегом с тем же именем: тогда поле приходит к
                        // клиенту уже заполненным, и он его только проверяет или правит.
                        Value = map is not null && !string.IsNullOrWhiteSpace(x.Key)
                                && map.TryGetValue(x.Key.Trim(), out var v) ? v : x.Value,
                        Ord = x.Ord, VisibleWhen = LiveCondition(x.VisibleWhen, map, live)
                    }).ToList(),
                CheckRules = (p.CheckRules ?? new List<CheckRule>())
                    .Where(r => r is not null && r.Keys is { Count: > 0 })
                    .Select(r => new CheckRule { Kind = r.Kind, Keys = new List<string>(r.Keys), N = r.N })
                    .ToList(),
                ShowCheckAll = p.ShowCheckAll
            };
            // Экран подписи или сканирования без своего поля показывать нечего: поле могло не
            // подойти по условию, и тогда экран уходит вместе с ним, а не встаёт пустым.
            var kind = (resolved.Kind ?? "").Trim().ToLowerInvariant();
            if (kind == "signature" && resolved.Signatures.Count == 0) continue;
            if (kind == "scan" && resolved.Scans.Count == 0) continue;
            // Пункты могли отсеяться по тегам: правила отметок должны говорить о тех, что
            // остались, иначе клиент упрётся в требование про несуществующий пункт.
            ПочиститьПравила(resolved);
            pages.Add(resolved);
        }

        if (hasDynamic)
        {
            var injected = dynamicCheckboxes!.Where(c => c is not null).Select(c => Cb(c, map, live, checkboxStates, texts)).ToList();
            var anchor = pages.FirstOrDefault(p => p.IncludeDynamic) ?? pages.LastOrDefault();
            if (anchor != null)
            {
                // Место присланного по API чекбокса в шаблоне не задано, поэтому он встаёт в конец
                // страницы-якоря, следом за всем, что оператор расставил сам.
                var next = PageOrdinalEnd(anchor);
                foreach (var c in injected) c.Ord = next++;
                anchor.Checkboxes.AddRange(injected);
                // Страница, где клиент что-то подтверждает, из PDF исключаться не может. При
                // сохранении это проверяется, но пунктов из заказа тогда ещё нет: страница без
                // своих полей законно сохранена с «не печатать», а теперь на ней стоит согласие.
                // В бумаге оставался один список «Отмеченные пункты» без заголовка и без текста,
                // под которым человек расписался.
                if (injected.Count > 0) anchor.InPdf = true;
            }
            else
            {
                for (var i = 0; i < injected.Count; i++) injected[i].Ord = i;
                pages.Add(new DocPage { Checkboxes = injected });
            }
        }

        return new DocumentConfig
        {
            // Вид документа едет с ним: планшет по нему решает, показывать ли экран подписи.
            Kind = doc.Kind,
            Title = Apply(doc.Title, map),
            SignPrompt = Apply(doc.SignPrompt, map),
            SignBlocks = ResolveBlocks(doc.SignBlocks ?? new List<DocBlock>(), map, live, images),
            SignBlocksBelow = ResolveBlocks(doc.SignBlocksBelow ?? new List<DocBlock>(), map, live, images),
            ThankYouText = Apply(doc.ThankYouText, map),
            ThankYouRuns = LabelRuns(doc.ThankYouRuns, doc.ThankYouText)
                .Where(r => r is not null).Select(r => ApplyRun(r, map)).ToList(),
            ThankYouAlign = doc.ThankYouAlign,
            ThankYouBlocks = ResolveBlocks(doc.ThankYouBlocks ?? new List<DocBlock>(), map, live, images),
            ThankYouSec = doc.ThankYouSec,
            IdleReturnSec = doc.IdleReturnSec,
            PdfFontScale = doc.PdfFontScale,
            PdfSignatureScale = doc.PdfSignatureScale,
            // Колонтитул тоже настройка документа, а не подставляемое значение, но в снимок он
            // не попадал, а PDF собирается именно из снимка. Из-за этого номер страницы, название
            // документа, номер записи и штрихкод не печатались никогда: настройка в редакторе
            // сохранялась, а до бумаги не доходила.
            PdfPageNumbers = doc.PdfPageNumbers,
            PdfFooterTitle = doc.PdfFooterTitle,
            PdfFooterRecordId = doc.PdfFooterRecordId,
            PdfFooterBarcode = doc.PdfFooterBarcode,
            // Раскладка подписей от подставленных значений не зависит, но донести её до PDF надо:
            // иначе размещённая подпись напечаталась бы ещё раз в потоке текста.
            SignaturePlacements = doc.SignaturePlacements ?? new List<SignaturePlacement>(),
            Pages = pages
        };
    }

    /// <summary>
    /// Убрать то, что клиент в итоге не видел: условия на состояние чекбокса считаются на планшете
    /// по ходу заполнения, и здесь применяется то же правило по финальным отметкам. Чекбокс внутри
    /// скрытого блока считается неотмеченным, поэтому взаимные ссылки между блоками разрешаются
    /// сами и не могут зациклиться.
    /// </summary>
    /// <summary>
    /// Проставить в разобранный документ то, что клиент в итоге отметил: галочки по имени и
    /// выбор в группах. Нужно снимку сессии: он сделан при показе, до всех отметок, а запись и
    /// PDF должны показывать документ таким, каким его подписали.
    /// </summary>
    public static void ApplyMarks(DocumentConfig doc,
        IReadOnlyDictionary<string, bool> checkboxStates, IReadOnlyDictionary<string, string> groupSelections)
    {
        foreach (var p in doc.Pages ?? new List<DocPage>())
        {
            if (p is null) continue;
            foreach (var c in p.Checkboxes ?? new List<DocCheckbox>())
            {
                if (c is null || string.IsNullOrWhiteSpace(c.Key)) continue;
                if (checkboxStates.TryGetValue(c.Key.Trim(), out var isChecked)) c.Checked = isChecked;
            }
            foreach (var g in p.Groups ?? new List<DocGroup>())
            {
                if (g is null || string.IsNullOrWhiteSpace(g.Key)) continue;
                if (groupSelections.TryGetValue(g.Key.Trim(), out var sel))
                    g.Selected = string.IsNullOrWhiteSpace(sel) ? null : sel;
            }
        }
    }

    /// <summary>
    /// Первый обязательный, но не заполненный элемент видимого документа: имя того, чего не
    /// хватает, или null, когда всё на месте. Проверяет сервер, а не только страница планшета:
    /// страница может быть сломана или подделана, а запись о согласии без самого согласия
    /// выглядит подлинной и потому хуже, чем отказ.
    /// </summary>
    public static string? MissingRequired(DocumentConfig doc,
        IReadOnlyCollection<string> signatureKeys, IReadOnlyCollection<string> scanKeys)
    {
        static bool Has(IReadOnlyCollection<string> keys, string? key) =>
            !string.IsNullOrWhiteSpace(key) && keys.Any(k => string.Equals(k, key.Trim(), StringComparison.OrdinalIgnoreCase));

        foreach (var p in doc.Pages ?? new List<DocPage>())
        {
            if (p is null) continue;
            // Безымянный пункт проверить нельзя: отметки приходят по имени, и сопоставить их с
            // ним нечем. Такие бывают в документах, сохранённых до автоимён, и отказывать всему
            // документу из-за них значило бы остановить подписание на ровном месте. Страница
            // планшета их по-прежнему требует, а галочка в PDF берётся из записи по совпадению.
            foreach (var c in p.Checkboxes ?? new List<DocCheckbox>())
                if (c is { Required: true, Checked: false } && !string.IsNullOrWhiteSpace(c.Key))
                    return "пункт «" + (PlainOf(c.LabelRuns, c.Label) ?? "") + "»";
            foreach (var g in p.Groups ?? new List<DocGroup>())
                if (g is { Required: true } && !string.IsNullOrWhiteSpace(g.Key) && string.IsNullOrWhiteSpace(g.Selected))
                    return "выбор «" + (PlainOf(g.TitleRuns, g.Title) ?? "") + "»";
            foreach (var x in p.Signatures ?? new List<DocSignature>())
                if (x is { Required: true } && !Has(signatureKeys, x.Key))
                    return "подпись «" + (x.Label ?? x.Key) + "»";
            foreach (var x in p.Scans ?? new List<DocScan>())
                if (x is { Required: true } && !Has(scanKeys, x.Key))
                    return "сканирование «" + (x.Label ?? x.Key) + "»";
        }
        return null;
    }

    /// <summary>
    /// Первое нарушенное правило отметок или пустое обязательное поле ввода видимого документа.
    /// Проверяет сервер: страница планшета делает то же самое, но полагаться на одну её нельзя.
    /// </summary>
    public static string? BrokenRuleOrInput(DocumentConfig doc,
        IReadOnlyDictionary<string, bool> checks, IReadOnlyDictionary<string, string> inputs)
    {
        foreach (var p in doc.Pages ?? new List<DocPage>())
        {
            if (p is null) continue;
            foreach (var inp in p.Inputs ?? new List<DocInput>())
            {
                if (inp is null || string.IsNullOrWhiteSpace(inp.Key)) continue;
                inputs.TryGetValue(inp.Key.Trim(), out var v);
                v = (v ?? inp.Value ?? "").Trim();
                if (inp.Required && v.Length == 0)
                    return "поле «" + (string.IsNullOrWhiteSpace(inp.Label) ? inp.Key : inp.Label) + "» не заполнено";
                if (v.Length > 0 && BadInputValue(inp.Type, v) is { } почему)
                    return "поле «" + (string.IsNullOrWhiteSpace(inp.Label) ? inp.Key : inp.Label) + "»: " + почему;
            }
            foreach (var rule in p.CheckRules ?? new List<CheckRule>())
            {
                if (rule is null || rule.Keys is not { Count: > 1 }) continue;
                var сколько = rule.Keys.Count(k => checks.TryGetValue(k.Trim(), out var on) && on);
                if (rule.Kind == "minchecked" && сколько < rule.N)
                    return "нужно отметить не меньше " + rule.N + " из перечисленных пунктов";
                if (rule.Kind == "exclusive" && сколько > 1)
                    return "из взаимоисключающих пунктов отмечен может быть только один";
            }
        }
        return null;
    }

    /// <summary>Почему значение не подходит виду поля, или null. Разбор нестрогий, как у дат.</summary>
    public static string? BadInputValue(string? type, string value) => (type ?? "").Trim().ToLowerInvariant() switch
    {
        "number" => decimal.TryParse(value.Replace(',', '.'), System.Globalization.NumberStyles.Float,
            System.Globalization.CultureInfo.InvariantCulture, out _) ? null : "это не число",
        "date" => ParseDate(value) is null ? "это не дата, подойдёт 01.01.1990 или 1990-01-01" : null,
        // У телефона считаются только цифры: скобки, дефисы и пробелы это оформление.
        "phone" => value.Count(char.IsDigit) is >= 5 and <= 15 ? null : "это не похоже на номер телефона",
        _ => null
    };

    /// <param name="inputValues">
    /// Вписанное клиентом. На планшете значение поля живёт в условиях наравне с отметкой: условие
    /// «телефон не пусто» открывает блок прямо во время набора. Без этих значений блок, который
    /// человек своими руками открыл, пропадал из записи и из PDF.
    /// </param>
    /// <summary>
    /// Привести правила отметок страницы в соответствие с тем, что на ней осталось. Пункт мог
    /// не подойти по тегу или по условию и уйти из документа, а правило продолжало на него
    /// ссылаться: планшет считал отметки по видимым пунктам, сервер по присланным, и получалось
    /// «не меньше двух из двух», где второго уже нет. Клиент проходил документ и получал отказ
    /// на самой подписи.
    /// </summary>
    private static void ПочиститьПравила(DocPage p)
    {
        var живые = (p.Checkboxes ?? new List<DocCheckbox>())
            .Where(c => c is not null && !string.IsNullOrWhiteSpace(c.Key))
            .Select(c => c.Key.Trim())
            .ToHashSet(StringComparer.OrdinalIgnoreCase);
        var правила = new List<CheckRule>();
        foreach (var r in p.CheckRules ?? new List<CheckRule>())
        {
            if (r is null || r.Keys is null) continue;
            r.Keys = r.Keys.Where(k => !string.IsNullOrWhiteSpace(k) && живые.Contains(k.Trim())).ToList();
            // Правило про один пункт бессмысленно: взаимоисключать не с чем, а «не меньше N»
            // превращается в обычное «обязательный пункт».
            if (r.Keys.Count < 2) continue;
            // Требовать отметок больше, чем есть пунктов, значит запретить подписание навсегда.
            if (r.Kind == "minchecked") r.N = Math.Clamp(r.N <= 0 ? 1 : r.N, 1, r.Keys.Count);
            правила.Add(r);
        }

        // Взаимоисключающие пункты, каждый из которых обязателен, это документ, который нельзя
        // пройти вовсе: обязательность требует отметить оба, правило запрещает отметить оба.
        // Оператор почти наверняка имел в виду «выбрать ровно один», тем более что обязательность
        // у нового пункта включена по умолчанию. Так и делаем: снимаем личную обязательность и
        // добавляем правило «не меньше одного» на тот же перечень.
        foreach (var r in правила.Where(x => x.Kind == "exclusive").ToList())
        {
            var обязательные = (p.Checkboxes ?? new List<DocCheckbox>())
                .Where(c => c is { Required: true } && !string.IsNullOrWhiteSpace(c.Key)
                            && r.Keys.Any(k => string.Equals(k, c.Key.Trim(), StringComparison.OrdinalIgnoreCase)))
                .ToList();
            if (обязательные.Count < 2) continue;
            foreach (var c in обязательные) c.Required = false;
            var естьМинимум = правила.Any(x => x.Kind == "minchecked"
                && x.Keys.Count == r.Keys.Count
                && !x.Keys.Except(r.Keys, StringComparer.OrdinalIgnoreCase).Any());
            if (!естьМинимум) правила.Add(new CheckRule { Kind = "minchecked", Keys = new List<string>(r.Keys), N = 1 });
        }
        p.CheckRules = правила;
    }

    /// <param name="signedKeys">
    /// Имена полей подписи, в которых клиент действительно расписался. Имя поля живёт в условиях
    /// наравне с отметкой: «покажите это, когда клиент расписался». Без этих значений условие на
    /// имя поля подписи не выполнялось никогда, а обратное держалось всегда.
    /// </param>
    /// <param name="scannedCodes">Имена полей сканирования и считанные в них коды, по той же причине.</param>
    public static void ApplyLiveConditions(DocumentConfig doc,
        IReadOnlyDictionary<string, bool> checkboxStates, IReadOnlyDictionary<string, string> groupSelections,
        IReadOnlyDictionary<string, string>? inputValues = null,
        IReadOnlyCollection<string>? signedKeys = null,
        IReadOnlyDictionary<string, string>? scannedCodes = null)
    {
        var values = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var kv in checkboxStates) values[kv.Key] = kv.Value ? "true" : "false";
        foreach (var kv in groupSelections) values[kv.Key] = kv.Value ?? "";
        foreach (var kv in inputValues ?? new Dictionary<string, string>()) values[kv.Key] = kv.Value ?? "";
        // Порядок тот же, что на планшете: отметки, выбор, вписанное, подписи, коды.
        foreach (var k in signedKeys ?? Array.Empty<string>())
            if (!string.IsNullOrWhiteSpace(k)) values[k.Trim()] = "подписано";
        foreach (var kv in scannedCodes ?? new Dictionary<string, string>())
            if (!string.IsNullOrWhiteSpace(kv.Key)) values[kv.Key.Trim()] = kv.Value ?? "";

        var pages = new List<DocPage>();
        foreach (var p in doc.Pages ?? new List<DocPage>())
        {
            if (p is null || !Matches(p.VisibleWhen, values, своиИмена: true)) continue;
            p.VisibleWhen = null;
            p.Blocks = (p.Blocks ?? new List<DocBlock>())
                .Where(b => b is not null && Matches(b.VisibleWhen, values, своиИмена: true)).ToList();
            foreach (var b in p.Blocks) b.VisibleWhen = null;
            p.Checkboxes = (p.Checkboxes ?? new List<DocCheckbox>())
                .Where(c => c is not null && Matches(c.VisibleWhen, values, своиИмена: true)).ToList();
            foreach (var c in p.Checkboxes) c.VisibleWhen = null;
            p.Groups = (p.Groups ?? new List<DocGroup>())
                .Where(g => g is not null && Matches(g.VisibleWhen, values, своиИмена: true)).ToList();
            foreach (var g in p.Groups) g.VisibleWhen = null;
            p.Signatures = (p.Signatures ?? new List<DocSignature>())
                .Where(x => x is not null && Matches(x.VisibleWhen, values, своиИмена: true)).ToList();
            foreach (var x in p.Signatures) x.VisibleWhen = null;
            p.Scans = (p.Scans ?? new List<DocScan>())
                .Where(x => x is not null && Matches(x.VisibleWhen, values, своиИмена: true)).ToList();
            foreach (var x in p.Scans) x.VisibleWhen = null;
            // Поля ввода фильтруются наравне со всем прочим. Без этого скрытое условием поле
            // оставалось в снимке: обязательное делало документ неподписываемым навсегда (клиент
            // его не видел и не мог заполнить), а необязательное с предзаполнением печаталось в
            // PDF, хотя на экране его не было.
            p.Inputs = (p.Inputs ?? new List<DocInput>())
                .Where(x => x is not null && Matches(x.VisibleWhen, values, своиИмена: true)).ToList();
            foreach (var x in p.Inputs) x.VisibleWhen = null;
            ПочиститьПравила(p);
            pages.Add(p);
        }
        doc.Pages = pages;

        doc.SignBlocks = (doc.SignBlocks ?? new List<DocBlock>()).Where(b => b is not null && Matches(b.VisibleWhen, values, своиИмена: true)).ToList();
        foreach (var b in doc.SignBlocks) b.VisibleWhen = null;
        doc.SignBlocksBelow = (doc.SignBlocksBelow ?? new List<DocBlock>()).Where(b => b is not null && Matches(b.VisibleWhen, values, своиИмена: true)).ToList();
        foreach (var b in doc.SignBlocksBelow) b.VisibleWhen = null;
    }

    /// <summary>Every checkbox and group name in the document, in one set.</summary>
    public static HashSet<string> LiveKeys(DocumentConfig doc)
    {
        var keys = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var p in doc.Pages ?? new List<DocPage>())
        {
            if (p is null) continue;
            foreach (var c in p.Checkboxes ?? new List<DocCheckbox>())
                if (c is not null && !string.IsNullOrWhiteSpace(c.Key)) keys.Add(c.Key.Trim());
            foreach (var g in p.Groups ?? new List<DocGroup>())
                if (g is not null && !string.IsNullOrWhiteSpace(g.Key)) keys.Add(g.Key.Trim());
            foreach (var x in p.Signatures ?? new List<DocSignature>())
                if (x is not null && !string.IsNullOrWhiteSpace(x.Key)) keys.Add(x.Key.Trim());
            foreach (var x in p.Scans ?? new List<DocScan>())
                if (x is not null && !string.IsNullOrWhiteSpace(x.Key)) keys.Add(x.Key.Trim());
            // Поле ввода тоже живое: его значение появляется, пока клиент печатает, и условие на
            // него может вычислить только планшет.
            foreach (var x in p.Inputs ?? new List<DocInput>())
                if (x is not null && !string.IsNullOrWhiteSpace(x.Key)) keys.Add(x.Key.Trim());
        }
        return keys;
    }

    /// <summary>True when this part of a condition is about something the signer controls on the tablet.</summary>
    private static bool IsLive(VisibleWhen? cond, HashSet<string> live)
    {
        if (cond is null || string.IsNullOrWhiteSpace(cond.Field)) return false;
        // Счёт отметок всегда вычисляет планшет: перечисленные имена нажимают там. Момент
        // показа наоборот всегда решается здесь: у планшета могут быть свои, сбитые часы.
        if (cond.Op == "minchecked") return true;
        if (IsClockOp(cond.Op)) return false;
        return live.Contains(cond.Field.Trim());
    }

    /// <summary>
    /// Оставить элемент: части про теги решаются здесь и должны выполниться все, а части про
    /// чекбоксы клиент ещё не нажимал, поэтому они откладываются на планшет. В составном условии
    /// части обоих видов могут стоять рядом: «Пол равно F и согласие отмечено».
    /// </summary>
    private static bool Keep(VisibleWhen? cond, IReadOnlyDictionary<string, string>? map, HashSet<string> live)
    {
        Split(cond, map, live, out var keep);
        return keep;
    }

    /// <summary>
    /// На планшет уезжают только те части, которые он ещё должен вычислить сам. Части про теги
    /// здесь уже решены, и отправлять их значит рассказывать планшету о данных, которых он не
    /// должен знать.
    /// </summary>
    private static VisibleWhen? LiveCondition(VisibleWhen? cond,
        IReadOnlyDictionary<string, string>? map, HashSet<string>? live)
        => Split(cond, map, live, out _);

    /// <summary>
    /// Разбор условия на две половины: что решается здесь, по присланным тегам, и что должен
    /// вычислить планшет, когда клиент отмечает пункты. С «или» это одно решение, а не два
    /// независимых: какие наборы доедут до планшета, зависит от того, какие уже провалились
    /// здесь. Возвращает остаток для планшета; keep равен false, когда показывать нечего.
    /// </summary>
    private static VisibleWhen? Split(VisibleWhen? cond, IReadOnlyDictionary<string, string>? map,
        HashSet<string>? live, out bool keep)
    {
        keep = true;
        if (cond is null || live is null) return null;
        var alive = new List<VisibleWhen>();
        foreach (var group in Groups(cond))
        {
            var deferred = new List<VisibleWhen>();
            var dead = false;
            foreach (var part in Parts(group))
            {
                if (IsLive(part, live))
                    deferred.Add(new VisibleWhen
                    {
                        // Поле не обрезается по краям как одно имя: у счёта отметок это перечень
                        // имён через запятую, и он уезжает как есть.
                        Field = part.Field.Trim(), Op = part.Op, Value = part.Value,
                        // Отрицание едет с частью: без него планшет вычислил бы её наоборот.
                        Not = part.Not
                    });
                else if (!MatchesOne(part, map)) { dead = true; break; }
            }
            if (dead) continue;
            // Набор выполнен целиком уже здесь: ждать планшета незачем, содержимое видно всегда,
            // и остальные наборы значения не имеют.
            if (deferred.Count == 0) return null;
            var head = deferred[0];
            if (deferred.Count > 1) head.And = deferred.Skip(1).ToList();
            alive.Add(head);
        }
        // Не выжил ни один набор: содержимое скрыто и на планшет не едет вовсе.
        if (alive.Count == 0) { keep = false; return null; }
        var first = alive[0];
        if (alive.Count > 1) first.Or = alive.Skip(1).ToList();
        return first;
    }

    /// <summary>Resolve a list of blocks: drop those whose condition fails, substitute text runs,
    /// pass images through unchanged.</summary>
    /// <summary>
    /// Подпись и сканирование можно поставить двумя способами: блоком внутри страницы, рядом с
    /// текстом, к которому они относятся, и отдельным экраном, где клиент занят только этим.
    /// Здесь приводится в порядок второй случай: у такого экрана ровно одно своё поле, чужих на
    /// нём нет, а экран без поля перестаёт быть экраном, иначе клиент увидел бы пустоту.
    /// Обычные страницы не трогаются: там полей может быть сколько угодно.
    /// </summary>
    private static void NormalizeScreens(DocumentConfig doc)
    {
        foreach (var p in doc.Pages)
        {
            var kind = (p.Kind ?? "").Trim().ToLowerInvariant();
            if (kind is not ("signature" or "scan"))
            {
                p.Kind = null;
                // Обычная страница проходит мимо приведения экранов, но правило «страницу, где
                // клиент что-то подтверждает, из PDF не исключить» относится и к ней. Раньше
                // проверка стояла ниже этого выхода, и документ, пришедший по API или через
                // импорт с inPdf:false на странице согласий, печатался без самих согласий.
                if (HasInteraction(p)) p.InPdf = true;
                NormalizeOrder(p);
                continue;
            }

            var sigs = p.Signatures ?? new List<DocSignature>();
            var scans = p.Scans ?? new List<DocScan>();
            if (kind == "signature")
            {
                p.Signatures = sigs.Count > 0 ? new List<DocSignature> { sigs[0] } : new List<DocSignature>();
                p.Scans = new List<DocScan>();
                p.Kind = p.Signatures.Count > 0 ? "signature" : null;
            }
            else
            {
                p.Scans = scans.Count > 0 ? new List<DocScan> { scans[0] } : new List<DocScan>();
                p.Signatures = new List<DocSignature>();
                p.Kind = p.Scans.Count > 0 ? "scan" : null;
            }
            // Присланные по API чекбоксы на такой экран не дописываются: там одно дело.
            // Присланные по API чекбоксы, выбор и поля ввода на такой экран не попадают: там одно
            // дело. Поля ввода тут раньше забыли, и переключение готовой страницы в «экран
            // подписи» оставляло их рядом с полем подписи, вопреки соседнему пояснению.
            if (p.Kind is not null)
            {
                p.Checkboxes = new List<DocCheckbox>();
                p.Groups = new List<DocGroup>();
                p.Inputs = new List<DocInput>();
                p.CheckRules = new List<CheckRule>();
                p.IncludeDynamic = false;
            }
            // Страницу, на которой клиент что-то подтверждает, из PDF исключить нельзя. Признак
            // не отвергается с ошибкой, а возвращается на место: оператор мог поставить его
            // раньше, а взаимодействие добавить потом, и терять из-за этого весь документ незачем.
            if (HasInteraction(p)) p.InPdf = true;

            NormalizeOrder(p);
        }
        if (doc.Pages.Count > MaxPages) doc.Pages = doc.Pages.Take(MaxPages).ToList();
    }

    /// <summary>
    /// Тексты, которые сейчас стоят в документе, по именам. Нужны внешней системе, когда она
    /// хочет не заменить формулировку, а дописать к ней: дописывать надо к тому, что есть.
    /// Ключ это имя чекбокса или группы, для варианта - «группа/вариант».
    /// </summary>
    public static Dictionary<string, string> CurrentTexts(DocumentConfig doc)
    {
        var map = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var p in doc.Pages ?? new List<DocPage>())
        {
            if (p is null) continue;
            foreach (var c in p.Checkboxes ?? new List<DocCheckbox>())
                if (c is not null && !string.IsNullOrEmpty(c.Key)) map[c.Key] = c.Label ?? "";
            foreach (var g in p.Groups ?? new List<DocGroup>())
            {
                if (g is null || string.IsNullOrEmpty(g.Key)) continue;
                map[g.Key] = g.Title ?? "";
                foreach (var o in g.Options ?? new List<DocGroupOption>())
                    if (o is not null && !string.IsNullOrEmpty(o.Key)) map[g.Key + "/" + o.Key] = o.Label ?? "";
            }
        }
        return map;
    }

    /// <summary>
    /// Оформленный текст пункта, варианта или заголовка группы. Когда оформления нет, из простого
    /// текста делается один кусок: тогда всё остальное работает одинаково и не приходится
    /// разбирать два случая в каждом месте, где этот текст рисуется.
    /// </summary>
    public static List<TextRun> LabelRuns(List<TextRun>? runs, string? plain)
    {
        if (runs is { Count: > 0 } && runs.Any(r => r is not null && !string.IsNullOrEmpty(r.Text))) return runs;
        return string.IsNullOrEmpty(plain) ? new List<TextRun>() : new List<TextRun> { new() { Text = plain } };
    }

    /// <summary>Простой текст из оформленного: по нему пункт узнают в записи, в API и в списке
    /// недостающего, и оформление там ни к чему.</summary>
    public static string PlainOf(List<TextRun>? runs, string? plain)
    {
        if (runs is not { Count: > 0 }) return plain ?? "";
        var sb = new System.Text.StringBuilder();
        foreach (var r in runs) if (r is not null) sb.Append(r.Text);
        var text = sb.ToString();
        return text.Length > 0 ? text : (plain ?? "");
    }

    /// <summary>Известные значения выравнивания. Всё прочее означает по левому краю.</summary>
    private static string? CleanAlign(string? align)
    {
        var a = (align ?? "").Trim().ToLowerInvariant();
        return a is "center" or "right" or "justify" ? a : null;
    }

    private static List<DocBlock> ResolveBlocks(IEnumerable<DocBlock> blocks,
        IReadOnlyDictionary<string, string>? map, HashSet<string> live,
        IReadOnlyDictionary<string, string>? images = null)
    {
        var result = new List<DocBlock>();
        foreach (var b in blocks)
        {
            if (b is null) continue;
            if (!Keep(b.VisibleWhen, map, live)) continue;

            // Картинка по тегу: на место блока встаёт то, что прислала внешняя система. Не
            // прислала - остаётся запасная, заданная оператором. Нет и её - блока не будет
            // вовсе: пустая рамка посреди документа выглядит поломкой.
            var tag = (b.ImageTag ?? "").Trim();
            var изАпи = tag.Length > 0 && images is not null && images.TryGetValue(tag, out var картинка)
                ? картинка : null;
            if (tag.Length > 0 && изАпи is null && string.IsNullOrEmpty(b.ImageUrl)) continue;
            result.Add(new DocBlock
            {
                Runs = (b.Runs ?? new List<TextRun>()).Where(r => r is not null).Select(r => ApplyRun(r, map)).ToList(),
                Align = b.Align,
                ImageUrl = изАпи ?? b.ImageUrl,
                // Имя тега на планшет не едет: картинка уже подставлена, а знать про теги ему
                // незачем.
                ImageWidth = b.ImageWidth,
                Wrap = b.Wrap,
                WrapGap = b.WrapGap,
                Kind = b.Kind,
                InPdf = b.InPdf,
                List = b.List,
                Bg = b.Bg,
                BorderColor = b.BorderColor,
                Pad = b.Pad,
                LineHeight = b.LineHeight,
                // Теги подставляются и в ячейки: таблица реквизитов с {{ФИО}} обычное дело.
                Table = b.Table is null ? null : new DocTable
                {
                    HeaderRow = b.Table.HeaderRow,
                    Widths = new List<int>(b.Table.Widths ?? new List<int>()),
                    Rows = (b.Table.Rows ?? new List<List<string>>())
                        .Select(r => (r ?? new List<string>()).Select(c => Apply(c, map) ?? "").ToList()).ToList()
                },
                VisibleWhen = LiveCondition(b.VisibleWhen, map, live),
                Ord = b.Ord
            });
        }
        return result;
    }

    /// <summary>Bounded on purpose: neither an operator nor an imported file can build a page out
    /// of hundreds of groups.</summary>
    private const int MaxGroups = 30;
    /// <summary>Сколько подписей и сканирований может быть на одной странице.</summary>
    private const int MaxPerKind = 20;
    /// <summary>
    /// Сколько экранов может быть в документе. Ограничение нужно, потому что подпись и
    /// сканирование теперь становятся отдельными экранами: документ с сотней полей иначе
    /// разросся бы до сотни экранов.
    /// </summary>
    private const int MaxPages = 200;
    private const int MaxGroupOptions = 20;
    public const int MaxKeyLength = 60;

    /// <summary>
    /// A checkbox or group name is what an integration writes in its own code, so it is kept to
    /// plain characters: no spaces, no braces that could be mistaken for a {{tag}}.
    /// </summary>
    public static string CleanKey(string? key)
    {
        var k = (key ?? "").Trim();
        if (k.Length == 0) return "";
        var kept = new string(k.Where(ch => char.IsLetterOrDigit(ch) || ch is '-' or '_' or '.').ToArray());
        return kept.Length > MaxKeyLength ? kept[..MaxKeyLength] : kept;
    }

    /// <summary>Keep a condition only if it names a field. A half-filled one would silently hide
    /// content, and there would be nothing on screen to explain why.</summary>
    private static VisibleWhen? Normalized(VisibleWhen? cond)
    {
        if (cond is null) return null;
        CleanCondition(cond);
        // Набор без единой заполненной части ничего не ограничивает, а в «или» такой набор делал
        // бы условие выполненным всегда. Пустые выбрасываются; не осталось ни одного, значит и
        // условия нет.
        // Наборы берутся списком сразу: перебор ленивый, и обнуление cond.Or внутри цикла
        // оборвало бы его же на первом шаге, молча потеряв все наборы после «или».
        var groups = new List<VisibleWhen>();
        foreach (var group in Groups(cond).ToList())
        {
            var parts = Parts(group).ToList();
            if (parts.Count == 0) continue;
            foreach (var part in parts)
            {
                part.Field = Clamp(part.Field).Trim();
                part.Value = Clamp(part.Value);
            }
            var head = parts[0];
            head.And = parts.Count > 1 ? parts.Skip(1).ToList() : null;
            head.Or = null;
            groups.Add(head);
        }
        if (groups.Count == 0) return null;
        var first = groups[0];
        first.Or = groups.Count > 1 ? groups.Skip(1).ToList() : null;
        return first;
    }

    // ---------- Sanitise on save ----------

    /// <summary>
    /// Clean a document coming from the admin editor before it is stored: keep only known size
    /// keywords and well-formed hex colours, and known condition operators. This canonicalises the
    /// content so both renderers can trust it, and stops malformed styling from ever being stored.
    /// </summary>
    /// <summary>Информационный ли это документ: показать и вернуть рекламу, без подписи.</summary>
    public static bool IsInfo(DocumentConfig? doc) =>
        string.Equals(doc?.Kind, "info", StringComparison.OrdinalIgnoreCase);

    /// <summary>
    /// Есть ли на странице что-то, что клиент подтверждает своими руками. Такую страницу нельзя
    /// исключить из PDF: в бумаге оказалась бы отметка без того, под чем она стоит. И на
    /// информационном документе такого быть не должно: подтверждать там нечем, следа не остаётся.
    /// </summary>
    public static bool HasInteraction(DocPage p) =>
        (p.Checkboxes?.Count ?? 0) > 0 || (p.Groups?.Count ?? 0) > 0 ||
        (p.Signatures?.Count ?? 0) > 0 || (p.Scans?.Count ?? 0) > 0 || (p.Inputs?.Count ?? 0) > 0;

    /// <summary>
    /// Почему документ нельзя сделать информационным, или null. Поле подписи и сканирование на
    /// таком документе бессмысленны: их результат некуда положить, записи не будет. Молча
    /// вычищать их нельзя, это потеря работы оператора без спроса, поэтому просто отказ с
    /// перечислением страниц.
    /// </summary>
    public static string? WhyNotInfo(DocumentConfig doc)
    {
        var мешают = new List<string>();
        var pages = doc.Pages ?? new List<DocPage>();
        for (var i = 0; i < pages.Count; i++)
        {
            var p = pages[i];
            if (p is null) continue;
            var что = new List<string>();
            if ((p.Signatures?.Count ?? 0) > 0) что.Add("поле подписи");
            if ((p.Scans?.Count ?? 0) > 0) что.Add("сканирование");
            // Обязательные пункты, выбор и поля на таком документе это обман: планшет честно не
            // пустит клиента дальше, пока он их не заполнит, а записи не будет вовсе. Человека
            // заставляют подтвердить то, что нигде не сохранится.
            if ((p.Checkboxes ?? new List<DocCheckbox>()).Any(c => c is { Required: true })) что.Add("обязательный пункт");
            if ((p.Groups ?? new List<DocGroup>()).Any(g => g is { Required: true })) что.Add("обязательный выбор");
            if ((p.Inputs ?? new List<DocInput>()).Any(x => x is { Required: true })) что.Add("обязательное поле");
            if (что.Count > 0) мешают.Add("страница " + (i + 1) + " (" + string.Join(", ", что) + ")");
        }
        if (мешают.Count == 0) return null;
        return "Информационный документ не подписывают и никуда не сохраняют, поэтому поля подписи, " +
               "сканирование и обязательные пункты на нём работать не будут: их результат некуда " +
               "положить, а клиента они дальше не пустят. Уберите их и повторите. Мешают: " +
               string.Join("; ", мешают) + ".";
    }

    /// <summary>
    /// Имя вида «sign1», «sign2»... первое, которое ещё никем не занято. Нужно там, где оператор
    /// имя не задал: молча взять «sign1» на каждой странице значило бы, что две разные подписи
    /// зовутся одинаково, и в записи вторая ложится поверх первой.
    /// </summary>
    private static string СвободноеИмя(string основа, HashSet<string> занятые)
    {
        for (var i = 1; i < 1000; i++)
        {
            var имя = основа + i;
            if (!занятые.Contains(имя)) return имя;
        }
        return основа + Guid.NewGuid().ToString("N")[..6];
    }

    public static void Sanitize(DocumentConfig doc)
    {
        // Вид документа: всё, кроме известного, это обычный подписной.
        doc.Kind = IsInfo(doc) ? "info" : null;
        СказатьПроСовпавшиеИмена(doc);
        // Anything may arrive here from an imported file or an API client, including nulls inside
        // lists. Strip them: a single null element used to be stored happily and then throw on
        // every later render, breaking signing for the whole fleet until someone edited the file.
        doc.Title = Clamp(doc.Title);
        doc.SignPrompt = Clamp(doc.SignPrompt);
        doc.ThankYouText = Clamp(doc.ThankYouText);
        doc.IdleReturnSec = Math.Clamp(doc.IdleReturnSec, 0, 3600);

        doc.Pages = Compact(doc.Pages);
        // Все имена документа в одном множестве: имя должно означать одно и то же во всём
        // документе, поэтому и придуманное автоматически не может совпасть с тем, что оператор
        // задал руками на другой странице.
        var занятые = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var p in doc.Pages)
        {
            foreach (var c in p.Checkboxes ?? new List<DocCheckbox>())
                if (c is not null) { var k = CleanKey(c.Key); if (k.Length > 0) занятые.Add(k); }
            foreach (var g in p.Groups ?? new List<DocGroup>())
                if (g is not null) { var k = CleanKey(g.Key); if (k.Length > 0) занятые.Add(k); }
            foreach (var x in p.Signatures ?? new List<DocSignature>())
                if (x is not null) { var k = CleanKey(x.Key); if (k.Length > 0) занятые.Add(k); }
            foreach (var x in p.Scans ?? new List<DocScan>())
                if (x is not null) { var k = CleanKey(x.Key); if (k.Length > 0) занятые.Add(k); }
            foreach (var x in p.Inputs ?? new List<DocInput>())
                if (x is not null) { var k = CleanKey(x.Key); if (k.Length > 0) занятые.Add(k); }
        }
        foreach (var p in doc.Pages)
        {
            CleanCondition(p.VisibleWhen);
            p.Heading = Clamp(p.Heading);
            p.Body = Clamp(p.Body);
            p.HeadingRuns = Compact(p.HeadingRuns);
            foreach (var r in p.HeadingRuns) CleanRun(r);
            p.Blocks = Compact(p.Blocks);
            foreach (var b in p.Blocks) CleanBlock(b);
            p.Checkboxes = Compact(p.Checkboxes);
            foreach (var c in p.Checkboxes)
            {
                // Оформленный текст чистится теми же правилами, что абзац, а простой держится с
                // ним в согласии: по простому пункт узнают в записи подписи, в API и в списке
                // недостающего, и расходиться им нельзя.
                c.LabelRuns = CleanRuns(c.LabelRuns);
                if (c.LabelRuns.Count > 0) c.Label = Clamp(PlainOf(c.LabelRuns, c.Label));
                else c.Label = Clamp(c.Label);
                c.Key = CleanKey(c.Key);
                c.VisibleWhen = Normalized(c.VisibleWhen);
            }
            p.Groups = Compact(p.Groups);
            foreach (var g in p.Groups)
            {
                g.Key = CleanKey(g.Key);
                g.TitleRuns = CleanRuns(g.TitleRuns);
                g.Title = g.TitleRuns.Count > 0 ? Clamp(PlainOf(g.TitleRuns, g.Title)) : Clamp(g.Title);
                g.VisibleWhen = Normalized(g.VisibleWhen);
                g.Options = Compact(g.Options);
                foreach (var o in g.Options)
                {
                    o.Key = CleanKey(o.Key);
                    o.LabelRuns = CleanRuns(o.LabelRuns);
                    o.Label = o.LabelRuns.Count > 0 ? Clamp(PlainOf(o.LabelRuns, o.Label)) : Clamp(o.Label);
                }
                // An option nobody can name is unusable from the API and indistinguishable from
                // its neighbours in a stored record, so it is dropped rather than kept half-broken.
                g.Options = g.Options.Where(o => o.Key.Length > 0).ToList();
                if (g.Options.Count > MaxGroupOptions) g.Options = g.Options.Take(MaxGroupOptions).ToList();
                var sel = (g.Selected ?? "").Trim();
                g.Selected = g.Options.Any(o => string.Equals(o.Key, sel, StringComparison.OrdinalIgnoreCase)) ? sel : null;
            }
            // Группа без имени неадресуема по API, а с одним вариантом не даёт выбора: хранить
            // такую нечего. Оператору о ней сообщает проверка документа в редакторе.
            p.Groups = p.Groups.Where(g => g.Key.Length > 0 && g.Options.Count >= 2).ToList();
            if (p.Groups.Count > MaxGroups) p.Groups = p.Groups.Take(MaxGroups).ToList();

            // Подписи и сканирования внутри страницы. Имя нужно, чтобы отличить их друг от друга
            // в записи подписи и в PDF; если оператор его не задал, оно подставляется по номеру.
            // Номер сквозной по всему документу и не повторяет уже занятые имена: счёт в пределах
            // страницы давал «sign1» на каждой, и в записи две подписи сливались в один файл.
            p.Signatures = Compact(p.Signatures);
            for (var i = 0; i < p.Signatures.Count; i++)
            {
                var sig = p.Signatures[i];
                sig.Key = CleanKey(sig.Key);
                if (sig.Key.Length == 0) sig.Key = СвободноеИмя("sign", занятые);
                занятые.Add(sig.Key);
                sig.Label = Clamp(sig.Label);
                // Размер места под подпись: уже десятой части страницы расписаться негде, а выше
                // трёхсот точек оно занимает лист целиком и выталкивает текст на новую страницу.
                // Уже шестидесяти точек расписаться негде, а шире листа место всё равно не
                // поместится: ширина текста на A4 это 495 точек.
                sig.Width = Math.Clamp(sig.Width <= 0 ? 280 : sig.Width, 60, 495);
                sig.Height = Math.Clamp(sig.Height <= 0 ? 100 : sig.Height, 40, 300);
                sig.Align = CleanAlign(sig.Align);
                sig.VisibleWhen = Normalized(sig.VisibleWhen);
            }
            if (p.Signatures.Count > MaxPerKind) p.Signatures = p.Signatures.Take(MaxPerKind).ToList();

            p.Scans = Compact(p.Scans);
            for (var i = 0; i < p.Scans.Count; i++)
            {
                var sc = p.Scans[i];
                sc.Key = CleanKey(sc.Key);
                if (sc.Key.Length == 0) sc.Key = СвободноеИмя("scan", занятые);
                занятые.Add(sc.Key);
                sc.Label = Clamp(sc.Label);
                sc.VisibleWhen = Normalized(sc.VisibleWhen);
            }
            if (p.Scans.Count > MaxPerKind) p.Scans = p.Scans.Take(MaxPerKind).ToList();

            // Поля ввода: имя обязательно по той же причине, что у подписей. Вид значения только
            // из известного списка, всё прочее это текст.
            p.Inputs = Compact(p.Inputs);
            for (var i = 0; i < p.Inputs.Count; i++)
            {
                var inp = p.Inputs[i];
                inp.Key = CleanKey(inp.Key);
                // Имя сквозное по всему документу и не повторяет занятые: счёт в пределах
                // страницы давал «input1» на каждой, а значения полей на планшете живут по имени,
                // и второе поле само подхватывало вписанное в первое.
                if (inp.Key.Length == 0) inp.Key = СвободноеИмя("input", занятые);
                занятые.Add(inp.Key);
                inp.Label = Clamp(inp.Label);
                inp.Placeholder = Clamp(inp.Placeholder);
                inp.Value = Clamp(inp.Value);
                var t = (inp.Type ?? "").Trim().ToLowerInvariant();
                inp.Type = t is "number" or "date" or "phone" ? t : "text";
                inp.VisibleWhen = Normalized(inp.VisibleWhen);
            }
            if (p.Inputs.Count > MaxPerKind) p.Inputs = p.Inputs.Take(MaxPerKind).ToList();

            // Правила отметок: только известные виды, только существующие на этой странице имена
            // и хотя бы два имени, иначе правилу не над чем работать.
            var pageKeys = new HashSet<string>(
                (p.Checkboxes ?? new List<DocCheckbox>()).Where(c => c is not null && c.Key.Length > 0).Select(c => c.Key.Trim()),
                StringComparer.OrdinalIgnoreCase);
            p.CheckRules = (p.CheckRules ?? new List<CheckRule>()).Where(r => r is not null).Select(r =>
            {
                var kind = (r.Kind ?? "").Trim().ToLowerInvariant();
                return new CheckRule
                {
                    Kind = kind is "minchecked" ? "minchecked" : "exclusive",
                    Keys = (r.Keys ?? new List<string>()).Select(CleanKey)
                        .Where(k => k.Length > 0 && pageKeys.Contains(k)).Distinct(StringComparer.OrdinalIgnoreCase).ToList(),
                    N = Math.Clamp(r.N <= 0 ? 1 : r.N, 1, 50)
                };
            }).Where(r => r.Keys.Count >= 2).Take(10).ToList();
            if (p.CheckRules.Count == 0) p.CheckRules = new List<CheckRule>();
            // Правила приводятся к тому же виду, что и при показе: пара взаимоисключающих
            // пунктов, каждый из которых обязателен, превращается в «выбрать ровно один».
            // Иначе документ был бы непроходим, а оператор об этом не узнал бы.
            var былиОбязательные = (p.Checkboxes ?? new List<DocCheckbox>()).Count(c => c is { Required: true });
            ПочиститьПравила(p);
            var сталиОбязательные = (p.Checkboxes ?? new List<DocCheckbox>()).Count(c => c is { Required: true });
            if (сталиОбязательные < былиОбязательные)
                Срезано("взаимоисключающие пункты, каждый из которых обязателен, пройти нельзя: правило приведено к «выбрать ровно один»");

            NormalizeOrder(p);
        }

        NormalizeScreens(doc);

        // Раскладка подписей: координаты в долях листа, поэтому держим их в границах, а ссылки
        // на несуществующие поля выбрасываем, иначе подпись «повиснет» на пустом месте.
        var known = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { "" };
        foreach (var p2 in doc.Pages)
            foreach (var sg in p2.Signatures ?? new List<DocSignature>())
                if (!string.IsNullOrWhiteSpace(sg.Key)) known.Add(sg.Key.Trim());
        // Одна подпись это одно место на листе: два прямоугольника для одного поля означали бы,
        // что одна и та же подпись напечатана дважды, и понять, какая из них настоящая, нельзя.
        doc.SignaturePlacements = Compact(doc.SignaturePlacements)
            .Where(x => known.Contains((x.Key ?? "").Trim()))
            .GroupBy(x => (x.Key ?? "").Trim(), StringComparer.OrdinalIgnoreCase)
            .Select(g => g.First())
            .Take(60).ToList();
        foreach (var pl in doc.SignaturePlacements)
        {
            pl.Key = (pl.Key ?? "").Trim();
            pl.Page = Math.Clamp(pl.Page, 0, 200);
            pl.W = Math.Clamp(pl.W <= 0 ? 0.35 : pl.W, 0.05, 1);
            pl.H = Math.Clamp(pl.H <= 0 ? 0.08 : pl.H, 0.02, 1);
            pl.X = Math.Clamp(pl.X, 0, 1 - pl.W);
            pl.Y = Math.Clamp(pl.Y, 0, 1 - pl.H);
        }

        // Дописывание текста имеет смысл только в запросе по API: в самом документе его быть не
        // должно, иначе сохранённый шаблон начал бы дописывать сам к себе при каждом показе.
        foreach (var p4 in doc.Pages)
        {
            foreach (var c in p4.Checkboxes ?? new List<DocCheckbox>()) if (c is not null) c.LabelAppend = null;
            foreach (var g in p4.Groups ?? new List<DocGroup>())
                foreach (var o in g?.Options ?? new List<DocGroupOption>()) if (o is not null) o.LabelAppend = null;
        }

        // Выравнивание: только четыре известных значения. Чужое слово, попавшее из импорта или
        // из внешнего редактора, молча становится выравниванием по левому краю.
        foreach (var p3 in doc.Pages)
        {
            p3.HeadingAlign = CleanAlign(p3.HeadingAlign);
            foreach (var b in Blocks(p3)) b.Align = CleanAlign(b.Align);
        }
        foreach (var b in (doc.SignBlocks ?? new List<DocBlock>()).Concat(doc.SignBlocksBelow ?? new List<DocBlock>()))
            if (b is not null) b.Align = CleanAlign(b.Align);

        // Размер шрифта в PDF: меньше половины делает документ нечитаемым, больше исходного не
        // имеет смысла, потому что 100 это и есть размер, заданный в конструкторе.
        doc.PdfFontScale = Math.Clamp(doc.PdfFontScale <= 0 ? 100 : doc.PdfFontScale, 50, 100);
        // Место под подпись: меньше сорока процентов от неё останется росчерк в марку величиной.
        doc.PdfSignatureScale = Math.Clamp(doc.PdfSignatureScale <= 0 ? 100 : doc.PdfSignatureScale, 40, 100);
        // Экран благодарности: меньше двух секунд человек не успевает прочитать, больше минуты
        // планшет впустую занят и следующий клиент ждёт у выключенного на вид экрана.
        doc.ThankYouSec = Math.Clamp(doc.ThankYouSec <= 0 ? 6 : doc.ThankYouSec, 2, 60);
        doc.ThankYouRuns = CleanRuns(doc.ThankYouRuns);
        if (doc.ThankYouRuns.Count > 0) doc.ThankYouText = Clamp(PlainOf(doc.ThankYouRuns, doc.ThankYouText));
        doc.ThankYouAlign = CleanAlign(doc.ThankYouAlign);
        doc.ThankYouBlocks = Compact(doc.ThankYouBlocks);
        foreach (var b in doc.ThankYouBlocks) { CleanBlock(b); b.Align = CleanAlign(b.Align); }

        doc.SignBlocks = Compact(doc.SignBlocks);
        foreach (var b in doc.SignBlocks) CleanBlock(b);
        doc.SignBlocksBelow = Compact(doc.SignBlocksBelow);
        foreach (var b in doc.SignBlocksBelow) CleanBlock(b);
    }

    /// <summary>
    /// Элементы страницы в том порядке, в каком их видит клиент: блоки текста, чекбоксы и группы
    /// стоят вперемешку. Возвращает пары (вид, номер в своём списке): 0 - блок, 1 - чекбокс,
    /// 2 - группа. Страница без номеров (сохранённая до появления свободного порядка) отдаётся
    /// по прежнему правилу: сначала текст, потом чекбоксы, потом группы.
    /// </summary>
    public static List<(int Kind, int Index)> PageOrder(DocPage page, List<DocBlock>? blocks = null)
    {
        const int tail = 1_000_000;
        var list = blocks ?? page.Blocks ?? new List<DocBlock>();
        var items = new List<(int Key, int Kind, int Index)>();
        for (var i = 0; i < list.Count; i++)
            items.Add((list[i].Ord >= 0 ? list[i].Ord : tail + i, 0, i));
        var checks = page.Checkboxes ?? new List<DocCheckbox>();
        for (var i = 0; i < checks.Count; i++)
            items.Add((checks[i].Ord >= 0 ? checks[i].Ord : 2 * tail + i, 1, i));
        var groups = page.Groups ?? new List<DocGroup>();
        for (var i = 0; i < groups.Count; i++)
            items.Add((groups[i].Ord >= 0 ? groups[i].Ord : 3 * tail + i, 2, i));
        var signs = page.Signatures ?? new List<DocSignature>();
        for (var i = 0; i < signs.Count; i++)
            items.Add((signs[i].Ord >= 0 ? signs[i].Ord : 4 * tail + i, 3, i));
        var scans = page.Scans ?? new List<DocScan>();
        for (var i = 0; i < scans.Count; i++)
            items.Add((scans[i].Ord >= 0 ? scans[i].Ord : 5 * tail + i, 4, i));
        var inputs = page.Inputs ?? new List<DocInput>();
        for (var i = 0; i < inputs.Count; i++)
            items.Add((inputs[i].Ord >= 0 ? inputs[i].Ord : 6 * tail + i, 5, i));

        return items.OrderBy(x => x.Key).ThenBy(x => x.Kind).ThenBy(x => x.Index)
            .Select(x => (x.Kind, x.Index)).ToList();
    }

    /// <summary>Номер, следующий за последним занятым на странице.</summary>
    private static int PageOrdinalEnd(DocPage p)
    {
        var max = -1;
        foreach (var b in p.Blocks) if (b.Ord > max) max = b.Ord;
        foreach (var c in p.Checkboxes) if (c.Ord > max) max = c.Ord;
        foreach (var g in p.Groups) if (g.Ord > max) max = g.Ord;
        foreach (var x in p.Signatures) if (x.Ord > max) max = x.Ord;
        foreach (var x in p.Scans) if (x.Ord > max) max = x.Ord;
        foreach (var x in p.Inputs) if (x.Ord > max) max = x.Ord;
        return max + 1;
    }

    /// <summary>
    /// Привести порядок элементов страницы к сквозной нумерации 0..N-1. Блоки текста, чекбоксы и
    /// группы стоят на странице вперемешку, в том порядке, в котором их расставил оператор, поэтому
    /// номер общий для всех трёх видов. Документ, сохранённый до появления свободного порядка,
    /// номеров не имеет: ему они проставляются по прежнему правилу (сначала текст, потом чекбоксы,
    /// потом группы), и внешне он не меняется.
    /// </summary>
    private static void NormalizeOrder(DocPage p)
    {
        var items = new List<(int Ord, int Kind, int Index, Action<int> Set)>();
        for (var i = 0; i < p.Blocks.Count; i++)
        {
            var b = p.Blocks[i];
            items.Add((b.Ord, 0, i, v => b.Ord = v));
        }
        for (var i = 0; i < p.Checkboxes.Count; i++)
        {
            var c = p.Checkboxes[i];
            items.Add((c.Ord, 1, i, v => c.Ord = v));
        }
        for (var i = 0; i < p.Groups.Count; i++)
        {
            var g = p.Groups[i];
            items.Add((g.Ord, 2, i, v => g.Ord = v));
        }
        for (var i = 0; i < p.Signatures.Count; i++)
        {
            var sg = p.Signatures[i];
            items.Add((sg.Ord, 3, i, v => sg.Ord = v));
        }
        for (var i = 0; i < p.Scans.Count; i++)
        {
            var sc = p.Scans[i];
            items.Add((sc.Ord, 4, i, v => sc.Ord = v));
        }
        for (var i = 0; i < p.Inputs.Count; i++)
        {
            var inp = p.Inputs[i];
            items.Add((inp.Ord, 5, i, v => inp.Ord = v));
        }
        if (items.Count == 0) return;

        // Элемент без номера встаёт туда, где он оказался бы в старом документе: в конец своего
        // вида. Так добавленный извне чекбокс не оказывается вдруг посреди текста.
        var maxOrd = items.Count;
        var ordered = items
            .Select(x => (Key: x.Ord >= 0 ? x.Ord : maxOrd + x.Kind * maxOrd + x.Index, x.Kind, x.Index, x.Set))
            .OrderBy(x => x.Key).ThenBy(x => x.Kind).ThenBy(x => x.Index)
            .ToList();
        for (var i = 0; i < ordered.Count; i++) ordered[i].Set(i);

        // Хранение приводится к тому же порядку, в каком элементы стоят на странице. Иначе один
        // и тот же документ, пришедший по API и собранный в редакторе, лежит в разном порядке:
        // на экране разницы нет, номер решает всё, но сравнить два таких документа между собой
        // уже нельзя, и любая сверка выдаёт расхождения на ровном месте.
        p.Blocks = p.Blocks.OrderBy(x => x.Ord).ToList();
        p.Checkboxes = p.Checkboxes.OrderBy(x => x.Ord).ToList();
        p.Groups = p.Groups.OrderBy(x => x.Ord).ToList();
        p.Signatures = p.Signatures.OrderBy(x => x.Ord).ToList();
        p.Scans = p.Scans.OrderBy(x => x.Ord).ToList();
        p.Inputs = p.Inputs.OrderBy(x => x.Ord).ToList();
    }

    /// <summary>A non-null list without null elements.</summary>
    private static List<T> Compact<T>(List<T>? list) where T : class =>
        list is null ? new List<T>() : list.Where(x => x is not null).ToList();

    private static string Clamp(string? s) =>
        string.IsNullOrEmpty(s) ? "" : (s.Length <= MaxTextLength ? s : s[..MaxTextLength]);

    private static void CleanBlock(DocBlock b)
    {
        CleanCondition(b.VisibleWhen);
        b.Runs = Compact(b.Runs);
        foreach (var r in b.Runs) CleanRun(r);
        b.ImageUrl = CleanImageUrl(b.ImageUrl);
        // Блок с тегом это тоже картинка, даже когда своей у него нет: её пришлёт внешняя
        // система. Иначе ширина и обтекание у такого блока сбрасывались бы при каждом
        // сохранении, и оператор не мог бы задать их вовсе.
        var картинка = b.ImageUrl is not null || b.ImageTag is not null;
        b.ImageWidth = картинка ? Math.Clamp(b.ImageWidth <= 0 ? 100 : b.ImageWidth, 10, 100) : 100;
        // Обтекание только у картинки и только двумя сторонами: текст «вокруг со всех сторон»
        // выглядит красиво лишь на широкой колонке, а на планшете превращается в узкие обрывки.
        var wrap = (b.Wrap ?? "").Trim().ToLowerInvariant();
        b.Wrap = картинка && wrap is "left" or "right" ? wrap : null;
        // Картинка во всю ширину обтекать не может: текста рядом с ней не поместится.
        if (b.Wrap is not null && b.ImageWidth > 70) b.ImageWidth = 70;
        b.WrapGap = Math.Clamp(b.WrapGap < 0 ? 10 : b.WrapGap, 0, 60);

        // Имя тега картинки живёт по тем же правилам, что и обычный тег в тексте: его пишет
        // оператор, а присылает внешняя система, и косая черта с точками там не нужна.
        b.ImageTag = string.IsNullOrWhiteSpace(b.ImageTag) ? null : Clamp(b.ImageTag).Trim();
        if (b.ImageTag is { Length: 0 }) b.ImageTag = null;

        var kind = (b.Kind ?? "").Trim().ToLowerInvariant();
        b.Kind = kind is "divider" or "pagebreak" ? kind : null;
        var list = (b.List ?? "").Trim().ToLowerInvariant();
        b.List = list is "bullet" or "number" ? list : null;
        b.Bg = NormalizeColor(b.Bg);
        b.BorderColor = NormalizeColor(b.BorderColor);
        b.Pad = Math.Clamp(b.Pad < 0 ? 0 : b.Pad, 0, 40);
        b.LineHeight = b.LineHeight <= 0 ? 0 : Math.Clamp(b.LineHeight, 100, 250);
        // Плашка и рамка живут только у текста: у картинки они рисовали бы пустую коробку, а у
        // разделителя и разрыва страницы оформлять нечего.
        if (картинка || b.Kind is not null) { b.Bg = null; b.BorderColor = null; b.Pad = 0; }

        if (b.Table is not null)
        {
            // Таблица ограничена разумным листом: больше сорока строк и восьми столбцов не
            // читается ни на планшете, ни на бумаге, а импортированный файл не должен уметь
            // принести таблицу на тысячу строк.
            var rows = (b.Table.Rows ?? new List<List<string>>())
                .Where(r => r is not null).Take(40)
                .Select(r => r.Select(c => Clamp(c) ?? "").ToList()).ToList();
            var cols = rows.Count == 0 ? 0 : Math.Min(rows.Max(r => r.Count), 8);
            if (cols == 0 || rows.All(r => r.All(string.IsNullOrWhiteSpace)))
            {
                b.Table = null;
            }
            else
            {
                foreach (var r in rows)
                {
                    while (r.Count < cols) r.Add("");
                    if (r.Count > cols) r.RemoveRange(cols, r.Count - cols);
                }
                var widths = (b.Table.Widths ?? new List<int>()).Take(cols)
                    .Select(w2 => Math.Clamp(w2, 5, 90)).ToList();
                // Ширины либо заданы все и в сумме близки к ста, либо не заданы вовсе: половина
                // заданных ширин означала бы догадки, которые на планшете и в PDF разошлись бы.
                if (widths.Count != cols || Math.Abs(widths.Sum() - 100) > 5) widths = new List<int>();
                b.Table = new DocTable { HeaderRow = b.Table.HeaderRow, Rows = rows, Widths = widths };
            }
        }
        // Блок с таблицей не несёт ни текста, ни картинки: две сущности в одном элементе
        // означали бы, что порядок их отрисовки решается молча.
        if (b.Table is not null) { b.Runs = new List<TextRun>(); b.ImageUrl = null; b.ImageTag = null; b.List = null; }
    }

    /// <summary>
    /// Оформленный текст подписи: пустые куски выбрасываются, остальные чистятся. Текст без
    /// всякого оформления не хранится кусками вовсе: он и так лежит рядом простой строкой, а
    /// два вида хранения для одного и того же означали бы, что документ, пришедший по API, и
    /// тот же документ, сохранённый из редактора, перестают совпадать.
    /// </summary>
    private static List<TextRun> CleanRuns(List<TextRun>? runs)
    {
        var list = Compact(runs);
        foreach (var r in list) CleanRun(r);
        list = list.Where(r => !string.IsNullOrEmpty(r.Text)).Take(MaxRunsPerLabel).ToList();
        // Куски без оформления не хранятся: обычный текст подписи и так лежит в Label, а лишний
        // список только раздувал бы файл. Оформлением считается всё, что видно глазом, включая
        // выделение маркером и свой размер в точках: раньше их тут не было, и подпись, где
        // задано только выделение или только размер, теряла его при каждом сохранении.
        var оформлено = list.Any(r => r.Bold || r.Italic
            || !string.IsNullOrEmpty(r.Color) || !string.IsNullOrEmpty(r.Size)
            || !string.IsNullOrEmpty(r.Mark) || r.SizePt > 0);
        return оформлено ? list : new List<TextRun>();
    }

    /// <summary>Сколько кусков оформления может быть в одной подписи. Больше это не документ, а
    /// набор из сотен однобуквенных кусков после чужой вставки.</summary>
    private const int MaxRunsPerLabel = 60;

    private static void CleanRun(TextRun r)
    {
        r.Text = Clamp(r.Text);
        if (r.Size != null && !AllowedSizes.Contains(r.Size)) r.Size = null;
        r.Color = NormalizeColor(r.Color);
        r.Mark = NormalizeColor(r.Mark);
        // Свой размер в точках. Границы те же, что у PDF: мельче восьми не читается, крупнее
        // сорока не помещается в строку планшета.
        r.SizePt = r.SizePt <= 0 ? 0 : Math.Clamp(r.SizePt, 8, 40);
    }

    /// <summary>
    /// Image formats that can be embedded in the signed PDF. GIF and WEBP render fine on the tablet
    /// but PDFsharp cannot decode them, so a document block using one would be visible to the signer
    /// and missing from the archived PDF: the record would no longer match what was signed.
    /// </summary>
    private static readonly string[] PdfSafeImageExtensions = { ".png", ".jpg", ".jpeg", ".bmp" };

    public static bool IsPdfRenderableImage(string? url)
    {
        var clean = CleanImageUrl(url);
        if (clean is null) return false;
        var ext = Path.GetExtension(clean).ToLowerInvariant();
        return PdfSafeImageExtensions.Contains(ext);
    }

    /// <summary>Image files in the document that could not be embedded in a PDF (empty when fine).</summary>
    public static List<string> UnsupportedImages(DocumentConfig doc)
    {
        var bad = new List<string>();
        void Check(IEnumerable<DocBlock>? blocks)
        {
            foreach (var b in blocks ?? new List<DocBlock>())
                if (b is not null && !string.IsNullOrEmpty(b.ImageUrl) && !IsPdfRenderableImage(b.ImageUrl))
                    bad.Add(b.ImageUrl!);
        }
        foreach (var p in doc.Pages ?? new List<DocPage>()) if (p is not null) Check(p.Blocks);
        Check(doc.SignBlocks);
        Check(doc.SignBlocksBelow);
        return bad.Distinct().ToList();
    }

    /// <summary>Accept only a "/media/{filename}" reference to an uploaded image; reject anything
    /// with a path separator or traversal so a block can never point outside the image store.</summary>
    /// <summary>Приставка картинки, присланной внешней системой прямо в запросе.</summary>
    public const string DataImagePrefix = "data:image/";

    /// <summary>Картинка ли это, присланная внешней системой строкой BASE64.</summary>
    public static bool IsApiImage(string? url) =>
        url is not null && url.StartsWith(DataImagePrefix, StringComparison.Ordinal);

    public static string? CleanImageUrl(string? url)
    {
        if (string.IsNullOrWhiteSpace(url)) return null;
        var u = url.Trim();
        // Картинка из запроса уже проверена при приёме: разобрана, опознана по своим первым
        // байтам и ограничена по размеру. Здесь её пропускаем как есть.
        if (IsApiImage(u)) return u;
        const string prefix = "/media/";
        if (!u.StartsWith(prefix, StringComparison.Ordinal)) return null;
        var name = u[prefix.Length..];
        if (name.Length == 0 || name.Contains('/') || name.Contains('\\') || name.Contains("..")) return null;
        return prefix + name;
    }

    /// <summary>Сколько условий можно соединить через «и». Больше оператору не нужно, а без
    /// границы импортированный файл мог бы принести список любой длины.</summary>
    private const int MaxAndParts = 5;

    /// <summary>Сколько наборов можно соединить через «или». Та же граница и по той же причине,
    /// что и у «и»: без неё импортированный файл принёс бы список любой длины.</summary>
    private const int MaxOrGroups = 5;

    private static void CleanCondition(VisibleWhen? c)
    {
        if (c is null) return;
        CleanGroup(c);
        var alts = new List<VisibleWhen>();
        foreach (var alt in c.Or ?? new List<VisibleWhen>())
        {
            if (alt is null) continue;
            CleanGroup(alt);
            // Вложенности нет: «или» плоское. Иначе внутри набора оказался бы ещё один список
            // наборов, а редактор такое дерево показать не умеет.
            if (alt.Or is { Count: > 0 })
                Опасно("вложенное «или» внутри набора условий на «" + (alt.Field ?? "") + "»");
            alt.Or = null;
            if ((alt.Field ?? "").Length > 0) alts.Add(alt);
            if (alts.Count >= MaxOrGroups)
            {
                Опасно("наборов в «или» больше " + MaxOrGroups);
                break;
            }
        }
        c.Or = alts.Count > 0 ? alts : null;
        // Условие без первого набора, но с остальными: первый из оставшихся становится основным,
        // иначе пустой набор делал бы условие выполненным всегда.
        if (c.Field.Length == 0 && c.Or is { Count: > 0 })
        {
            var head = c.Or[0];
            c.Field = head.Field; c.Op = head.Op; c.Value = head.Value; c.And = head.And;
            c.Or = c.Or.Count > 1 ? c.Or.Skip(1).ToList() : null;
        }
    }

    /// <summary>Привести в порядок один набор: его собственную часть и присоединённые через «и».</summary>
    /// <summary>
    /// Что было выброшено при последнем разборе документа. Условия, вложенные глубже одного
    /// уровня, редактор показать не умеет, и они снимаются. Само снятие намеренное, плохо было
    /// молчание: из «А и (Б и В)» оставалось «А и Б», условие расширялось, и содержимое
    /// показывалось там, где его прятали, а ответ на сохранение был обычным «ок».
    /// </summary>
    [ThreadStatic] private static List<string>? _срезано;
    [ThreadStatic] private static List<string>? _опасно;

    /// <summary>Собрать список того, что Sanitize выбросил из документа. Пусто означает «всё сохранено».</summary>
    public static List<string> SanitizeWarnings(DocumentConfig doc)
    {
        _срезано = new List<string>();
        try { Sanitize(doc); return _срезано; }
        finally { _срезано = null; }
    }

    /// <summary>
    /// Почему документ нельзя сохранить как есть. Речь только о том, что молча меняет его смысл:
    /// условие, вложенное глубже, чем разбор умеет хранить, при сохранении срезается, и из
    /// «А и (Б и В)» остаётся «А и Б». Условие становится шире задуманного, и содержимое
    /// показывается там, где его прятали. Отказать честнее, чем сохранить не то, что задал
    /// оператор. Сам документ не трогается: проверка идёт по копии.
    /// </summary>
    public static string? WhyNotSavable(DocumentConfig doc)
    {
        DocumentConfig? копия;
        try { копия = JsonSerializer.Deserialize<DocumentConfig>(JsonSerializer.Serialize(doc)); }
        catch { return null; }   // не разобрали копию: это не повод отказывать в сохранении
        if (копия is null) return null;
        _опасно = new List<string>();
        try
        {
            Sanitize(копия);
            if (_опасно.Count == 0) return null;
            return "Условие сложнее, чем документ умеет хранить, и при сохранении оно изменилось бы само: "
                   + "содержимое показалось бы там, где вы его прятали. Упростите условие. Мешает: "
                   + string.Join("; ", _опасно) + ".";
        }
        finally { _опасно = null; }
    }

    /// <summary>То, из-за чего сохранять нельзя вовсе: смысл документа изменился бы молча.</summary>
    private static void Опасно(string что)
    {
        if (_опасно is null || _опасно.Count >= 10) return;
        if (!_опасно.Contains(что)) _опасно.Add(что);
    }

    /// <summary>
    /// Имя элемента документа, совпавшее с именем тега заказа, молча забирает условие себе:
    /// решать его будет отметка или подпись, а не то, что прислала внешняя система. Оператор
    /// написал условие про заказ и получил условие про галочку, и узнать об этом было неоткуда.
    /// </summary>
    private static void СказатьПроСовпавшиеИмена(DocumentConfig doc)
    {
        if (_срезано is null) return;
        var теги = new HashSet<string>(KnownFields, StringComparer.OrdinalIgnoreCase);
        void Проверить(string? имя, string что)
        {
            var k = (имя ?? "").Trim();
            if (k.Length > 0 && теги.Contains(k))
                Срезано("имя «" + k + "» у элемента «" + что + "» совпадает с тегом API: условие на это имя будет решать элемент документа, а не присланное значение");
        }
        foreach (var p in doc.Pages ?? new List<DocPage>())
        {
            if (p is null) continue;
            foreach (var c in p.Checkboxes ?? new List<DocCheckbox>()) Проверить(c?.Key, "пункт");
            foreach (var g in p.Groups ?? new List<DocGroup>()) Проверить(g?.Key, "выбор");
            foreach (var x in p.Inputs ?? new List<DocInput>()) Проверить(x?.Key, "поле ввода");
            foreach (var x in p.Signatures ?? new List<DocSignature>()) Проверить(x?.Key, "поле подписи");
            foreach (var x in p.Scans ?? new List<DocScan>()) Проверить(x?.Key, "поле сканирования");
        }
    }

    private static void Срезано(string что)
    {
        if (_срезано is null || _срезано.Count >= 20) return;
        if (!_срезано.Contains(что)) _срезано.Add(что);
    }

    private static void CleanGroup(VisibleWhen c)
    {
        CleanOnePart(c);
        if (c.And is null) return;
        var extras = new List<VisibleWhen>();
        foreach (var part in c.And)
        {
            if (part is null) continue;
            CleanOnePart(part);
            // Вложенности нет: «и» плоское, и разрешать её значило бы хранить дерево, которое
            // редактор всё равно не умеет показать. «Или» внутри присоединённой части снимается
            // по той же причине: иначе набор наборов протащили бы внутрь набора.
            if (part.And is { Count: > 0 })
                Опасно("вложенное «и» внутри условия на «" + (part.Field ?? "") + "»");
            if (part.Or is { Count: > 0 })
                Опасно("вложенное «или» внутри условия на «" + (part.Field ?? "") + "»");
            part.And = null;
            part.Or = null;
            if ((part.Field ?? "").Length > 0) extras.Add(part);
            if (extras.Count >= MaxAndParts)
            {
                Опасно("частей в «и» больше " + MaxAndParts);
                break;
            }
        }
        c.And = extras.Count > 0 ? extras : null;
        // Условие без первой части, но с присоединёнными: первая из них становится основной,
        // иначе всё условие считалось бы пустым и содержимое показывалось бы всегда.
        if (c.Field.Length == 0 && c.And is { Count: > 0 })
        {
            var head = c.And[0];
            c.Field = head.Field; c.Op = head.Op; c.Value = head.Value;
            c.And = c.And.Count > 1 ? c.And.Skip(1).ToList() : null;
        }
    }

    private static void CleanOnePart(VisibleWhen c)
    {
        c.Field = (c.Field ?? "").Trim();
        c.Value = (c.Value ?? "").Trim();
        if (string.IsNullOrEmpty(c.Op) || !AllowedOps.Contains(c.Op)) c.Op = "eq";
        // Момент показа не зависит от тегов: поле всегда служебное, что бы ни пришло из
        // редактора или из импортированного файла.
        if (IsClockOp(c.Op)) c.Field = TodayField;
        // Окно условия по сроку записывается как «7» или «14/3». Приводим к одному виду, чтобы
        // редактор и сервер читали одно и то же, а мусор вроде «14 / abc» не сохранялся.
        if (IsDaysOp(c.Op))
        {
            var w = ParseWindow(c.Value);
            c.Value = w is null ? "" : (w.Value.Before == w.Value.After
                ? w.Value.Before.ToString()
                : w.Value.Before + "/" + w.Value.After);
        }
    }

    /// <summary>Accept #rgb or #rrggbb (returned normalised as #rrggbb lower-case); anything else becomes null.</summary>
    public static string? NormalizeColor(string? color)
    {
        if (string.IsNullOrWhiteSpace(color)) return null;
        var c = color.Trim();
        if (c.Length == 4 && c[0] == '#' && IsHex(c[1]) && IsHex(c[2]) && IsHex(c[3]))
            return ("#" + c[1] + c[1] + c[2] + c[2] + c[3] + c[3]).ToLowerInvariant();
        if (c.Length == 7 && c[0] == '#' && c.Skip(1).All(IsHex))
            return c.ToLowerInvariant();
        return null;
    }

    private static bool IsHex(char ch) => ch is (>= '0' and <= '9') or (>= 'a' and <= 'f') or (>= 'A' and <= 'F');

    // ---------- Placeholder discovery ----------

    /// <summary>All distinct {{placeholder}} keys used anywhere in the document, in first-seen order.</summary>
    public static List<string> Placeholders(DocumentConfig doc)
    {
        var seen = new List<string>();
        var known = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        void Scan(string? text)
        {
            if (string.IsNullOrEmpty(text)) return;
            foreach (Match m in TagRegex().Matches(text))
            {
                var key = m.Groups[1].Value.Trim();
                if (key.Length > 0 && known.Add(key)) seen.Add(key);
            }
        }
        Scan(doc.Title); Scan(doc.SignPrompt); Scan(doc.ThankYouText);
        foreach (var p in doc.Pages ?? new List<DocPage>())
        {
            if (p is null) continue;
            foreach (var r in HeadingRuns(p)) { if (r is not null) Scan(r.Text); }
            foreach (var b in Blocks(p))
            {
                if (b is null) continue;
                foreach (var r in b.Runs ?? new List<TextRun>()) { if (r is not null) Scan(r.Text); }
                // Ячейки таблицы тоже подставляются, значит и теги в них надо видеть. Без этого
                // тег из таблицы не попадал ни в предупреждение «не прислали значение», ни в
                // список использованных полей: в документе он подставлен, а в разделе «Данные
                // подписанта» его нет.
                foreach (var row in b.Table?.Rows ?? new List<List<string>>())
                    foreach (var cell in row ?? new List<string>()) Scan(cell);
            }
            foreach (var c in p.Checkboxes ?? new List<DocCheckbox>()) { if (c is not null) Scan(c.Label); }
            foreach (var g in p.Groups ?? new List<DocGroup>())
            {
                if (g is null) continue;
                Scan(g.Title);
                foreach (var o in g.Options ?? new List<DocGroupOption>()) { if (o is not null) Scan(o.Label); }
            }
            foreach (var x in p.Signatures ?? new List<DocSignature>()) { if (x is not null) Scan(x.Label); }
            foreach (var x in p.Scans ?? new List<DocScan>()) { if (x is not null) Scan(x.Label); }
            foreach (var x in p.Inputs ?? new List<DocInput>()) { if (x is not null) Scan(x.Label); }
        }
        foreach (var b in (doc.SignBlocks ?? new List<DocBlock>()).Concat(doc.SignBlocksBelow ?? new List<DocBlock>()))
        {
            if (b is null) continue;
            foreach (var r in b.Runs ?? new List<TextRun>()) { if (r is not null) Scan(r.Text); }
        }
        return seen;
    }

    /// <summary>Placeholders present in the document but not provided in fields.</summary>
    /// <summary>
    /// Имена, которые документ действительно использует: теги в тексте плюс поля, на которые
    /// ссылаются условия показа. Нужно, чтобы в подписанный документ не попало то, чего человек
    /// не видел: внешняя система вправе прислать и свои служебные поля, но подписывают не их.
    /// </summary>
    public static HashSet<string> UsedFields(DocumentConfig doc)
    {
        var used = new HashSet<string>(Placeholders(doc), StringComparer.OrdinalIgnoreCase);
        void Add(VisibleWhen? cond)
        {
            // Обойти надо все наборы, а не только первый: тег, названный лишь в наборе после
            // «или», иначе не попал бы в список нужных, до планшета не доехал бы вовсе, и
            // условие никогда бы не выполнилось.
            foreach (var group in Groups(cond))
                foreach (var part in Parts(group))
                    used.Add(part.Field.Trim());
        }
        foreach (var p in doc.Pages ?? new List<DocPage>())
        {
            if (p is null) continue;
            Add(p.VisibleWhen);
            foreach (var b in p.Blocks ?? new List<DocBlock>()) Add(b?.VisibleWhen);
            foreach (var c in p.Checkboxes ?? new List<DocCheckbox>()) Add(c?.VisibleWhen);
            foreach (var g in p.Groups ?? new List<DocGroup>()) Add(g?.VisibleWhen);
            foreach (var x in p.Signatures ?? new List<DocSignature>()) Add(x?.VisibleWhen);
            foreach (var x in p.Scans ?? new List<DocScan>()) Add(x?.VisibleWhen);
            foreach (var x in p.Inputs ?? new List<DocInput>()) Add(x?.VisibleWhen);
        }
        foreach (var b in doc.SignBlocks ?? new List<DocBlock>()) Add(b?.VisibleWhen);
        foreach (var b in doc.SignBlocksBelow ?? new List<DocBlock>()) Add(b?.VisibleWhen);
        return used;
    }

    /// <summary>
    /// Проверить даты, от которых зависят условия по возрасту. Если документ спрашивает «младше
    /// 14», а прислали «вчера» или «01.13.1990», блок молча не покажется и никто не поймёт
    /// почему. Возвращает текст ошибки или null.
    /// </summary>
    public static string? ValidateAgeFields(DocumentConfig doc, IReadOnlyDictionary<string, string>? fields)
    {
        if (fields is null || fields.Count == 0) return null;
        var map = BuildMap(fields);
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var cond in AllConditions(doc))
            foreach (var part in Groups(cond).SelectMany(Parts))
            {
                var поВозрасту = IsAgeOp(part.Op);
                var поСроку = IsDaysOp(part.Op);
                if (!поВозрасту && !поСроку) continue;
                var field = part.Field.Trim();
                if (!seen.Add(field)) continue;
                if (map is null || !map.TryGetValue(field, out var raw) || string.IsNullOrWhiteSpace(raw)) continue;
                if (поВозрасту && AgeYears(raw) is null)
                    return "Тег «" + field + "» используется в условии по возрасту, но значение «" + raw +
                           "» не похоже на дату рождения. Подойдёт 01.01.1990 или 1990-01-01.";
                // Условие по сроку принимает и будущую дату: приём назначен на завтра, и это не
                // ошибка, поэтому проверяется только сам разбор.
                if (поСроку && ParseDate(raw) is null)
                    return "Тег «" + field + "» используется в условии по сроку, но значение «" + raw +
                           "» не похоже на дату. Подойдёт 01.01.1990 или 1990-01-01.";
            }
        return null;
    }

    /// <summary>Все условия документа, включая условия страниц, блоков, чекбоксов и групп.</summary>
    private static IEnumerable<VisibleWhen?> AllConditions(DocumentConfig doc)
    {
        foreach (var p in doc.Pages ?? new List<DocPage>())
        {
            if (p is null) continue;
            yield return p.VisibleWhen;
            foreach (var b in p.Blocks ?? new List<DocBlock>()) yield return b?.VisibleWhen;
            foreach (var c in p.Checkboxes ?? new List<DocCheckbox>()) yield return c?.VisibleWhen;
            foreach (var g in p.Groups ?? new List<DocGroup>()) yield return g?.VisibleWhen;
            foreach (var x in p.Signatures ?? new List<DocSignature>()) yield return x?.VisibleWhen;
            foreach (var x in p.Scans ?? new List<DocScan>()) yield return x?.VisibleWhen;
            // Условия полей ввода тут забыли, и битая дата в условии на поле молча гасила его,
            // не давая внешней системе ни одного объяснения.
            foreach (var x in p.Inputs ?? new List<DocInput>()) yield return x?.VisibleWhen;
        }
        foreach (var b in doc.SignBlocks ?? new List<DocBlock>()) yield return b?.VisibleWhen;
        foreach (var b in doc.SignBlocksBelow ?? new List<DocBlock>()) yield return b?.VisibleWhen;
    }

    public static List<string> Missing(DocumentConfig doc, IReadOnlyDictionary<string, string>? fields)
    {
        var provided = fields is null
            ? new HashSet<string>(StringComparer.OrdinalIgnoreCase)
            : new HashSet<string>(fields.Keys, StringComparer.OrdinalIgnoreCase);
        return Placeholders(doc).Where(k => !provided.Contains(k)).ToList();
    }
}
