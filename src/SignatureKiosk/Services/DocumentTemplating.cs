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
    private static readonly HashSet<string> AllowedOps = new(StringComparer.Ordinal) { "eq", "ne", "empty", "notempty", "in" };
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

    private static TextRun ApplyRun(TextRun r, IReadOnlyDictionary<string, string>? map) => new()
    {
        Text = Apply(r.Text, map),
        Bold = r.Bold,
        Italic = r.Italic,
        Color = r.Color,
        Size = r.Size
    };

    private static DocCheckbox Cb(DocCheckbox c, IReadOnlyDictionary<string, string>? map,
        HashSet<string>? live = null, IReadOnlyDictionary<string, bool>? states = null)
    {
        var key = (c.Key ?? "").Trim();
        var isChecked = c.Checked;
        if (key.Length > 0 && states is not null && states.TryGetValue(key, out var fromApi)) isChecked = fromApi;
        return new DocCheckbox
        {
            Key = key,
            Label = Apply(c.Label, map),
            Required = c.Required,
            Checked = isChecked,
            VisibleWhen = live is null ? null : LiveCondition(c.VisibleWhen, live),
            Ord = c.Ord
        };
    }

    /// <summary>Resolve one group: substitute its texts and apply a selection sent by the API.</summary>
    private static DocGroup Grp(DocGroup g, IReadOnlyDictionary<string, string>? map,
        HashSet<string> live, IReadOnlyDictionary<string, string>? selections)
    {
        var key = (g.Key ?? "").Trim();
        var options = (g.Options ?? new List<DocGroupOption>())
            .Where(o => o is not null)
            .Select(o => new DocGroupOption { Key = (o.Key ?? "").Trim(), Label = Apply(o.Label, map) })
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
            Title = Apply(g.Title, map),
            Options = options,
            Required = g.Required,
            Selected = selected.Length == 0 ? null : selected,
            VisibleWhen = LiveCondition(g.VisibleWhen, live),
            Ord = g.Ord
        };
    }

    // ---------- Conditions ----------

    /// <summary>Evaluate a block/page condition against the signer fields. A null condition is always true.</summary>
    public static bool Matches(VisibleWhen? cond, IReadOnlyDictionary<string, string>? fields)
    {
        if (cond is null || string.IsNullOrWhiteSpace(cond.Field)) return true;
        fields ??= EmptyMap;
        var field = cond.Field.Trim();
        fields.TryGetValue(field, out var raw);
        // Both sides go through the same normalisation, so a boolean tag sent as True matches a
        // condition written as true, and a condition saved before the tag became a boolean
        // (да / нет) keeps working instead of silently never matching.
        var val = FieldSchema.Canonical(field, raw);
        var target = FieldSchema.Canonical(field, cond.Value);
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
        IReadOnlyDictionary<string, bool>? checkboxStates = null)
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

            pages.Add(new DocPage
            {
                HeadingRuns = HeadingRuns(p).Where(r => r is not null).Select(r => ApplyRun(r, map)).ToList(),
                Blocks = ResolveBlocks(Blocks(p), map, live),
                IncludeDynamic = p.IncludeDynamic,
                VisibleWhen = LiveCondition(p.VisibleWhen, live),
                Checkboxes = (p.Checkboxes ?? new List<DocCheckbox>())
                    .Where(c => c is not null && Keep(c.VisibleWhen, map, live))
                    .Select(c => Cb(c, map, live, checkboxStates)).ToList(),
                Groups = (p.Groups ?? new List<DocGroup>())
                    .Where(g => g is not null && Keep(g.VisibleWhen, map, live))
                    .Select(g => Grp(g, map, live, groupSelections)).ToList()
            });
        }

        if (hasDynamic)
        {
            var injected = dynamicCheckboxes!.Where(c => c is not null).Select(c => Cb(c, map, live, checkboxStates)).ToList();
            var anchor = pages.FirstOrDefault(p => p.IncludeDynamic) ?? pages.LastOrDefault();
            if (anchor != null)
            {
                // Место присланного по API чекбокса в шаблоне не задано, поэтому он встаёт в конец
                // страницы-якоря, следом за всем, что оператор расставил сам.
                var next = PageOrdinalEnd(anchor);
                foreach (var c in injected) c.Ord = next++;
                anchor.Checkboxes.AddRange(injected);
            }
            else
            {
                for (var i = 0; i < injected.Count; i++) injected[i].Ord = i;
                pages.Add(new DocPage { Checkboxes = injected });
            }
        }

        return new DocumentConfig
        {
            Title = Apply(doc.Title, map),
            SignPrompt = Apply(doc.SignPrompt, map),
            SignBlocks = ResolveBlocks(doc.SignBlocks ?? new List<DocBlock>(), map, live),
            SignBlocksBelow = ResolveBlocks(doc.SignBlocksBelow ?? new List<DocBlock>(), map, live),
            ThankYouText = Apply(doc.ThankYouText, map),
            IdleReturnSec = doc.IdleReturnSec,
            Pages = pages
        };
    }

    /// <summary>
    /// Убрать то, что клиент в итоге не видел: условия на состояние чекбокса считаются на планшете
    /// по ходу заполнения, и здесь применяется то же правило по финальным отметкам. Чекбокс внутри
    /// скрытого блока считается неотмеченным, поэтому взаимные ссылки между блоками разрешаются
    /// сами и не могут зациклиться.
    /// </summary>
    public static void ApplyLiveConditions(DocumentConfig doc,
        IReadOnlyDictionary<string, bool> checkboxStates, IReadOnlyDictionary<string, string> groupSelections)
    {
        var values = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var kv in checkboxStates) values[kv.Key] = kv.Value ? "true" : "false";
        foreach (var kv in groupSelections) values[kv.Key] = kv.Value ?? "";

        var pages = new List<DocPage>();
        foreach (var p in doc.Pages ?? new List<DocPage>())
        {
            if (p is null || !Matches(p.VisibleWhen, values)) continue;
            p.VisibleWhen = null;
            p.Blocks = (p.Blocks ?? new List<DocBlock>())
                .Where(b => b is not null && Matches(b.VisibleWhen, values)).ToList();
            foreach (var b in p.Blocks) b.VisibleWhen = null;
            p.Checkboxes = (p.Checkboxes ?? new List<DocCheckbox>())
                .Where(c => c is not null && Matches(c.VisibleWhen, values)).ToList();
            foreach (var c in p.Checkboxes) c.VisibleWhen = null;
            p.Groups = (p.Groups ?? new List<DocGroup>())
                .Where(g => g is not null && Matches(g.VisibleWhen, values)).ToList();
            foreach (var g in p.Groups) g.VisibleWhen = null;
            pages.Add(p);
        }
        doc.Pages = pages;

        doc.SignBlocks = (doc.SignBlocks ?? new List<DocBlock>()).Where(b => b is not null && Matches(b.VisibleWhen, values)).ToList();
        foreach (var b in doc.SignBlocks) b.VisibleWhen = null;
        doc.SignBlocksBelow = (doc.SignBlocksBelow ?? new List<DocBlock>()).Where(b => b is not null && Matches(b.VisibleWhen, values)).ToList();
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
        }
        return keys;
    }

    /// <summary>True when this condition is about something the signer controls on the tablet.</summary>
    private static bool IsLive(VisibleWhen? cond, HashSet<string> live) =>
        cond is not null && !string.IsNullOrWhiteSpace(cond.Field) && live.Contains(cond.Field.Trim());

    /// <summary>Keep the element: either its condition holds now, or it will be decided on the tablet.</summary>
    private static bool Keep(VisibleWhen? cond, IReadOnlyDictionary<string, string>? map, HashSet<string> live) =>
        IsLive(cond, live) || Matches(cond, map);

    /// <summary>Only a condition the tablet still has to evaluate is passed on; a condition on a tag
    /// has already been settled here and must not travel with the content.</summary>
    private static VisibleWhen? LiveCondition(VisibleWhen? cond, HashSet<string> live) =>
        IsLive(cond, live) ? new VisibleWhen { Field = cond!.Field.Trim(), Op = cond.Op, Value = cond.Value } : null;

    /// <summary>Resolve a list of blocks: drop those whose condition fails, substitute text runs,
    /// pass images through unchanged.</summary>
    private static List<DocBlock> ResolveBlocks(IEnumerable<DocBlock> blocks,
        IReadOnlyDictionary<string, string>? map, HashSet<string> live)
    {
        var result = new List<DocBlock>();
        foreach (var b in blocks)
        {
            if (b is null) continue;
            if (!Keep(b.VisibleWhen, map, live)) continue;
            result.Add(new DocBlock
            {
                Runs = (b.Runs ?? new List<TextRun>()).Where(r => r is not null).Select(r => ApplyRun(r, map)).ToList(),
                ImageUrl = b.ImageUrl,
                ImageWidth = b.ImageWidth,
                VisibleWhen = LiveCondition(b.VisibleWhen, live),
                Ord = b.Ord
            });
        }
        return result;
    }

    /// <summary>Bounded on purpose: neither an operator nor an imported file can build a page out
    /// of hundreds of groups.</summary>
    private const int MaxGroups = 30;
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
        if (cond is null || string.IsNullOrWhiteSpace(cond.Field)) return null;
        CleanCondition(cond);
        cond.Field = Clamp(cond.Field).Trim();
        cond.Value = Clamp(cond.Value);
        return cond;
    }

    // ---------- Sanitise on save ----------

    /// <summary>
    /// Clean a document coming from the admin editor before it is stored: keep only known size
    /// keywords and well-formed hex colours, and known condition operators. This canonicalises the
    /// content so both renderers can trust it, and stops malformed styling from ever being stored.
    /// </summary>
    public static void Sanitize(DocumentConfig doc)
    {
        // Anything may arrive here from an imported file or an API client, including nulls inside
        // lists. Strip them: a single null element used to be stored happily and then throw on
        // every later render, breaking signing for the whole fleet until someone edited the file.
        doc.Title = Clamp(doc.Title);
        doc.SignPrompt = Clamp(doc.SignPrompt);
        doc.ThankYouText = Clamp(doc.ThankYouText);
        doc.IdleReturnSec = Math.Clamp(doc.IdleReturnSec, 0, 3600);

        doc.Pages = Compact(doc.Pages);
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
                c.Label = Clamp(c.Label);
                c.Key = CleanKey(c.Key);
                c.VisibleWhen = Normalized(c.VisibleWhen);
            }
            p.Groups = Compact(p.Groups);
            foreach (var g in p.Groups)
            {
                g.Key = CleanKey(g.Key);
                g.Title = Clamp(g.Title);
                g.VisibleWhen = Normalized(g.VisibleWhen);
                g.Options = Compact(g.Options);
                foreach (var o in g.Options) { o.Key = CleanKey(o.Key); o.Label = Clamp(o.Label); }
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

            NormalizeOrder(p);
        }

        doc.SignBlocks = Compact(doc.SignBlocks);
        foreach (var b in doc.SignBlocks) CleanBlock(b);
        doc.SignBlocksBelow = Compact(doc.SignBlocksBelow);
        foreach (var b in doc.SignBlocksBelow) CleanBlock(b);
    }

    /// <summary>Номер, следующий за последним занятым на странице.</summary>
    private static int PageOrdinalEnd(DocPage p)
    {
        var max = -1;
        foreach (var b in p.Blocks) if (b.Ord > max) max = b.Ord;
        foreach (var c in p.Checkboxes) if (c.Ord > max) max = c.Ord;
        foreach (var g in p.Groups) if (g.Ord > max) max = g.Ord;
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
        if (items.Count == 0) return;

        // Элемент без номера встаёт туда, где он оказался бы в старом документе: в конец своего
        // вида. Так добавленный извне чекбокс не оказывается вдруг посреди текста.
        var maxOrd = items.Count;
        var ordered = items
            .Select(x => (Key: x.Ord >= 0 ? x.Ord : maxOrd + x.Kind * maxOrd + x.Index, x.Kind, x.Index, x.Set))
            .OrderBy(x => x.Key).ThenBy(x => x.Kind).ThenBy(x => x.Index)
            .ToList();
        for (var i = 0; i < ordered.Count; i++) ordered[i].Set(i);
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
        b.ImageWidth = b.ImageUrl is null ? 100 : Math.Clamp(b.ImageWidth <= 0 ? 100 : b.ImageWidth, 10, 100);
    }

    private static void CleanRun(TextRun r)
    {
        r.Text = Clamp(r.Text);
        if (r.Size != null && !AllowedSizes.Contains(r.Size)) r.Size = null;
        r.Color = NormalizeColor(r.Color);
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
    public static string? CleanImageUrl(string? url)
    {
        if (string.IsNullOrWhiteSpace(url)) return null;
        var u = url.Trim();
        const string prefix = "/media/";
        if (!u.StartsWith(prefix, StringComparison.Ordinal)) return null;
        var name = u[prefix.Length..];
        if (name.Length == 0 || name.Contains('/') || name.Contains('\\') || name.Contains("..")) return null;
        return prefix + name;
    }

    private static void CleanCondition(VisibleWhen? c)
    {
        if (c is null) return;
        c.Field = (c.Field ?? "").Trim();
        c.Value = (c.Value ?? "").Trim();
        if (string.IsNullOrEmpty(c.Op) || !AllowedOps.Contains(c.Op)) c.Op = "eq";
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
            }
            foreach (var c in p.Checkboxes ?? new List<DocCheckbox>()) { if (c is not null) Scan(c.Label); }
            foreach (var g in p.Groups ?? new List<DocGroup>())
            {
                if (g is null) continue;
                Scan(g.Title);
                foreach (var o in g.Options ?? new List<DocGroupOption>()) { if (o is not null) Scan(o.Label); }
            }
        }
        foreach (var b in (doc.SignBlocks ?? new List<DocBlock>()).Concat(doc.SignBlocksBelow ?? new List<DocBlock>()))
        {
            if (b is null) continue;
            foreach (var r in b.Runs ?? new List<TextRun>()) { if (r is not null) Scan(r.Text); }
        }
        return seen;
    }

    /// <summary>Placeholders present in the document but not provided in fields.</summary>
    public static List<string> Missing(DocumentConfig doc, IReadOnlyDictionary<string, string>? fields)
    {
        var provided = fields is null
            ? new HashSet<string>(StringComparer.OrdinalIgnoreCase)
            : new HashSet<string>(fields.Keys, StringComparer.OrdinalIgnoreCase);
        return Placeholders(doc).Where(k => !provided.Contains(k)).ToList();
    }
}
