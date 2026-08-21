using System.Reflection;
using Microsoft.Extensions.Logging;
using PdfSharp;
using PdfSharp.Drawing;
using PdfSharp.Fonts;
using PdfSharp.Pdf;
using SignatureKiosk.Models;

namespace SignatureKiosk.Services;

/// <summary>
/// Builds a PDF for each completed signature: the document text, the checked items,
/// and the client's signature at the bottom. Saved to the data dir's "pdf" folder.
/// Uses an embedded Cyrillic-capable font (no system-font dependency).
/// </summary>
public class PdfService
{
    /// <summary>Upper bound on image blocks rendered into one PDF, so a pathological document
    /// cannot make a single signature consume hundreds of MB.</summary>
    private const int MaxImageBlocks = 30;

    private readonly StorageService _storage;
    private readonly ILogger<PdfService>? _log;
    private static bool _fontsReady;
    private static readonly object _fontLock = new();

    public PdfService(StorageService storage, ILogger<PdfService>? logger = null)
    {
        _storage = storage;
        _log = logger;
        EnsureFonts();
    }

    private static void EnsureFonts()
    {
        if (_fontsReady) return;
        lock (_fontLock)
        {
            if (_fontsReady) return;
            GlobalFontSettings.FontResolver = new DejaVuFontResolver();
            _fontsReady = true;
        }
    }

    public string Generate(SignatureRecord rec, DocumentConfig doc, byte[] signaturePng)
    {
        var path = Path.Combine(_storage.PdfDir, rec.Id + ".pdf");

        var pdf = new PdfDocument();
        pdf.Info.Title = doc.Title;
        pdf.Info.Author = "HELIX SignTablet";

        var w = new Flow(pdf);

        w.Line(doc.Title, w.H1);
        w.Gap(6);

        var meta = "Дата: " + rec.CreatedUtc.ToLocalTime().ToString("dd.MM.yyyy HH:mm");
        if (!string.IsNullOrEmpty(rec.WorkstationName)) meta += "     Рабочее место: " + rec.WorkstationName;
        if (!string.IsNullOrEmpty(rec.DeviceName)) meta += "     Планшет: " + rec.DeviceName;
        w.Line(meta, w.Small);
        w.Gap(14);

        if (rec.Fields is { Count: > 0 })
        {
            w.Line("Данные подписанта:", w.H2);
            w.Gap(3);
            foreach (var kv in rec.Fields)
                w.Paragraph(kv.Key + ": " + kv.Value, w.Body);
            w.Gap(12);
        }

        // Images referenced by blocks must stay alive until Save (PDFsharp reads them lazily), and
        // each distinct file is decoded ONCE: the same logo repeated across a document used to be
        // decoded per block, which under concurrent signing could take hundreds of MB.
        var keepImages = new Dictionary<string, XImage>(StringComparer.Ordinal);
        var imageBlocks = 0;
        void RenderBlocks(IEnumerable<DocBlock> blocks)
        {
            foreach (var block in blocks)
            {
                if (block is null) continue;
                if (!string.IsNullOrEmpty(block.ImageUrl))
                {
                    if (imageBlocks >= MaxImageBlocks) continue;   // bounded work per document
                    var file = MediaFile(block.ImageUrl);
                    if (file == null) continue;
                    if (!keepImages.TryGetValue(file, out var xi))
                    {
                        // Skip an image PDFsharp cannot decode rather than failing the whole PDF.
                        try { xi = XImage.FromFile(file); }
                        catch (Exception ex) { _log?.LogWarning(ex, "Skipping undecodable image {File} in PDF", file); continue; }
                        keepImages[file] = xi;
                    }
                    imageBlocks++;
                    w.BlockImage(xi, block.ImageWidth);
                }
                else if (block.Runs is { Count: > 0 }) { w.Rich(block.Runs, isHeading: false); w.Gap(8); }
            }
        }

        // Отметки печатаются там же, где их видел клиент: пункт относится к абзацу над ним, и
        // собранные в конец галочки уже читались бы про другое. Состояние берётся из записи
        // подписи (что человек действительно отметил), а место - из документа, который ему
        // показали. Сопоставление по имени, а при его отсутствии по тексту, по порядку.
        var itemsByKey = new Dictionary<string, SubmittedItem>(StringComparer.OrdinalIgnoreCase);
        foreach (var it in rec.Items ?? new List<SubmittedItem>())
            if (it is not null && !string.IsNullOrEmpty(it.Key)) itemsByKey[it.Key] = it;
        var unkeyed = new List<SubmittedItem>((rec.Items ?? new List<SubmittedItem>())
            .Where(i => i is not null && string.IsNullOrEmpty(i.Key)));
        var groupsByKey = new Dictionary<string, SubmittedGroup>(StringComparer.OrdinalIgnoreCase);
        foreach (var g in rec.Groups ?? new List<SubmittedGroup>())
            if (g is not null && !string.IsNullOrEmpty(g.Key)) groupsByKey[g.Key] = g;
        var printedItems = new HashSet<SubmittedItem>();
        var printedGroups = new HashSet<SubmittedGroup>();

        bool StateOf(DocCheckbox cb)
        {
            if (!string.IsNullOrEmpty(cb.Key) && itemsByKey.TryGetValue(cb.Key, out var byKey))
            {
                printedItems.Add(byKey);
                return byKey.Checked;
            }
            // Безымянный пункт узнаём по тексту, беря первый ещё не напечатанный: на планшете
            // отметки собираются в том же порядке, в каком они здесь встречаются.
            var match = unkeyed.FirstOrDefault(i => !printedItems.Contains(i) &&
                                                    string.Equals(i.Label ?? "", cb.Label ?? "", StringComparison.Ordinal));
            if (match is not null) { printedItems.Add(match); return match.Checked; }
            return cb.Checked;   // запись не совпала с документом: печатаем то, что знаем
        }

        void RenderGroup(string? title, bool required, string? selected, List<DocGroupOption> options, string? selectedLabel)
        {
            w.Gap(6);
            if (!string.IsNullOrWhiteSpace(title)) w.Line(title! + (required ? " *" : ""), w.H2);
            w.Gap(3);
            if (options.Count == 0 && !string.IsNullOrWhiteSpace(selectedLabel))
                w.Paragraph("[X]  " + selectedLabel, w.Body);
            foreach (var o in options)
            {
                if (o is null) continue;
                var chosen = !string.IsNullOrEmpty(selected) &&
                             string.Equals(o.Key, selected, StringComparison.OrdinalIgnoreCase);
                w.Paragraph((chosen ? "[X]  " : "[  ]  ") + (o.Label ?? o.Key ?? ""), w.Body);
            }
            if (string.IsNullOrEmpty(selected)) w.Paragraph("Вариант не выбран.", w.Body);
            w.Gap(4);
        }

        foreach (var page in doc.Pages ?? new List<DocPage>())
        {
            var heading = DocumentTemplating.HeadingRuns(page);
            if (heading.Count > 0) { w.Rich(heading, isHeading: true); w.Gap(2); }

            foreach (var (kind, index) in DocumentTemplating.PageOrder(page, DocumentTemplating.Blocks(page)))
            {
                if (kind == 0) { RenderBlocks(new[] { DocumentTemplating.Blocks(page)[index] }); continue; }
                if (kind == 1)
                {
                    var cb = page.Checkboxes[index];
                    w.Paragraph((StateOf(cb) ? "[X]  " : "[  ]  ") + (cb.Label ?? "") + (cb.Required ? " *" : ""), w.Body);
                    continue;
                }
                var g = page.Groups[index];
                SubmittedGroup? sg = null;
                if (!string.IsNullOrEmpty(g.Key) && groupsByKey.TryGetValue(g.Key, out var foundGroup))
                {
                    sg = foundGroup;
                    printedGroups.Add(sg);
                }
                RenderGroup(g.Title, g.Required, sg?.Selected ?? g.Selected,
                    sg?.Options is { Count: > 0 } ? sg.Options : g.Options, sg?.SelectedLabel);
            }
        }

        // Всё, что есть в записи, но чему не нашлось места в документе, всё равно должно попасть
        // в PDF: запись подписи это то, с чем человек согласился, и терять из неё нельзя ничего.
        var leftoverItems = (rec.Items ?? new List<SubmittedItem>())
            .Where(i => i is not null && !printedItems.Contains(i)).ToList();
        if (leftoverItems.Count > 0)
        {
            w.Gap(4);
            w.Line("Отмеченные пункты:", w.H2);
            w.Gap(3);
            foreach (var it in leftoverItems)
                w.Paragraph((it.Checked ? "[X]  " : "[  ]  ") + (it.Label ?? ""), w.Body);
        }
        foreach (var g in (rec.Groups ?? new List<SubmittedGroup>()).Where(g => g is not null && !printedGroups.Contains(g)))
            RenderGroup(g.Title, false, g.Selected, g.Options ?? new List<DocGroupOption>(), g.SelectedLabel);

        // Custom signature-page content authored in the admin, above the signature.
        if (doc.SignBlocks is { Count: > 0 }) { w.Gap(6); RenderBlocks(doc.SignBlocks); }

        w.Gap(26);
        // PDFsharp calls MemoryStream.GetBuffer(), which requires a publicly-visible buffer.
        using var ms = new MemoryStream(signaturePng, 0, signaturePng.Length, writable: false, publiclyVisible: true);
        // If the signature image cannot be decoded, still produce the PDF (with the document text,
        // signer data and checked items) and say so in it: losing the whole record would be worse.
        // The PNG itself is always kept alongside the record either way.
        XImage? img = null;
        try { img = XImage.FromStream(ms); }
        catch (Exception ex) { _log?.LogWarning(ex, "Signature image could not be decoded for {Id}", rec.Id); }

        if (img is not null) w.Signature("Подпись клиента:", img);
        else
        {
            w.Line("Подпись клиента:", w.H2);
            w.Gap(3);
            w.Paragraph("Изображение подписи не удалось встроить в PDF. Оригинал подписи сохранён в записи и доступен в админке.", w.Body);
        }

        // Content the admin placed under the signature (company details, a stamp, a note).
        if (doc.SignBlocksBelow is { Count: > 0 }) { w.Gap(10); RenderBlocks(doc.SignBlocksBelow); }

        try
        {
            // ms and images must stay alive across Save: PDFsharp reads the image bytes lazily there.
            pdf.Save(path);
            return path;
        }
        finally
        {
            // Release everything even if Save throws (disk full, unwritable path): otherwise a
            // failing generation stranded every decoded image until the next collection.
            w.Finish();
            img?.Dispose();
            foreach (var xi in keepImages.Values) xi.Dispose();
            pdf.Dispose();
        }
    }

    /// <summary>Map a block's "/media/{file}" reference to a real file under the image store, or null.</summary>
    private string? MediaFile(string? url)
    {
        var clean = DocumentTemplating.CleanImageUrl(url);
        if (clean is null) return null;
        var name = clean["/media/".Length..];
        var path = Path.Combine(_storage.ImagesDir, name);
        return File.Exists(path) ? path : null;
    }

    // ---------- Simple top-to-bottom flow with word wrap and pagination ----------
    private sealed class Flow
    {
        private const double Margin = 50;
        private readonly PdfDocument _doc;
        private XGraphics _gfx = null!;
        private double _y, _pageH, _contentW;

        public readonly XFont H1 = new("DejaVu", 18, XFontStyleEx.Bold);
        public readonly XFont H2 = new("DejaVu", 13, XFontStyleEx.Bold);
        public readonly XFont Body = new("DejaVu", 11, XFontStyleEx.Regular);
        public readonly XFont Small = new("DejaVu", 9, XFontStyleEx.Regular);

        public Flow(PdfDocument doc) { _doc = doc; NewPage(); }

        private void NewPage()
        {
            // Release the finished page's graphics before starting the next, so at most one
            // XGraphics is live at a time during generation.
            _gfx?.Dispose();
            var page = _doc.AddPage();
            page.Size = PageSize.A4;
            _gfx = XGraphics.FromPdfPage(page);
            _pageH = page.Height.Point;
            _contentW = page.Width.Point - 2 * Margin;
            _y = Margin;
        }

        /// <summary>Release the last page's graphics (call after the document has been saved).</summary>
        public void Finish() => _gfx?.Dispose();

        public void Gap(double h) => _y += h;

        private void Ensure(double h) { if (_y + h > _pageH - Margin) NewPage(); }

        private void Draw(string text, XFont font)
        {
            var lineH = font.GetHeight() * 1.15;
            Ensure(lineH);
            _gfx.DrawString(text, font, XBrushes.Black, new XPoint(Margin, _y + font.GetHeight()));
            _y += lineH;
        }

        /// <summary>Single line (no wrapping), for headings / meta.</summary>
        public void Line(string text, XFont font) => Draw(text, font);

        /// <summary>Wrapped multi-paragraph body text.</summary>
        public void Paragraph(string text, XFont font)
        {
            var lineH = font.GetHeight() * 1.15;
            foreach (var para in text.Replace("\r", "").Split('\n'))
            {
                if (para.Length == 0) { Gap(lineH * 0.6); continue; }
                var line = "";
                foreach (var raw in para.Split(' '))
                {
                    // Слово шире строки разрывается по символам: иначе его хвост уходит за поле.
                    var pieces = _gfx.MeasureString(raw, font).Width > _contentW
                        ? BreakLongWord(raw, font, _contentW)
                        : new List<string> { raw };
                    foreach (var word in pieces)
                    {
                        var trial = line.Length == 0 ? word : line + " " + word;
                        if (line.Length > 0 && _gfx.MeasureString(trial, font).Width > _contentW)
                        {
                            Draw(line, font);
                            line = word;
                        }
                        else line = trial;
                    }
                }
                if (line.Length > 0) Draw(line, font);
            }
        }

        /// <summary>
        /// Разбить слово, которое само по себе шире строки, на куски по ширине. Текст приходит
        /// из внешней системы и из редактора: там встречается и разделитель из полусотни
        /// звёздочек, и длинная ссылка. Без разрыва хвост такого слова уезжает за поле и в
        /// подписанном документе просто пропадает, вместе со знаком препинания в конце.
        /// </summary>
        private List<string> BreakLongWord(string word, XFont font, double maxWidth)
        {
            var parts = new List<string>();
            var current = "";
            foreach (var ch in word)
            {
                var trial = current + ch;
                if (current.Length > 0 && _gfx.MeasureString(trial, font).Width > maxWidth)
                {
                    parts.Add(current);
                    current = ch.ToString();
                }
                else current = trial;
            }
            if (current.Length > 0) parts.Add(current);
            return parts;
        }

        // ---------- Rich runs (bold / italic / size / colour) ----------
        private readonly Dictionary<(double, bool), XFont> _fontCache = new();

        private XFont FontFor(double sizePt, bool bold)
        {
            var key = (sizePt, bold);
            if (!_fontCache.TryGetValue(key, out var f))
                _fontCache[key] = f = new XFont("DejaVu", sizePt, bold ? XFontStyleEx.Bold : XFontStyleEx.Regular);
            return f;
        }

        private static double SizePt(string? size, bool heading) => size switch
        {
            "l" => heading ? 18 : 15,
            "h" => heading ? 24 : 20,
            _ => heading ? 14 : 11
        };

        private static XBrush BrushFor(string? color)
        {
            if (!string.IsNullOrEmpty(color) && color.Length == 7 && color[0] == '#'
                && int.TryParse(color.AsSpan(1, 2), System.Globalization.NumberStyles.HexNumber, null, out var r)
                && int.TryParse(color.AsSpan(3, 2), System.Globalization.NumberStyles.HexNumber, null, out var g)
                && int.TryParse(color.AsSpan(5, 2), System.Globalization.NumberStyles.HexNumber, null, out var b))
                return new XSolidBrush(XColor.FromArgb(r, g, b));
            return XBrushes.Black;
        }

        /// <summary>Render a list of styled runs with word-wrap and pagination. Italic is simulated with
        /// a shear, since no proportional italic face is embedded, so this stays a single-font document.</summary>
        public void Rich(List<TextRun> runs, bool isHeading)
        {
            var pending = new List<(string text, XFont font, XBrush brush, bool italic, double x, double w)>();
            double x = Margin, lineH = 0;

            void Flush()
            {
                if (pending.Count == 0) return;
                double h = lineH * 1.2;
                Ensure(h);
                double baseline = _y + lineH;
                foreach (var t in pending) DrawWord(t.text, t.font, t.brush, t.italic, t.x, baseline);
                _y += h;
                pending.Clear(); x = Margin; lineH = 0;
            }

            foreach (var run in runs ?? new List<TextRun>())
            {
                var font = FontFor(SizePt(run.Size, isHeading), isHeading || run.Bold);
                var brush = BrushFor(run.Color);
                double space = _gfx.MeasureString(" ", font).Width;
                var segments = (run.Text ?? "").Replace("\r", "").Split('\n');
                for (int si = 0; si < segments.Length; si++)
                {
                    if (si > 0) Flush(); // an explicit newline inside the run ends the line
                    foreach (var raw in segments[si].Split(' '))
                    {
                        if (raw.Length == 0) continue;
                        var pieces = _gfx.MeasureString(raw, font).Width > _contentW
                            ? BreakLongWord(raw, font, _contentW)
                            : new List<string> { raw };
                        var first = true;
                        foreach (var word in pieces)
                        {
                            double ww = _gfx.MeasureString(word, font).Width;
                            // Пробел ставится только перед настоящим словом: куски одного
                            // разорванного слова склеиваются без пробела, иначе разрыв читался бы
                            // как два разных слова.
                            double sp = pending.Count > 0 && first ? space : 0;
                            if (pending.Count > 0 && x + sp + ww > Margin + _contentW) { Flush(); sp = 0; }
                            x += sp;
                            pending.Add((word, font, brush, run.Italic, x, ww));
                            x += ww;
                            lineH = Math.Max(lineH, font.GetHeight());
                            first = false;
                        }
                    }
                }
            }
            Flush();
        }

        private void DrawWord(string text, XFont font, XBrush brush, bool italic, double x, double baseline)
        {
            if (!italic) { _gfx.DrawString(text, font, brush, new XPoint(x, baseline)); return; }
            var state = _gfx.Save();
            _gfx.TranslateTransform(x, baseline);
            _gfx.MultiplyTransform(new XMatrix(1, 0, -0.22, 1, 0, 0)); // shear -> right-leaning italic
            _gfx.DrawString(text, font, brush, new XPoint(0, 0));
            _gfx.Restore(state);
        }

        /// <summary>Draw a block image scaled to a percent of the content width, capped to the page.</summary>
        public void BlockImage(XImage img, int widthPct)
        {
            if (img.PixelWidth <= 0 || img.PixelHeight <= 0) return;
            double pct = Math.Clamp(widthPct <= 0 ? 100 : widthPct, 10, 100) / 100.0;
            double dw = _contentW * pct;
            double dh = dw * img.PixelHeight / img.PixelWidth;
            double maxH = _pageH - 2 * Margin;
            if (dh > maxH) { double k = maxH / dh; dh *= k; dw *= k; }
            Ensure(dh + 8);
            _gfx.DrawImage(img, Margin, _y, dw, dh);
            _y += dh + 8;
        }

        public void Signature(string label, XImage img)
        {
            const double boxW = 280, boxH = 100;
            Ensure(H2.GetHeight() * 1.5 + boxH + 12);
            _gfx.DrawString(label, H2, XBrushes.Black, new XPoint(Margin, _y + H2.GetHeight()));
            _y += H2.GetHeight() * 1.5;

            double scale = img.PixelWidth > 0 && img.PixelHeight > 0
                ? Math.Min(boxW / img.PixelWidth, boxH / img.PixelHeight)
                : 1;
            double dw = img.PixelWidth * scale, dh = img.PixelHeight * scale;
            _gfx.DrawImage(img, Margin, _y, dw, dh);
            _y += Math.Max(dh, 40) + 4;
            _gfx.DrawLine(new XPen(XColors.Gray, 0.75), Margin, _y, Margin + boxW, _y);
        }
    }
}

/// <summary>Resolves the single embedded DejaVu font (regular + bold).</summary>
internal sealed class DejaVuFontResolver : IFontResolver
{
    private static readonly byte[] Regular = Load("SignatureKiosk.Resources.DejaVuSans.ttf");
    private static readonly byte[] Bold = Load("SignatureKiosk.Resources.DejaVuSans-Bold.ttf");

    private static byte[] Load(string resourceName)
    {
        using var s = Assembly.GetExecutingAssembly().GetManifestResourceStream(resourceName)
            ?? throw new InvalidOperationException("Embedded font not found: " + resourceName);
        using var ms = new MemoryStream();
        s.CopyTo(ms);
        return ms.ToArray();
    }

    public byte[]? GetFont(string faceName) => faceName == "DejaVu#Bold" ? Bold : Regular;

    public FontResolverInfo ResolveTypeface(string familyName, bool isBold, bool isItalic) =>
        new(isBold ? "DejaVu#Bold" : "DejaVu#Regular");
}
