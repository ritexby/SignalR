using System.Text.RegularExpressions;
using SignatureKiosk.Models;

namespace SignatureKiosk.Services;

/// <summary>
/// Substitutes {{placeholder}} tags in a document with per-signer field values passed
/// in at show time (for example {{ФИО}}, {{ДР}}, {{Адрес регистрации}}). Tags may contain
/// Cyrillic and spaces; matching is case-insensitive and trims surrounding whitespace.
/// An unknown tag is left untouched so a missing field is visible rather than silently blank.
/// </summary>
public static partial class DocumentTemplating
{
    [GeneratedRegex(@"\{\{\s*(.+?)\s*\}\}", RegexOptions.Singleline)]
    private static partial Regex TagRegex();

    /// <summary>Replace tags in a single string using the supplied fields.</summary>
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

    /// <summary>
    /// Return a resolved copy of the document: every text field has its {{tags}} substituted,
    /// and any API-supplied checkboxes are injected at the anchor page (the page marked
    /// IncludeDynamic, else the last page). The original template is never mutated.
    /// </summary>
    public static DocumentConfig Resolve(DocumentConfig doc, IReadOnlyDictionary<string, string>? fields,
        IReadOnlyList<DocCheckbox>? dynamicCheckboxes = null)
    {
        var hasFields = fields is not null && fields.Count > 0;
        var hasDynamic = dynamicCheckboxes is not null && dynamicCheckboxes.Count > 0;

        // Always build a fresh copy (even with nothing to substitute) so the caller can never
        // mutate the shared template through the returned object.
        var map = hasFields ? new Dictionary<string, string>(fields!, StringComparer.OrdinalIgnoreCase) : null;

        DocCheckbox Cb(DocCheckbox c) => new() { Label = Apply(c.Label, map), Required = c.Required, Checked = c.Checked };

        var pages = (doc.Pages ?? new List<DocPage>()).Select(p => new DocPage
        {
            Heading = Apply(p.Heading, map),
            Body = Apply(p.Body, map),
            IncludeDynamic = p.IncludeDynamic,
            Checkboxes = (p.Checkboxes ?? new List<DocCheckbox>()).Select(Cb).ToList()
        }).ToList();

        if (hasDynamic)
        {
            var injected = dynamicCheckboxes!.Select(Cb).ToList();
            var anchor = pages.FirstOrDefault(p => p.IncludeDynamic) ?? pages.LastOrDefault();
            if (anchor != null) anchor.Checkboxes.AddRange(injected);
            else pages.Add(new DocPage { Checkboxes = injected });
        }

        return new DocumentConfig
        {
            Title = Apply(doc.Title, map),
            SignPrompt = Apply(doc.SignPrompt, map),
            ThankYouText = Apply(doc.ThankYouText, map),
            IdleReturnSec = doc.IdleReturnSec,
            Pages = pages
        };
    }

    /// <summary>All distinct placeholder keys used anywhere in the document, in first-seen order.</summary>
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
            Scan(p.Heading); Scan(p.Body);
            foreach (var c in p.Checkboxes ?? new List<DocCheckbox>()) Scan(c.Label);
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
