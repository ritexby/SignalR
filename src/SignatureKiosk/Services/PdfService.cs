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

    public string Generate(SignatureRecord rec, DocumentConfig doc, byte[] signaturePng,
        Func<string, byte[]?>? extraSignature = null)
    {
        var path = Path.Combine(_storage.PdfDir, rec.Id + ".pdf");
        var pdf = new PdfDocument();
        Built? built = null;
        try
        {
            built = Build(pdf, rec, doc, signaturePng, extraSignature, null);
            // Картинки должны дожить до Save: PDFsharp читает их байты лениво именно там.
            pdf.Save(path);
            return path;
        }
        finally { built?.Dispose(); pdf.Dispose(); }
    }

    /// <summary>
    /// Раскладка документа: где именно окажется каждая строка и каждая картинка, в точках PDF.
    /// Считается той же самой сборкой, что и настоящий PDF, поэтому предпросмотр в админке
    /// показывает не похожее на PDF, а его самого. Рисовать PDF в браузере для этого не нужно.
    /// </summary>
    public PdfLayout Layout(DocumentConfig doc, SignatureRecord? rec = null)
    {
        var capture = new List<PdfLayoutItem>();
        var pdf = new PdfDocument();
        var record = rec ?? new SignatureRecord { Id = "preview", CreatedUtc = DateTime.UtcNow, DocumentTitle = doc.Title };
        Built? built = null;
        try
        {
            built = Build(pdf, record, doc, null, null, capture);
            return new PdfLayout(built.Flow.PageWidth, built.Flow.PageHeight, built.Flow.PageCount, capture);
        }
        finally { built?.Dispose(); pdf.Dispose(); }
    }

    /// <summary>Собранный документ вместе с картинками, которые нельзя освободить до сохранения.</summary>
    private sealed class Built : IDisposable
    {
        public required Flow Flow { get; init; }
        public XImage? Signature { get; init; }
        public required Dictionary<string, XImage> Images { get; init; }
        public MemoryStream? Stream { get; init; }
        public void Dispose()
        {
            Flow.Finish();
            Signature?.Dispose();
            foreach (var xi in Images.Values) xi.Dispose();
            Stream?.Dispose();
        }
    }

    private Built Build(PdfDocument pdf, SignatureRecord rec, DocumentConfig doc, byte[]? signaturePng,
        Func<string, byte[]?>? extraSignature, List<PdfLayoutItem>? capture)
    {
        pdf.Info.Title = doc.Title;
        pdf.Info.Author = "HELIX SignTablet";

        var w = new Flow(pdf,
            Math.Clamp(doc.PdfFontScale <= 0 ? 100 : doc.PdfFontScale, 50, 100) / 100.0,
            Math.Clamp(doc.PdfSignatureScale <= 0 ? 100 : doc.PdfSignatureScale, 40, 100) / 100.0) { Capture = capture };

        // Подписи, которым оператор задал место на листе, в поток текста не попадают: они
        // печатаются последними, поверх готовой страницы, ровно там, где он их поставил.
        var placed = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var pl in doc.SignaturePlacements ?? new List<SignaturePlacement>())
            placed.Add((pl.Key ?? "").Trim());

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
                    // Картинка не встаёт сбоку другой картинки: две обтекаемые подряд означали бы
                    // колонку из картинок и обрывки текста между ними.
                    w.ClearWrap();
                    w.BlockImage(xi, block.ImageWidth, DocumentTemplating.CleanImageUrl(block.ImageUrl) ?? "",
                        block.Align, block.Wrap, block.WrapGap);
                }
                else if (block.Runs is { Count: > 0 }) { w.Rich(block.Runs, isHeading: false, block.Align); w.Gap(8); }
                else if (!string.IsNullOrEmpty(block.ImageUrl)) { /* картинка уже нарисована выше */ }
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
        // Подпись из поля страницы. Расшифровывается один раз: одна и та же подпись может
        // печататься и в потоке, и по заданному месту.
        XImage? PageSignature(string? key)
        {
            if (capture is not null) return null;   // в раскладке настоящих подписей нет
            var name = (key ?? "").Trim();
            if (keepImages.TryGetValue("sig:" + name, out var have)) return have;
            var stored = (rec.Signatures ?? new List<SignedSignature>()).FirstOrDefault(x => x is not null &&
                string.Equals(x.Key, name, StringComparison.OrdinalIgnoreCase));
            var bytes = stored is null ? null : extraSignature?.Invoke(stored.File);
            if (bytes is null) return null;
            try
            {
                using var sms = new MemoryStream(bytes, 0, bytes.Length, writable: false, publiclyVisible: true);
                var xi = XImage.FromStream(sms);
                keepImages["sig:" + name] = xi;
                return xi;
            }
            catch (Exception ex) { _log?.LogWarning(ex, "Page signature {Key} could not be decoded", name); return null; }
        }

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

        void RenderGroup(string? title, bool required, string? selected, List<DocGroupOption> options,
            string? selectedLabel, List<TextRun>? titleRuns = null)
        {
            w.ClearWrap();
            w.Gap(6);
            var head = DocumentTemplating.LabelRuns(titleRuns, title);
            if (head.Count > 0) w.Rich(MarkedRuns("", head, required), isHeading: true);
            w.Gap(3);
            if (options.Count == 0 && !string.IsNullOrWhiteSpace(selectedLabel))
                w.Paragraph("[X]  " + selectedLabel, w.Body);
            foreach (var o in options)
            {
                if (o is null) continue;
                var chosen = !string.IsNullOrEmpty(selected) &&
                             string.Equals(o.Key, selected, StringComparison.OrdinalIgnoreCase);
                w.Rich(MarkedRuns(chosen ? "[X]  " : "[  ]  ",
                    DocumentTemplating.LabelRuns(o.LabelRuns, o.Label ?? o.Key), false), isHeading: false);
            }
            if (string.IsNullOrEmpty(selected)) w.Paragraph("Вариант не выбран.", w.Body);
            w.Gap(4);
        }

        foreach (var page in doc.Pages ?? new List<DocPage>())
        {
            w.ClearWrap();
            var heading = DocumentTemplating.HeadingRuns(page);
            if (heading.Count > 0) { w.Rich(heading, isHeading: true, page.HeadingAlign); w.Gap(2); }

            foreach (var (kind, index) in DocumentTemplating.PageOrder(page, DocumentTemplating.Blocks(page)))
            {
                if (kind == 0) { RenderBlocks(new[] { DocumentTemplating.Blocks(page)[index] }); continue; }
                if (kind == 1)
                {
                    w.ClearWrap();
                    var cb = page.Checkboxes[index];
                    // Оформление подписи пункта попадает и в PDF: пункт, выделенный на планшете,
                    // должен так же выделяться и на бумаге, иначе документ на экране и документ
                    // в руках у человека выглядят по-разному.
                    w.Rich(MarkedRuns(StateOf(cb) ? "[X]  " : "[  ]  ",
                        DocumentTemplating.LabelRuns(cb.LabelRuns, cb.Label), cb.Required), isHeading: false);
                    continue;
                }
                if (kind == 3)
                {
                    // Подпись, поставленная внутри страницы, печатается там же, где стояла на
                    // экране: иначе по документу нельзя понять, что именно ею подтверждено.
                    var sig = page.Signatures[index];
                    if (placed.Contains((sig.Key ?? "").Trim())) continue;
                    w.ClearWrap();
                    w.Gap(6);
                    w.SignatureBlock(sig.Label, PageSignature(sig.Key), "Подпись в этом поле не поставлена.",
                        sig.Key ?? "", sig.Width, sig.Height, sig.Align);
                    continue;
                }
                // Отсканированный код в PDF не печатается: это служебные данные заказа, а не то,
                // что человек подписывает. В записи подписи он есть, и внешняя система его видит.
                if (kind == 4) continue;

                var g = page.Groups[index];
                SubmittedGroup? sg = null;
                if (!string.IsNullOrEmpty(g.Key) && groupsByKey.TryGetValue(g.Key, out var foundGroup))
                {
                    sg = foundGroup;
                    printedGroups.Add(sg);
                }
                RenderGroup(g.Title, g.Required, sg?.Selected ?? g.Selected,
                    sg?.Options is { Count: > 0 } ? sg.Options : g.Options, sg?.SelectedLabel, g.TitleRuns);
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

        // PDFsharp calls MemoryStream.GetBuffer(), which requires a publicly-visible buffer.
        // Поток нельзя закрывать здесь: PDFsharp читает из него уже во время сохранения, поэтому
        // он живёт вместе с собранным документом и закрывается вместе с ним.
        // If the signature image cannot be decoded, still produce the PDF (with the document text,
        // signer data and checked items) and say so in it: losing the whole record would be worse.
        // The PNG itself is always kept alongside the record either way.
        MemoryStream? ms = null;
        XImage? img = null;
        if (signaturePng is not null)
        {
            ms = new MemoryStream(signaturePng, 0, signaturePng.Length, writable: false, publiclyVisible: true);
            try { img = XImage.FromStream(ms); }
            catch (Exception ex) { _log?.LogWarning(ex, "Signature image could not be decoded for {Id}", rec.Id); }
        }

        // Итоговая подпись под документом. Если оператор задал ей место на листе, здесь её нет:
        // ниже она напечатается поверх страницы. В раскладке настоящей подписи ещё нет, но место
        // под неё занять надо, иначе предпросмотр покажет документ короче, чем он окажется.
        // Подпись, которую не удалось расшифровать, нельзя просто не напечатать: документ
        // выглядел бы неподписанным. Поэтому сообщение печатается и тогда, когда подписи задано
        // своё место на листе.
        var брак = signaturePng is not null && img is null;
        if (!placed.Contains("") || брак)
        {
            w.ClearWrap();
            w.Gap(26);
            if (брак)
            {
                w.Line("Подпись клиента:", w.H2);
                w.Gap(3);
                w.Paragraph("Изображение подписи не удалось встроить в PDF. Оригинал подписи сохранён в записи и доступен в админке.", w.Body);
            }
            else w.SignatureBlock("Подпись клиента:", img, null, "");
        }

        // Content the admin placed under the signature (company details, a stamp, a note).
        if (doc.SignBlocksBelow is { Count: > 0 }) { w.Gap(10); RenderBlocks(doc.SignBlocksBelow); }

        // Размещённые подписи печатаются в самом конце: страницы к этому моменту свёрстаны, и
        // номер страницы, на который указывает раскладка, уже что-то значит.
        if (capture is null)
            foreach (var pl in doc.SignaturePlacements ?? new List<SignaturePlacement>())
            {
                var key = (pl.Key ?? "").Trim();
                var stamp = key.Length == 0 ? img : PageSignature(key);
                if (stamp is not null) w.StampSignature(pl.Page, pl.X, pl.Y, pl.W, pl.H, stamp);
            }

        return new Built { Flow = w, Signature = img, Images = keepImages, Stream = ms };
    }

    /// <summary>
    /// Строка пункта: отметка, оформленный текст и звёздочка обязательного. Отметка идёт своим
    /// куском без оформления, иначе крупный или цветной текст пункта утащил бы за собой и скобки.
    /// </summary>
    private static List<TextRun> MarkedRuns(string mark, List<TextRun> label, bool required)
    {
        var runs = new List<TextRun> { new() { Text = mark } };
        foreach (var r in label) if (r is not null) runs.Add(r);
        if (required) runs.Add(new TextRun { Text = " *" });
        return runs;
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
        private double _pageW;
        private int _pageIndex = -1;

        /// <summary>Размер места под подпись на листе, в точках, при обычном размере.</summary>
        private const double BaseSignW = 280, BaseSignH = 100;
        /// <summary>Размер места под подпись с учётом настройки документа.</summary>
        private double SignW => BaseSignW * _signScale;
        private double SignH => BaseSignH * _signScale;
        private readonly double _signScale;

        /// <summary>Куда записывать раскладку. null означает обычную сборку PDF без записи.</summary>
        public List<PdfLayoutItem>? Capture;

        public double PageWidth => _pageW;
        public double PageHeight => _pageH;
        public int PageCount => _pageIndex + 1;

        private void Note(string kind, double x, double y, double w, double h,
            string text = "", double size = 0, bool bold = false, bool italic = false, string color = "")
        {
            Capture?.Add(new PdfLayoutItem(_pageIndex, kind, x, y, w, h, text, size, bold, italic, color));
        }

        public readonly XFont H1;
        public readonly XFont H2;
        public readonly XFont Body;
        public readonly XFont Small;

        /// <summary>
        /// Во сколько раз шрифт в PDF мельче, чем на планшете. Экран и бумага это разные
        /// носители: на планшете крупный шрифт нужен, чтобы читалось с расстояния, а на бумаге
        /// тот же размер раздувает документ на лишние страницы. Поля и место под подпись не
        /// меняются: они заданы форматом листа, а не размером букв.
        /// </summary>
        private readonly double _scale;

        public Flow(PdfDocument doc, double scale = 1, double signScale = 1)
        {
            _doc = doc;
            _scale = Math.Clamp(scale <= 0 ? 1 : scale, 0.5, 1);
            _signScale = Math.Clamp(signScale <= 0 ? 1 : signScale, 0.4, 1);
            H1 = new XFont("DejaVu", 18 * _scale, XFontStyleEx.Bold);
            H2 = new XFont("DejaVu", 13 * _scale, XFontStyleEx.Bold);
            Body = new XFont("DejaVu", 11 * _scale, XFontStyleEx.Regular);
            Small = new XFont("DejaVu", 9 * _scale, XFontStyleEx.Regular);
            NewPage();
        }

        private void NewPage()
        {
            // Release the finished page's graphics before starting the next, so at most one
            // XGraphics is live at a time during generation.
            _gfx?.Dispose();
            var page = _doc.AddPage();
            page.Size = PageSize.A4;
            _gfx = XGraphics.FromPdfPage(page);
            _pageH = page.Height.Point;
            _pageW = page.Width.Point;
            _contentW = page.Width.Point - 2 * Margin;
            _y = Margin;
            _pageIndex++;
        }

        /// <summary>Release the last page's graphics (call after the document has been saved).</summary>
        public void Finish() => _gfx?.Dispose();

        public void Gap(double h) => _y += h;

        /// <summary>
        /// Опуститься ниже обтекаемой картинки, если поток ещё внутри неё. Нужно перед тем, что
        /// не должно вставать сбоку: пунктом, группой, местом подписи или новой картинкой. Иначе
        /// они наехали бы на картинку, а обтекание задумано только для текста.
        /// </summary>
        public void ClearWrap()
        {
            if (!FloatActive) { ClearFloat(); return; }
            _y = _floatBottom + 4;
            ClearFloat();
        }

        // ---------- Обтекание картинки текстом ----------
        // Пока строка попадает в вертикальный отрезок, занятый картинкой, её левая или правая
        // граница сдвигается. Это и есть обтекание: свой перенос строк обходит картинку так же,
        // как это делает браузер на планшете.
        private double _floatBottom;   // до какого y картинка занимает место
        private double _floatWidth;    // сколько она отнимает по ширине, вместе с отступом
        private bool _floatRight;      // картинка справа, значит текст жмётся влево

        private bool FloatActive => _floatWidth > 0 && _y < _floatBottom;
        /// <summary>Левая граница строки на текущей высоте.</summary>
        private double LineLeft => FloatActive && !_floatRight ? Margin + _floatWidth : Margin;
        /// <summary>Правая граница строки на текущей высоте.</summary>
        private double LineRight => Margin + _contentW - (FloatActive && _floatRight ? _floatWidth : 0);

        private void ClearFloat() { _floatWidth = 0; _floatBottom = 0; }

        private void Ensure(double h)
        {
            if (_y + h <= _pageH - Margin) return;
            // Новая страница обнуляет обтекание: картинка осталась на прошлой, и держать её
            // отступ дальше значило бы сузить текст без всякой причины.
            ClearFloat();
            NewPage();
        }

        private void Draw(string text, XFont font)
        {
            var lineH = font.GetHeight() * 1.15;
            Ensure(lineH);
            _gfx.DrawString(text, font, XBrushes.Black, new XPoint(Margin, _y + font.GetHeight()));
            Note("text", Margin, _y, _gfx.MeasureString(text, font).Width, lineH, text, font.Size, font.Bold);
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

        private double SizePt(string? size, bool heading) => _scale * (size switch
        {
            "l" => heading ? 18 : 15,
            "h" => heading ? 24 : 20,
            _ => heading ? 14 : 11
        });

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
        public void Rich(List<TextRun> runs, bool isHeading, string? align = null)
        {
            // gap: перед словом стоит пробел. По этим пробелам растягивается строка при
            // выравнивании по обоим краям, поэтому куски разорванного слова, склеенные без
            // пробела, растягиванием не разъезжаются.
            var pending = new List<(string text, XFont font, XBrush brush, bool italic, double x, double w, bool gap)>();
            double x = LineLeft, lineH = 0;
            var mode = (align ?? "").Trim().ToLowerInvariant();

            // lastLine: последняя строка абзаца. По обоим краям она не растягивается, иначе
            // одно слово в конце абзаца растянулось бы во всю ширину листа.
            void Flush(bool lastLine)
            {
                if (pending.Count == 0) return;
                double h = lineH * 1.2;
                Ensure(h);
                double baseline = _y + lineH;
                var last = pending[^1];
                var left = pending[0].x;
                double lineW = last.x + last.w - left;
                double free = (LineRight - left) - lineW;
                double shift = 0, stretch = 0;
                if (free > 0)
                {
                    if (mode == "center") shift = free / 2;
                    else if (mode == "right") shift = free;
                    else if (mode == "justify" && !lastLine)
                    {
                        var gaps = 0;
                        foreach (var t in pending) if (t.gap) gaps++;
                        if (gaps > 0) stretch = free / gaps;
                    }
                }
                var passed = 0;
                foreach (var t in pending)
                {
                    if (t.gap) passed++;
                    DrawWord(t.text, t.font, t.brush, t.italic, t.x + shift + stretch * passed, baseline);
                }
                _y += h;
                pending.Clear(); x = LineLeft; lineH = 0;
            }

            foreach (var run in runs ?? new List<TextRun>())
            {
                var font = FontFor(SizePt(run.Size, isHeading), isHeading || run.Bold);
                var brush = BrushFor(run.Color);
                double space = _gfx.MeasureString(" ", font).Width;
                var segments = (run.Text ?? "").Replace("\r", "").Split('\n');
                for (int si = 0; si < segments.Length; si++)
                {
                    // Явный перенос строки заканчивает абзац: строка перед ним последняя и по
                    // обоим краям не растягивается.
                    if (si > 0) Flush(true);
                    foreach (var raw in segments[si].Split(' '))
                    {
                        if (raw.Length == 0) continue;
                        var доступно = LineRight - LineLeft;
                        var pieces = _gfx.MeasureString(raw, font).Width > доступно
                            ? BreakLongWord(raw, font, доступно)
                            : new List<string> { raw };
                        var first = true;
                        foreach (var word in pieces)
                        {
                            double ww = _gfx.MeasureString(word, font).Width;
                            // Пробел ставится только перед настоящим словом: куски одного
                            // разорванного слова склеиваются без пробела, иначе разрыв читался бы
                            // как два разных слова.
                            double sp = pending.Count > 0 && first ? space : 0;
                            if (pending.Count > 0 && x + sp + ww > LineRight) { Flush(false); sp = 0; }
                            x += sp;
                            pending.Add((word, font, brush, run.Italic, x, ww, sp > 0));
                            x += ww;
                            lineH = Math.Max(lineH, font.GetHeight());
                            first = false;
                        }
                    }
                }
            }
            Flush(true);
        }

        /// <summary>Цвет кисти в виде #rrggbb, чтобы предпросмотр совпадал с PDF по цвету тоже.</summary>
        private static string ColorName(XBrush brush)
        {
            if (brush is XSolidBrush sb)
            {
                var c = sb.Color;
                return "#" + c.R.ToString("x2") + c.G.ToString("x2") + c.B.ToString("x2");
            }
            return "#000000";
        }

        private void DrawWord(string text, XFont font, XBrush brush, bool italic, double x, double baseline)
        {
            Note("text", x, baseline - font.GetHeight(), _gfx.MeasureString(text, font).Width,
                font.GetHeight() * 1.15, text, font.Size, font.Bold, italic, ColorName(brush));
            if (!italic) { _gfx.DrawString(text, font, brush, new XPoint(x, baseline)); return; }
            var state = _gfx.Save();
            _gfx.TranslateTransform(x, baseline);
            _gfx.MultiplyTransform(new XMatrix(1, 0, -0.22, 1, 0, 0)); // shear -> right-leaning italic
            _gfx.DrawString(text, font, brush, new XPoint(0, 0));
            _gfx.Restore(state);
        }

        /// <summary>Draw a block image scaled to a percent of the content width, capped to the page.</summary>
        public void BlockImage(XImage img, int widthPct, string url = "", string? align = null,
            string? wrap = null, int wrapGap = 10)
        {
            if (img.PixelWidth <= 0 || img.PixelHeight <= 0) return;
            double pct = Math.Clamp(widthPct <= 0 ? 100 : widthPct, 10, 100) / 100.0;
            double dw = _contentW * pct;
            double dh = dw * img.PixelHeight / img.PixelWidth;
            double maxH = _pageH - 2 * Margin;
            if (dh > maxH) { double k = maxH / dh; dh *= k; dw *= k; }
            Ensure(dh + 8);
            // Печать или герб обычно стоят по центру или у правого края, поэтому картинка
            // подчиняется тому же выравниванию, что и текст. По обоим краям для картинки
            // означает по левому: растягивать её было бы искажением.
            var mode = (align ?? "").Trim().ToLowerInvariant();
            var сторона = (wrap ?? "").Trim().ToLowerInvariant();
            if (сторона is "left" or "right")
            {
                // Картинка с обтеканием не сдвигает поток вниз: она встаёт сбоку и открывает
                // вертикальный отрезок, внутри которого строки становятся уже.
                var отступ = Math.Clamp(wrapGap, 0, 60);
                double ix = сторона == "right" ? Margin + _contentW - dw : Margin;
                _gfx.DrawImage(img, ix, _y, dw, dh);
                Note("image", ix, _y, dw, dh, url);
                _floatWidth = dw + отступ;
                _floatBottom = _y + dh + 4;
                _floatRight = сторона == "right";
                return;
            }
            double free = _contentW - dw;
            double dx = free <= 0 ? 0 : mode == "center" ? free / 2 : mode == "right" ? free : 0;
            _gfx.DrawImage(img, Margin + dx, _y, dw, dh);
            Note("image", Margin + dx, _y, dw, dh, url);
            _y += dh + 8;
        }

        /// <summary>
        /// Блок подписи: заголовок, место под саму подпись и черта под ней. Высота места
        /// постоянная, а не по размеру картинки. Иначе длина документа зависела бы от того,
        /// насколько размашисто расписался человек, и раскладка в админке не совпадала бы с
        /// готовым PDF, а от неё оператор и отсчитывает координаты.
        /// </summary>
        /// <param name="label">Надпись над местом подписи, может отсутствовать.</param>
        /// <param name="img">Сама подпись. Пусто, если её ещё нет или встроить не удалось.</param>
        /// <param name="note">Что написать вместо подписи, когда её нет.</param>
        /// <param name="key">Имя поля подписи, попадает в раскладку.</param>
        public void SignatureBlock(string? label, XImage? img, string? note, string key,
            int widthPt = 0, int heightPt = 0, string? align = null)
        {
            // Размер места под подпись задаётся у самого поля, в точках. Ноль означает «как
            // всегда»: документы, собранные до появления этой настройки, выглядят как выглядели.
            double bw = widthPt > 0 ? Math.Min(Math.Clamp(widthPt, 60, 495) * _signScale, _contentW) : SignW;
            double bh = heightPt > 0 ? Math.Clamp(heightPt, 40, 300) * _signScale : SignH;
            var mode = (align ?? "").Trim().ToLowerInvariant();
            double свободно = _contentW - bw;
            double bx = Margin + (свободно <= 0 ? 0 : mode == "center" ? свободно / 2 : mode == "right" ? свободно : 0);

            double head = string.IsNullOrEmpty(label) ? 0 : H2.GetHeight() * 1.5;
            Ensure(head + bh + 12);
            if (!string.IsNullOrEmpty(label))
            {
                _gfx.DrawString(label, H2, XBrushes.Black, new XPoint(bx, _y + H2.GetHeight()));
                Note("text", bx, _y, _gfx.MeasureString(label, H2).Width, head, label, H2.Size, true);
                _y += head;
            }
            Note("sign", bx, _y, bw, bh, key);
            if (img is not null)
            {
                var (dw, dh) = FitInto(img, bw, bh);
                _gfx.DrawImage(img, bx, _y + (bh - dh) / 2, dw, dh);
            }
            else if (!string.IsNullOrEmpty(note))
            {
                _gfx.DrawString(note, Body, XBrushes.Gray, new XPoint(bx, _y + Body.GetHeight()));
            }
            _y += bh + 4;
            _gfx.DrawLine(new XPen(XColors.Gray, 0.75), bx, _y, bx + bw, _y);
            _y += 6;
        }

        private static (double W, double H) FitInto(XImage img, double boxW, double boxH)
        {
            double scale = img.PixelWidth > 0 && img.PixelHeight > 0
                ? Math.Min(boxW / img.PixelWidth, boxH / img.PixelHeight)
                : 1;
            return (img.PixelWidth * scale, img.PixelHeight * scale);
        }

        /// <summary>
        /// Печатает подпись поверх уже свёрстанной страницы, там, где её поставил оператор.
        /// Координаты приходят в долях листа, поэтому не зависят от того, в каком масштабе он
        /// смотрел макет. Вызывается последним: после этого поток дальше не пишется.
        /// </summary>
        public void StampSignature(int pageIndex, double fx, double fy, double fw, double fh, XImage img)
        {
            if (_doc.PageCount == 0) return;
            // Документ мог стать короче с тех пор, как оператор расставлял подписи. Терять
            // подпись из-за этого нельзя, поэтому она садится на последнюю страницу.
            var page = _doc.Pages[Math.Clamp(pageIndex, 0, _doc.PageCount - 1)];
            _gfx?.Dispose();
            _gfx = null!;
            using var g = XGraphics.FromPdfPage(page, XGraphicsPdfPageOptions.Append);
            double bw = page.Width.Point * fw, bh = page.Height.Point * fh;
            var (dw, dh) = FitInto(img, bw, bh);
            g.DrawImage(img, page.Width.Point * fx + (bw - dw) / 2, page.Height.Point * fy + (bh - dh) / 2, dw, dh);
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
