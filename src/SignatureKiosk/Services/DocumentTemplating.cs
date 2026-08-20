using System.Text.RegularExpressions;
using SignatureKiosk.Models;

namespace SignatureKiosk.Services;

/// <summary>
/// Fills a document template for one signer:
///   • substitutes {{placeholder}} tags (for example {{ФИО}}, {{ПОЛ}}, {{date}}) with API values;
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
        "ФИО", "ДР", "Адрес регистрации", "ПОЛ", "email", "telephone", "document",
        "date", "cross-border",
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

    private static DocCheckbox Cb(DocCheckbox c, IReadOnlyDictionary<string, string>? map) =>
        new() { Label = Apply(c.Label, map), Required = c.Required, Checked = c.Checked };

    // ---------- Conditions ----------

    /// <summary>Evaluate a block/page condition against the signer fields. A null condition is always true.</summary>
    public static bool Matches(VisibleWhen? cond, IReadOnlyDictionary<string, string>? fields)
    {
        if (cond is null || string.IsNullOrWhiteSpace(cond.Field)) return true;
        fields ??= EmptyMap;
        fields.TryGetValue(cond.Field.Trim(), out var raw);
        var val = (raw ?? "").Trim();
        var target = (cond.Value ?? "").Trim();
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
        IReadOnlyList<DocCheckbox>? dynamicCheckboxes = null)
    {
        var map = BuildMap(fields);
        var hasDynamic = dynamicCheckboxes is { Count: > 0 };

        var pages = new List<DocPage>();
        foreach (var p in doc.Pages ?? new List<DocPage>())
        {
            if (p is null) continue;                    // tolerate a document stored before Sanitize hardened
            if (!Matches(p.VisibleWhen, map)) continue; // page hidden for this signer

            pages.Add(new DocPage
            {
                HeadingRuns = HeadingRuns(p).Where(r => r is not null).Select(r => ApplyRun(r, map)).ToList(),
                Blocks = ResolveBlocks(Blocks(p), map),
                IncludeDynamic = p.IncludeDynamic,
                Checkboxes = (p.Checkboxes ?? new List<DocCheckbox>()).Where(c => c is not null).Select(c => Cb(c, map)).ToList()
            });
        }

        if (hasDynamic)
        {
            var injected = dynamicCheckboxes!.Where(c => c is not null).Select(c => Cb(c, map)).ToList();
            var anchor = pages.FirstOrDefault(p => p.IncludeDynamic) ?? pages.LastOrDefault();
            if (anchor != null) anchor.Checkboxes.AddRange(injected);
            else pages.Add(new DocPage { Checkboxes = injected });
        }

        return new DocumentConfig
        {
            Title = Apply(doc.Title, map),
            SignPrompt = Apply(doc.SignPrompt, map),
            SignBlocks = ResolveBlocks(doc.SignBlocks ?? new List<DocBlock>(), map),
            ThankYouText = Apply(doc.ThankYouText, map),
            IdleReturnSec = doc.IdleReturnSec,
            Pages = pages
        };
    }

    /// <summary>Resolve a list of blocks: drop those whose condition fails, substitute text runs,
    /// pass images through unchanged.</summary>
    private static List<DocBlock> ResolveBlocks(IEnumerable<DocBlock> blocks, IReadOnlyDictionary<string, string>? map)
    {
        var result = new List<DocBlock>();
        foreach (var b in blocks)
        {
            if (b is null) continue;
            if (!Matches(b.VisibleWhen, map)) continue;
            result.Add(new DocBlock
            {
                Runs = (b.Runs ?? new List<TextRun>()).Where(r => r is not null).Select(r => ApplyRun(r, map)).ToList(),
                ImageUrl = b.ImageUrl,
                ImageWidth = b.ImageWidth
            });
        }
        return result;
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
            foreach (var c in p.Checkboxes) c.Label = Clamp(c.Label);
        }

        doc.SignBlocks = Compact(doc.SignBlocks);
        foreach (var b in doc.SignBlocks) CleanBlock(b);
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
        }
        foreach (var b in doc.SignBlocks ?? new List<DocBlock>())
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
