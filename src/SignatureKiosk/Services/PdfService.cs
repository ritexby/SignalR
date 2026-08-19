using System.Reflection;
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
    private readonly StorageService _storage;
    private static bool _fontsReady;
    private static readonly object _fontLock = new();

    public PdfService(StorageService storage)
    {
        _storage = storage;
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

        foreach (var page in doc.Pages ?? new List<DocPage>())
        {
            if (!string.IsNullOrWhiteSpace(page.Heading)) { w.Line(page.Heading, w.H2); w.Gap(2); }
            if (!string.IsNullOrWhiteSpace(page.Body)) { w.Paragraph(page.Body, w.Body); w.Gap(8); }
        }

        if (rec.Items is { Count: > 0 })
        {
            w.Gap(4);
            w.Line("Отмеченные пункты:", w.H2);
            w.Gap(3);
            foreach (var it in rec.Items)
                w.Paragraph((it.Checked ? "[X]  " : "[  ]  ") + it.Label, w.Body);
        }

        w.Gap(26);
        // PDFsharp calls MemoryStream.GetBuffer(), which requires a publicly-visible buffer.
        using var ms = new MemoryStream(signaturePng, 0, signaturePng.Length, writable: false, publiclyVisible: true);
        var img = XImage.FromStream(ms);
        w.Signature("Подпись клиента:", img);

        // ms and img must stay alive across Save: PDFsharp reads the image bytes lazily there.
        pdf.Save(path);
        w.Finish();
        img.Dispose();
        return path;
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
                foreach (var word in para.Split(' '))
                {
                    var trial = line.Length == 0 ? word : line + " " + word;
                    if (line.Length > 0 && _gfx.MeasureString(trial, font).Width > _contentW)
                    {
                        Draw(line, font);
                        line = word;
                    }
                    else line = trial;
                }
                if (line.Length > 0) Draw(line, font);
            }
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
