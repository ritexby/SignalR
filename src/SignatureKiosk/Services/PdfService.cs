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
    /// <param name="шаблон">Тот же документ до подстановки значений. По нему видно, какие теги в
    /// нём есть: раздел «Данные подписанта» печатается ровно по ним, и без него макет короче
    /// настоящего листа. Пусто означает «считать по самому doc».</param>
    /// <param name="поля">Значения тегов, те же, что придут при показе документа планшету.</param>
    public PdfLayout Layout(DocumentConfig doc, SignatureRecord? rec = null,
        DocumentConfig? шаблон = null, IReadOnlyDictionary<string, string>? поля = null)
    {
        var capture = new List<PdfLayoutItem>();
        var pdf = new PdfDocument();
        // Раздел «Данные подписанта» есть на настоящем листе, значит должен быть и в макете: по
        // макету оператор мышью расставляет подписи, и полсотни точек сдвига означают подпись не
        // там, где он её поставил, а при переходе через край листа ещё и не на том листе.
        var record = rec ?? new SignatureRecord
        {
            Id = "preview", CreatedUtc = DateTime.UtcNow, DocumentTitle = doc.Title,
            Fields = ПоляЗаписи(шаблон ?? doc, поля)
        };
        Built? built = null;
        try
        {
            built = Build(pdf, record, doc, null, null, capture);
            return new PdfLayout(built.Flow.PageWidth, built.Flow.PageHeight, built.Flow.PageCount, capture);
        }
        finally { built?.Dispose(); pdf.Dispose(); }
    }

    /// <summary>
    /// Поля подписанта так, как они окажутся в записи подписи: из присланных значений остаются
    /// только те теги, которые документ и правда использует. Отбор тот же, что при показе
    /// документа планшету (KioskCoordinator), иначе макет считался бы по другим данным, чем лист.
    /// </summary>
    private static Dictionary<string, string>? ПоляЗаписи(DocumentConfig шаблон, IReadOnlyDictionary<string, string>? поля)
    {
        if (поля is not { Count: > 0 }) return null;
        var нужные = DocumentTemplating.UsedFields(шаблон);
        var свои = new Dictionary<string, string>();
        foreach (var kv in поля) if (нужные.Contains(kv.Key)) свои[kv.Key] = kv.Value;
        return свои.Count > 0 ? свои : null;
    }

    /// <summary>Собранный документ вместе с картинками, которые нельзя освободить до сохранения.</summary>
    private sealed class Built : IDisposable
    {
        public required Flow Flow { get; init; }
        public XImage? Signature { get; init; }
        public required Dictionary<string, XImage> Images { get; init; }
        public MemoryStream? Stream { get; init; }
        /// <summary>Потоки картинок из заказа: закрываются вместе с документом, не раньше.</summary>
        public List<MemoryStream>? Streams { get; init; }
        public void Dispose()
        {
            Flow.Finish();
            Signature?.Dispose();
            foreach (var xi in Images.Values) xi.Dispose();
            Stream?.Dispose();
            foreach (var s in Streams ?? new List<MemoryStream>()) s.Dispose();
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

        // Вписанное самим клиентом печатается там, где стояло на экране, рядом с текстом, к
        // которому относится. Здесь, в начале, остаётся только то, чему места в тексте не
        // нашлось: поле со страницы, исключённой из PDF. Раньше сюда шло всё подряд, и каждое
        // заполненное поле стояло в бумаге дважды. С отметками так не делают: отдельный список в
        // конце убрали именно как повтор.
        var вМесте = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        // Вид каждого поля ввода: от него зависит, как значение печатается на бумаге. Собирается
        // со всех страниц, а не только с попавших в PDF: раздел ниже печатает как раз то, чему
        // места в тексте не нашлось, и дата в нём должна выглядеть так же, как в тексте.
        var видПоля = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var p2 in doc.Pages ?? new List<DocPage>())
        {
            if (p2 is null) continue;
            foreach (var inp in p2.Inputs ?? new List<DocInput>())
            {
                if (inp is null || string.IsNullOrWhiteSpace(inp.Key)) continue;
                видПоля[inp.Key.Trim()] = inp.Type ?? "";
                if (p2.InPdf) вМесте.Add(inp.Key.Trim());
            }
        }
        var вписано = (rec.Inputs ?? new List<SubmittedInput>())
            .Where(x => x is not null && !string.IsNullOrWhiteSpace(x.Value) && !вМесте.Contains((x.Key ?? "").Trim()))
            .ToList();
        if (вписано.Count > 0)
        {
            w.Line("Заполнено клиентом:", w.H2);
            w.Gap(3);
            foreach (var inp in вписано)
                w.Paragraph((string.IsNullOrWhiteSpace(inp.Label) ? inp.Key : inp.Label) + ": "
                    + НаБумагу(видПоля.TryGetValue((inp.Key ?? "").Trim(), out var вид) ? вид : "", inp.Value), w.Body);
            w.Gap(12);
        }

        // Images referenced by blocks must stay alive until Save (PDFsharp reads them lazily), and
        // each distinct file is decoded ONCE: the same logo repeated across a document used to be
        // decoded per block, which under concurrent signing could take hundreds of MB.
        var keepImages = new Dictionary<string, XImage>(StringComparer.Ordinal);
        // Потоки картинок, присланных заказом: живут до сохранения вместе с самими картинками.
        var keepStreams = new List<MemoryStream>();
        var imageBlocks = 0;
        // <param name="поУмолчаниюПоЦентру">
        // Блоки экрана подписи на планшете стоят по центру: поле подписи по центру, и текст
        // вокруг него тоже. В бумаге они прижимались влево, и экран расходился с листом.
        // Заданное оператором выравнивание всегда сильнее этого умолчания.
        // </param>
        void RenderBlocks(IEnumerable<DocBlock> blocks, bool поУмолчаниюПоЦентру = false)
        {
            foreach (var block in blocks)
            {
                if (block is null) continue;
                if (поУмолчаниюПоЦентру && string.IsNullOrWhiteSpace(block.Align)) block.Align = "center";
                // Блок, помеченный «не в PDF»: клиент его видел, в записи он есть, а в бумаге
                // не нужен. Пропускается только отрисовка, само содержимое никуда не девается.
                if (!block.InPdf) continue;
                if (block.Kind == "divider") { w.ClearWrap(); w.Divider(); continue; }
                if (block.Kind == "pagebreak") { w.ClearWrap(); w.PageBreak(); continue; }
                if (block.Table is not null)
                {
                    w.ClearWrap();
                    w.Table(block.Table, block.Bg, block.BorderColor, block.Pad, block.LineHeight);
                    continue;
                }
                if (block.List is "bullet" or "number" && block.Runs is { Count: > 0 })
                {
                    w.ClearWrap();
                    // Плашка, рамка и отступ у списка такие же, как у обычного текста: на планшете
                    // они рисуются, а тут вызов шёл мимо Boxed, и список на жёлтой плашке в
                    // красной рамке печатался голым.
                    var список = block;
                    w.Boxed(список, () => w.ListBlock(список.Runs, список.List == "number", список));
                    w.Gap(8);
                    continue;
                }
                if (!string.IsNullOrEmpty(block.ImageUrl))
                {
                    if (imageBlocks >= MaxImageBlocks) continue;   // bounded work per document
                    // Картинка из заказа приходит прямо в документе строкой BASE64: файла для
                    // неё нет и быть не должно, иначе запись перестала бы быть самодостаточной,
                    // а собрать PDF заново через год стало бы нечем.
                    XImage? xi;
                    string ключ;
                    if (DocumentTemplating.IsApiImage(block.ImageUrl))
                    {
                        ключ = "api:" + block.ImageUrl!.Length + ":" + block.ImageUrl!.GetHashCode();
                        if (!keepImages.TryGetValue(ключ, out xi))
                        {
                            var зпт = block.ImageUrl!.IndexOf(',');
                            if (зпт <= 0) continue;
                            byte[] байты;
                            try { байты = Convert.FromBase64String(block.ImageUrl![(зпт + 1)..]); }
                            catch (FormatException) { continue; }
                            try
                            {
                                // Поток обязан дожить до сохранения: PDFsharp читает байты
                                // лениво. Он закрывается вместе с собранным документом.
                                var поток = new MemoryStream(байты, 0, байты.Length, writable: false, publiclyVisible: true);
                                keepStreams.Add(поток);
                                xi = XImage.FromStream(поток);
                            }
                            catch (Exception ex)
                            {
                                _log?.LogWarning(ex, "Картинка из заказа не разобралась и в PDF не попала");
                                continue;
                            }
                            keepImages[ключ] = xi;
                        }
                    }
                    else
                    {
                        var file = MediaFile(block.ImageUrl);
                        if (file == null) continue;
                        ключ = file;
                        if (!keepImages.TryGetValue(file, out xi))
                        {
                            // Skip an image PDFsharp cannot decode rather than failing the whole PDF.
                            try { xi = XImage.FromFile(file); }
                            catch (Exception ex) { _log?.LogWarning(ex, "Skipping undecodable image {File} in PDF", file); continue; }
                            keepImages[file] = xi;
                        }
                    }
                    imageBlocks++;
                    // Картинка не встаёт сбоку другой картинки: две обтекаемые подряд означали бы
                    // колонку из картинок и обрывки текста между ними.
                    w.ClearWrap();
                    // В раскладку идёт не сама картинка, а её след: полотно с картинкой на
                    // мегабайт превратило бы ответ раскладки в мегабайтный же.
                    w.BlockImage(xi!, block.ImageWidth,
                        DocumentTemplating.IsApiImage(block.ImageUrl) ? "картинка из заказа"
                            : DocumentTemplating.CleanImageUrl(block.ImageUrl) ?? "",
                        block.Align, block.Wrap, block.WrapGap);
                }
                else if (block.Runs is { Count: > 0 })
                {
                    // Плашка и рамка рисуются вокруг уже готового текста: высота известна только
                    // после вёрстки, поэтому сначала считается она, потом кладётся фон под низ.
                    w.Boxed(block, () => w.Rich(block.Runs, isHeading: false, block.Align, block.LineHeight));
                    w.Gap(8);
                }
                else if (!string.IsNullOrEmpty(block.Bg) || !string.IsNullOrEmpty(block.BorderColor))
                {
                    // Блок без текста, но с плашкой или рамкой: на планшете и в наблюдении это
                    // цветная полоса, оператор ставит её как разделитель. В бумаге он пропадал
                    // вовсе, потому что до отрисовки коробки доходил только текст.
                    var пустой = block;
                    w.Boxed(пустой, () => w.Gap(10));
                    w.Gap(8);
                }
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
            // Страница, помеченная «не в PDF»: вступительный экран, пояснение, заставка. В
            // записи она остаётся целиком, в бумагу не идёт.
            if (!page.InPdf) continue;
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
                    // Поле, которому оператор задал место на листе, в потоке не печатается: оно
                    // отпечатается там, куда его поставили. Но только если подпись есть. Если
                    // клиент в нём не расписался, ставить на лист нечего, и раньше от такого поля
                    // в бумаге не оставалось ни следа: по документу не видно, что подписи ждали.
                    // В режиме раскладки настоящих подписей нет вовсе, поэтому там размещённое
                    // поле пропускается как раньше: иначе макет показывал бы лишний блок.
                    if (placed.Contains((sig.Key ?? "").Trim()) && (capture is not null || PageSignature(sig.Key) is not null)) continue;
                    w.ClearWrap();
                    w.Gap(6);
                    w.SignatureBlock(НадписьПодписи(sig.Label), PageSignature(sig.Key),
                        "Подпись в этом поле не поставлена.",
                        sig.Key ?? "", sig.Width, sig.Height, sig.Align);
                    continue;
                }
                if (kind == 4)
                {
                    // Отсканированный код печатается там, где стояло поле: клиент видел его на
                    // экране рядом с тем текстом, под которым расписался, и подписанный документ
                    // должен показывать то же самое. Раньше код в бумагу не попадал вовсе, и по
                    // ней нельзя было понять, какую пробирку человек поднёс к камере.
                    var sc = page.Scans[index];
                    w.ClearWrap();
                    var код = (rec.Scans ?? new List<SubmittedScan>())
                        .FirstOrDefault(x => x is not null && string.Equals(x.Key, sc.Key, StringComparison.OrdinalIgnoreCase))?.Code;
                    var надпись = string.IsNullOrWhiteSpace(sc.Label) ? sc.Key : sc.Label;
                    w.Rich(new List<TextRun> { new() { Text = Надпись(надпись, sc.Required) } }
                        .Concat(new[] { new TextRun { Text = string.IsNullOrWhiteSpace(код) ? "код не отсканирован" : код!, Bold = true } })
                        .ToList(), isHeading: false);
                    continue;
                }
                if (kind == 5)
                {
                    // Поле ввода печатается там, где стояло на экране: вписанное значение
                    // относится к соседнему абзацу, а собранное в конец читалось бы про другое.
                    var inp = page.Inputs[index];
                    w.ClearWrap();
                    var значение = (rec.Inputs ?? new List<SubmittedInput>())
                        .FirstOrDefault(x => x is not null && string.Equals(x.Key, inp.Key, StringComparison.OrdinalIgnoreCase))?.Value;
                    if (string.IsNullOrWhiteSpace(значение)) значение = inp.Value;
                    var подпись = string.IsNullOrWhiteSpace(inp.Label) ? inp.Key : inp.Label;
                    w.Rich(new List<TextRun> { new() { Text = Надпись(подпись, inp.Required) } }
                        .Concat(new[] { new TextRun { Text = string.IsNullOrWhiteSpace(значение)
                            ? "не заполнено" : НаБумагу(inp.Type, значение!), Bold = true } })
                        .ToList(), isHeading: false);
                    continue;
                }

                var g = page.Groups[index];
                SubmittedGroup? sg = null;
                if (!string.IsNullOrEmpty(g.Key) && groupsByKey.TryGetValue(g.Key, out var foundGroup))
                {
                    sg = foundGroup;
                    printedGroups.Add(sg);
                }
                // Что выбрано, знает только запись подписи, а как варианты выглядят, знает только
                // документ, который показали клиенту: в нём у вариантов есть куски оформления, а
                // в записи лежат имя и простой текст. Пока варианты брались из записи, выделенный
                // цветом или жирным вариант печатался на листе обычным чёрным, и подписанная
                // бумага выглядела не так, как экран, под которым человек расписался.
                RenderGroup(g.Title, g.Required, sg?.Selected ?? g.Selected,
                    g.Options is { Count: > 0 } ? g.Options : (sg?.Options ?? new List<DocGroupOption>()),
                    sg?.SelectedLabel, g.TitleRuns);
            }
        }

        // Всё, что есть в записи, но чему не нашлось места в документе, всё равно должно попасть
        // в PDF: запись подписи это то, с чем человек согласился, и терять из неё нельзя ничего.
        var leftoverItems = (rec.Items ?? new List<SubmittedItem>())
            .Where(i => i is not null && !printedItems.Contains(i)).ToList();
        if (leftoverItems.Count > 0)
        {
            // Документ мог закончиться обтекаемой картинкой: без спуска ниже неё этот раздел
            // печатался бы прямо поверх.
            w.ClearWrap();
            w.Gap(4);
            w.Line("Отмеченные пункты:", w.H2);
            w.Gap(3);
            foreach (var it in leftoverItems)
                w.Paragraph((it.Checked ? "[X]  " : "[  ]  ") + (it.Label ?? ""), w.Body);
        }
        foreach (var g in (rec.Groups ?? new List<SubmittedGroup>()).Where(g => g is not null && !printedGroups.Contains(g)))
            RenderGroup(g.Title, false, g.Selected, g.Options ?? new List<DocGroupOption>(), g.SelectedLabel);

        // Custom signature-page content authored in the admin, above the signature.
        if (doc.SignBlocks is { Count: > 0 }) { w.Gap(6); RenderBlocks(doc.SignBlocks, поУмолчаниюПоЦентру: true); }

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
            // Надпись над местом подписи одна и та же в обоих случаях: клиент читал её на планшете
            // перед росчерком, и от того, удалось ли вложить картинку, она не зависит.
            var надпись = НадписьИтоговойПодписи(doc);
            if (брак)
            {
                // Полтора интервала тут ни к чему: под надписью не место под росчерк, а обычный
                // абзац, и раньше эта строка печаталась таким же обычным Line. Мерка тоже как у
                // Line: доля высоты шрифта, а не кегля, иначе строка встала бы не туда, где была.
                w.Rich(надпись, isHeading: true, align: null, доляВысотыШрифта: 1.15);
                w.Gap(3);
                w.Paragraph("Изображение подписи не удалось встроить в PDF. Оригинал подписи сохранён в записи и доступен в админке.", w.Body);
            }
            else w.SignatureBlock(надпись, img, null, "");
        }

        // Content the admin placed under the signature (company details, a stamp, a note).
        if (doc.SignBlocksBelow is { Count: > 0 }) { w.Gap(10); RenderBlocks(doc.SignBlocksBelow, поУмолчаниюПоЦентру: true); }

        // Размещённые подписи печатаются в самом конце: страницы к этому моменту свёрстаны, и
        // номер страницы, на который указывает раскладка, уже что-то значит.
        if (capture is null)
            foreach (var pl in doc.SignaturePlacements ?? new List<SignaturePlacement>())
            {
                var key = (pl.Key ?? "").Trim();
                var stamp = key.Length == 0 ? img : PageSignature(key);
                if (stamp is not null) w.StampSignature(pl.Page, pl.X, pl.Y, pl.W, pl.H, stamp);
            }

        // Колонтитул последним: к этому моменту страницы свёрстаны и их число известно. В
        // раскладке его нет: она показывает поток, а колонтитул к потоку не относится.
        // Плашки перед колонтитулом: обе операции отпускают холст страницы, и порядок между
        // ними значения не имеет, но обе обязаны идти после конца потока.
        if (capture is null) w.FlushBoxes();
        if (capture is null)
            w.Footer(doc.PdfFooterTitle ? doc.Title : null,
                // Номер нужен обоим: и строке «Запись ...», и штрихкоду. Печатать ли саму строку,
                // решает отдельный признак: раньше включённый штрихкод дописывал её сам.
                rec.Id,
                doc.PdfPageNumbers, doc.PdfFooterBarcode, doc.PdfFooterRecordId);

        return new Built { Flow = w, Signature = img, Images = keepImages, Stream = ms, Streams = keepStreams };
    }

    /// <summary>Всегдашняя надпись над местом итоговой подписи, когда своей у оператора нет.</summary>
    private const string НадписьПоУмолчанию = "Подпись клиента:";

    /// <summary>
    /// Подсказка над полем подписи, какой она стоит в документе, которого оператор не трогал.
    /// Берётся из самой модели, а не переписывается сюда строкой: два одинаковых текста в разных
    /// файлах разъезжаются при первой же правке одного из них.
    /// </summary>
    private static readonly string СтандартнаяПодсказка = (new DocumentConfig().SignPrompt ?? "").Trim();

    /// <summary>
    /// Что напечатать над местом итоговой подписи. Текст задаёт оператор в карточке «Страница
    /// подписи» («Текст над полем подписи»), клиент читает его на планшете прямо перед росчерком,
    /// и в подписанной бумаге обязано стоять то же самое: карточка редактора обещает ровно это про
    /// всю страницу подписи, а блоки над полем и под ним туда и попадали. Сама подсказка не
    /// попадала никогда: в PDF уходила жёсткая надпись, и заданный оператором текст пропадал.
    /// Теги в подсказке уже подставлены: сюда приходит документ, разобранный
    /// DocumentTemplating.Resolve, тот же самый, что уехал на планшет.
    /// </summary>
    private static List<TextRun> НадписьИтоговойПодписи(DocumentConfig doc)
    {
        var свой = (doc.SignPrompt ?? "").Trim();
        // Пусто или нетронутая подсказка планшета означает, что своего текста оператор не писал.
        // Пустое место вместо надписи было бы хуже жёсткой: по листу не видно, чья это подпись.
        // Стандартная подсказка на бумаге тоже не к месту: она просит расписаться, а подписанный
        // лист уже никого ни о чём не просит, и в бумаге у этого места своя всегдашняя надпись.
        var текст = свой.Length == 0 || string.Equals(свой, СтандартнаяПодсказка, StringComparison.Ordinal)
            ? НадписьПоУмолчанию : свой;
        return НадписьПодписи(текст);
    }

    /// <summary>
    /// Надпись над местом подписи оформленными кусками: так её печатает Flow.SignatureBlock, теми
    /// же мерками, что и подписи остальных элементов страницы (перенос по ширине листа, жирный,
    /// размер, цвет куска). Размер по умолчанию тот же, каким такие надписи печатались всегда
    /// (H2, тринадцать пунктов): оператор задаёт текст, а не кегль, и менять кегль без его ведома
    /// незачем. Свой размер куска, когда он задан, сильнее умолчания.
    /// Сейчас и подсказка подписи, и надпись поля подписи хранятся простым текстом, поэтому кусок
    /// получается один; оформление живёт в пути печати, а не здесь, и появится на бумаге само,
    /// как только его станет чем задавать.
    /// </summary>
    private static List<TextRun> НадписьПодписи(string? текст)
    {
        var готово = new List<TextRun>();
        foreach (var r in DocumentTemplating.LabelRuns(null, текст))
        {
            if (r is null || string.IsNullOrEmpty(r.Text)) continue;
            готово.Add(new TextRun
            {
                Text = r.Text, Bold = r.Bold, Italic = r.Italic, Color = r.Color, Mark = r.Mark,
                Size = r.Size,
                SizePt = r.SizePt > 0 || !string.IsNullOrEmpty(r.Size) ? r.SizePt : Flow.РазмерH2
            });
        }
        return готово;
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

    /// <summary>
    /// Надпись поля вместе с двоеточием: «ПОЛЕ: » или «ПОЛЕ *: ». Звёздочка обязательности стоит
    /// при самой надписи, до двоеточия, ровно как на планшете: kiosk.js кладёт её внутрь надписи,
    /// а двоеточия там нет вовсе. Дописанная в конец всей надписи, она вставала между двоеточием
    /// и значением и читалась первым знаком того, что вписал клиент.
    /// </summary>
    private static string Надпись(string? label, bool required) => (label ?? "") + (required ? " *: " : ": ");

    /// <summary>
    /// Значение поля ввода так, как оно печатается на бумаге. Поле вида «дата» на планшете держит
    /// значение только машинным yyyy-MM-dd: другого input[type=date] не примет, и клиенту оно
    /// показывается по-человечески самим браузером. Документ русский, и на листе дата обязана
    /// быть дд.мм.гггг, иначе одна и та же дата стоит на нём в двух видах: подставленная тегом
    /// по-человечески и вписанная в поле машинным. В самой записи значение не меняется: она
    /// уходит в другие системы, и подменять в ней нечего.
    /// Переводится только вид «дата» и только то, что и правда дата: всё прочее как есть.
    /// </summary>
    private static string НаБумагу(string? type, string? значение)
    {
        var текст = значение ?? "";
        if (!string.Equals((type ?? "").Trim(), "date", StringComparison.OrdinalIgnoreCase)) return текст;
        return DateTime.TryParseExact(текст.Trim(), "yyyy-MM-dd",
            System.Globalization.CultureInfo.InvariantCulture,
            System.Globalization.DateTimeStyles.None, out var д)
            ? д.ToString("dd.MM.yyyy", System.Globalization.CultureInfo.InvariantCulture)
            : текст;
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

        // Серый на бумаге ведёт себя не так, как на экране: лист копируют, сканируют и подшивают,
        // и светлая линия после второй копии исчезает вовсе. Поэтому у документа два серых:
        // один для подписей колонтитула и пояснений, второй для черт и рамок, и оба заметно
        // темнее того, что раньше стояло по умолчанию.
        private static readonly XBrush ТусклыйТекст = new XSolidBrush(XColor.FromArgb(89, 89, 89));
        private static readonly XColor ЛинияЧерты = XColor.FromArgb(128, 128, 128);
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

        /// <param name="page">Лист, на котором нарисовано. Минус один означает текущий. Явный
        /// номер нужен коробке блока: её кусок может относиться к листу, уже законченному к тому
        /// времени, когда высота куска стала известна.</param>
        private void Note(string kind, double x, double y, double w, double h,
            string text = "", double size = 0, bool bold = false, bool italic = false, string color = "",
            int page = -1)
        {
            Capture?.Add(new PdfLayoutItem(page < 0 ? _pageIndex : page, kind, x, y, w, h, text, size, bold, italic, color));
        }

        public readonly XFont H1;
        public readonly XFont H2;
        public readonly XFont Body;
        public readonly XFont Small;

        /// <summary>
        /// Кегль H2 в пунктах, до поправки на общий масштаб документа. Вынесен из создания шрифта
        /// затем, что этим же кеглем печатаются надписи над местами подписи, а собираются они
        /// кусками текста снаружи Flow: два числа в двух местах разъехались бы при первой правке.
        /// </summary>
        public const int РазмерH2 = 13;

        /// <summary>
        /// Межстрочный надписи над местом подписи. Ровно столько занимала прежняя однострочная
        /// надпись (высота шрифта на полтора), и короткая надпись обязана остаться там же, где
        /// стояла: по этому месту оператор мышью расставляет подписи на листах.
        /// </summary>
        private const double МежстрочныйНадписи = 1.5;

        /// <summary>
        /// Межстрочный абзаца, которому оператор своего не задал. Ровно тот же, что на планшете
        /// (--doc-line: 1.45), и той же меркой: доля кегля, а не высоты шрифта.
        /// </summary>
        private const double ОбычныйМежстрочный = 1.45;

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
            H2 = new XFont("DejaVu", РазмерH2 * _scale, XFontStyleEx.Bold);
            Body = new XFont("DejaVu", 11 * _scale, XFontStyleEx.Regular);
            Small = new XFont("DejaVu", 9 * _scale, XFontStyleEx.Regular);
            NewPage();
        }

        private void NewPage()
        {
            // Блок с плашкой мог не поместиться на лист. Коробка через разрыв не рисуется одним
            // прямоугольником, поэтому здесь закрывается её кусок на уходящем листе, а на новом
            // она продолжится от верхнего поля. Раньше Boxed в этом случае выходил не нарисовав
            // ничего, и у разорванного блока плашка пропадала на всех листах разом.
            if (_boxTop is not null)
            {
                _boxParts.Add((_pageIndex, _boxTop.Value, _pageH - Margin));
                _boxTop = Margin;
            }
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

        /// <summary>
        /// Колонтитул внизу каждой страницы. Рисуется в самом конце: раньше число страниц ещё
        /// неизвестно, и «страница 2 из ?» пришлось бы дописывать задним числом.
        /// Штрихкод это Code 39 из номера записи: рисуется полосками прямо здесь, потому что
        /// заводить ради него библиотеку значит тянуть зависимость ради десяти строк.
        /// </summary>
        /// <param name="recordId">Номер записи. Нужен и строке «Запись ...», и штрихкоду.</param>
        /// <param name="showRecordId">Печатать ли саму строку «Запись ...». Это отдельный признак
        /// от штрихкода, и в админке они тоже отдельные: включённый штрихкод не должен сам
        /// дописывать текстовую строку.</param>
        public void Footer(string? title, string? recordId, bool numbers, bool barcode, bool showRecordId)
        {
            var строкаЗаписи = showRecordId && !string.IsNullOrEmpty(recordId);
            if (!numbers && string.IsNullOrEmpty(title) && !строкаЗаписи && !barcode) return;
            _gfx?.Dispose();
            _gfx = null!;
            var всего = _doc.PageCount;
            for (var i = 0; i < всего; i++)
            {
                var page = _doc.Pages[i];
                using var g = XGraphics.FromPdfPage(page, XGraphicsPdfPageOptions.Append);
                var y = page.Height.Point - Margin + 14;
                // Номер страницы у правого поля печатается первым: он задаёт, сколько ширины
                // остаётся левой части. Раньше слева рисовалась одна строка без переноса и без
                // обрезки, и длинное название уезжало под номер страницы и за край листа, унося
                // с собой номер записи.
                double шНомера = 0;
                if (numbers)
                {
                    var текст = "Страница " + (i + 1) + " из " + всего;
                    шНомера = g.MeasureString(текст, Small).Width;
                    g.DrawString(текст, Small, ТусклыйТекст, new XPoint(Margin + _contentW - шНомера, y));
                }
                // Слева всегда целиком помещается номер записи: по нему бумагу опознают, и терять
                // его нельзя. Урезается только название, и то с многоточием, чтобы было видно,
                // что оно урезано.
                var запись = строкаЗаписи ? "Запись " + recordId : "";
                var свободно = _contentW - (numbers ? шНомера + 12 : 0);
                var слева = запись;
                if (!string.IsNullOrEmpty(title))
                {
                    var подЗапись = запись.Length == 0 ? 0 : g.MeasureString("     " + запись, Small).Width;
                    var имя = Урезать(g, title!, Small, свободно - подЗапись);
                    if (имя.Length > 0) слева = запись.Length == 0 ? имя : имя + "     " + запись;
                }
                if (слева.Length > 0)
                    g.DrawString(слева, Small, ТусклыйТекст, new XPoint(Margin, y));
                if (barcode && !string.IsNullOrEmpty(recordId))
                    DrawCode39(g, recordId!, Margin, y + 4, _contentW / 2, 18);
            }
        }

        /// <summary>
        /// Урезать строку по ширине, дописав многоточие. Пустой ответ означает, что не поместилось
        /// даже само многоточие, и печатать нечего. Место ищется двоичным поиском: название может
        /// прийти по API длиной в тысячи знаков, и мерить его по знаку было бы тысячей замеров на
        /// каждую страницу.
        /// </summary>
        private static string Урезать(XGraphics g, string text, XFont font, double maxW)
        {
            if (string.IsNullOrEmpty(text) || maxW <= 0) return "";
            if (g.MeasureString(text, font).Width <= maxW) return text;
            const string многоточие = "...";
            if (g.MeasureString(многоточие, font).Width > maxW) return "";
            int низ = 0, верх = text.Length;
            while (низ < верх)
            {
                var середина = (низ + верх + 1) / 2;
                if (g.MeasureString(text[..середина] + многоточие, font).Width <= maxW) низ = середина;
                else верх = середина - 1;
            }
            // Половина суррогатной пары это не знак: обрезать по ней значит получить в бумаге
            // вопросительный ромб вместо буквы.
            if (низ > 0 && char.IsHighSurrogate(text[низ - 1])) низ--;
            return низ == 0 ? "" : text[..низ].TrimEnd() + многоточие;
        }

        /// <summary>
        /// Code 39: каждый знак это девять полос, пять чёрных и четыре белых, из которых три
        /// широкие. Кодировка задана таблицей ширин, где 0 узкая полоса, 1 широкая. Начало и
        /// конец помечаются знаком «звёздочка», как того требует сам код.
        /// </summary>
        private static void DrawCode39(XGraphics g, string text, double x, double y, double maxW, double h)
        {
            const string алфавит = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-. $/+%*";
            string[] коды =
            {
                "000110100", "100100001", "001100001", "101100000", "000110001", "100110000", "001110000",
                "000100101", "100100100", "001100100", "100001001", "001001001", "101001000", "000011001",
                "100011000", "001011000", "000001101", "100001100", "001001100", "000011100", "100000011",
                "001000011", "101000010", "000010011", "100010010", "001010010", "000000111", "100000110",
                "001000110", "000010110", "110000001", "011000001", "111000000", "010010001", "110010000",
                // Дальше идут «-», «.», пробел, «$», «/», «+», «%» и «звёздочка». Прежде на месте
                // точки стоял узор буквы W, и вся хвостовая часть таблицы сдвигалась на знак, а
                // звёздочка не помещалась вовсе. Штрихкод рисовался без символов начала и конца,
                // то есть выглядел штрихкодом, но не читался ни одним сканером.
                "011010000", "010000101", "110000100", "011000100", "010101000", "010100010", "010001010",
                "000101010", "010010100"
            };
            var знаки = "*" + new string(text.ToUpperInvariant().Where(c => алфавит.IndexOf(c) >= 0).ToArray()) + "*";
            // Ширина одного модуля: узкая полоса. В знаке девять элементов: три широких по три
            // модуля и шесть узких по одному, всего пятнадцать, плюс модуль межзнакового
            // пробела, итого шестнадцать. Стояло тринадцать, и полоса выходила примерно в 1,23
            // раза шире отведённого места: в колонтитул она по замыслу не помещалась.
            var модулей = знаки.Length * 16.0;
            var m = Math.Min(1.2, maxW / модулей);
            if (m <= 0.1) return;
            var cx = x;
            foreach (var ch in знаки)
            {
                var idx = алфавит.IndexOf(ch);
                if (idx < 0 || idx >= коды.Length) continue;
                var код = коды[idx];
                for (var i = 0; i < код.Length; i++)
                {
                    var w = (код[i] == '1' ? 3 : 1) * m;
                    if (i % 2 == 0) g.DrawRectangle(XBrushes.Black, cx, y, w, h);
                    cx += w;
                }
                cx += m;   // разделитель между знаками
            }
        }

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
        // Внутренний отступ блока с плашкой: строка становится уже с обеих сторон, ровно как на
        // экране. Без него отступ был только сверху и снизу, а текст ломался в других местах.
        private double _boxPad;
        private double LineLeft => (FloatActive && !_floatRight ? Margin + _floatWidth : Margin) + _listIndent + _boxPad;
        /// <summary>Правая граница строки на текущей высоте.</summary>
        private double LineRight => Margin + _contentW - (FloatActive && _floatRight ? _floatWidth : 0) - _boxPad;

        /// <summary>С какого y рисовать коробку блока на текущем листе. null означает, что
        /// коробка сейчас не строится. Блока внутри блока не бывает, поэтому хватает одного
        /// слоя без стопки.</summary>
        private double? _boxTop;
        /// <summary>Куски коробки по листам: содержимое блока могло не поместиться на один.</summary>
        private readonly List<(int Page, double Top, double Bottom)> _boxParts = new();

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
        /// <summary>
        /// Строка текста с переносом. Раньше здесь была одна строка без переноса, и заголовок
        /// документа длиннее полусотни знаков уезжал за правое поле и обрезался краем листа.
        /// Ширина текста на A4 это 495 точек, то есть примерно 50 знаков заголовком в 18 пунктов.
        /// </summary>
        public void Line(string text, XFont font) => Paragraph(text ?? "", font);

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

        /// <summary>
        /// Размер куска текста. Свой размер в точках, если он задан, иначе ступень. Точки те же,
        /// что в редакторе: на бумаге получается ровно то, что оператор задал, с поправкой на
        /// общий масштаб документа.
        /// Масштаб шрифта документа (50..100 %) применяется и к своему размеру куска, и это
        /// осознанный выбор, а не недосмотр. Иначе при 50 % весь документ мельчает, а кусок в
        /// сорок пунктов остаётся сорока пунктами и рвёт вёрстку: масштаб затем и задан, чтобы
        /// документ уложился в меньшее число листов, а кусок, не слушающийся его, эту работу
        /// сводит на нет. Планшет считает так же: свой размер куска там тоже умножается на
        /// общий множитель, и экран с бумагой не расходятся.
        /// </summary>
        private double RunSize(TextRun run, bool heading) =>
            run.SizePt > 0 ? _scale * Math.Clamp(run.SizePt, 8, 40) : SizePt(run.Size, heading);

        /// <summary>Цвет выделения маркером или null, если выделения нет.</summary>
        private static XBrush? MarkBrush(string? mark)
        {
            if (string.IsNullOrEmpty(mark) || mark.Length != 7 || mark[0] != '#') return null;
            if (!int.TryParse(mark.AsSpan(1, 2), System.Globalization.NumberStyles.HexNumber, null, out var r)) return null;
            if (!int.TryParse(mark.AsSpan(3, 2), System.Globalization.NumberStyles.HexNumber, null, out var g)) return null;
            if (!int.TryParse(mark.AsSpan(5, 2), System.Globalization.NumberStyles.HexNumber, null, out var b)) return null;
            return new XSolidBrush(XColor.FromArgb(r, g, b));
        }

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
        /// <param name="lineHeightPct">Межстрочный интервал блока в процентах, как его задал
        /// оператор. Это доля КЕГЛЯ, ровно как unitless line-height на планшете.</param>
        /// <param name="доляВысотыШрифта">Межстрочный долей высоты шрифта. Не то же самое, что
        /// проценты: этой меркой считалось место под надписью над полем подписи, и она обязана
        /// остаться прежней, иначе расставленные оператором подписи съедут по листу.</param>
        public void Rich(List<TextRun> runs, bool isHeading, string? align = null, int lineHeightPct = 0,
            double доляВысотыШрифта = 0)
        {
            // Межстрочный интервал блока в процентах. На планшете он применяется, в бумаге его
            // не передавали вовсе, и абзац с интервалом 200 % на экране был просторным, а на
            // листе обычным.
            // По умолчанию тот же интервал, что на планшете (--doc-line: 1.45). Раньше здесь стояло
            // 1.2, и один и тот же абзац на экране был просторнее, чем на бумаге.
            // Считается он от кегля, а не от высоты шрифта: unitless line-height в браузере это
            // доля кегля, и 250 % при кегле 11 пт обязаны дать 27.5 пт и на экране, и на бумаге.
            // Через высоту шрифта выходило 32 пт, то есть 2.91 кегля вместо 2.5, а обычный абзац
            // шёл на 17 % просторнее экрана. Два основания в одной формуле держать нельзя ещё и
            // потому, что тогда «250 %» оказывалось меньше полутора обычных шагов.
            var доляКегля = lineHeightPct > 0 ? Math.Clamp(lineHeightPct, 100, 250) / 100.0
                : доляВысотыШрифта > 0 ? 0 : ОбычныйМежстрочный;
            // Шаг строки: кегль самого крупного куска на строке на долю, либо высота его шрифта
            // на долю там, где место считалось по высоте.
            double Шаг(double кегль, double высотаШрифта) =>
                доляКегля > 0 ? кегль * доляКегля : высотаШрифта * доляВысотыШрифта;
            // Заголовок в самом низу листа отрывается от того, что он озаглавливает. Если под ним
            // не осталось места хотя бы на три строки текста, он уезжает на следующую страницу
            // вместе со своим разделом.
            if (isHeading && runs is { Count: > 0 })
            {
                // Резерв считается по тем самым числам, какими заголовок и текст будут напечатаны.
                // Высота строки заголовка это высота его собственного шрифта: он рисуется
                // четырнадцатью пунктами, а не размером H2 (тринадцать), и своим размером куска
                // может быть куда крупнее. Межстрочный тоже настоящий, а не 1,15 и 1,2, и берётся
                // тем же Шагом, каким строка потом и ляжет на лист.
                double высотаЗаголовка = 0, кегльЗаголовка = 0;
                foreach (var r in runs)
                    if (r is not null)
                    {
                        var шрифт = FontFor(RunSize(r, true), true);
                        высотаЗаголовка = Math.Max(высотаЗаголовка, шрифт.GetHeight());
                        кегльЗаголовка = Math.Max(кегльЗаголовка, шрифт.Size);
                    }
                if (высотаЗаголовка <= 0)
                {
                    var шрифт = FontFor(SizePt(null, true), true);
                    высотаЗаголовка = шрифт.GetHeight();
                    кегльЗаголовка = шрифт.Size;
                }
                // Три точки это отбивка, которая в потоке всегда идёт сразу за заголовком: два
                // пункта у заголовка страницы и три у заголовка группы. Без неё резерв оказался бы
                // на волос меньше нужного, и обещание «хотя бы три строки» опять не выполнялось бы.
                var нужно = Шаг(кегльЗаголовка, высотаЗаголовка) + 3 + Body.Size * ОбычныйМежстрочный * 3;
                if (_y > Margin && _y + нужно > _pageH - Margin) { ClearFloat(); NewPage(); }
            }
            // gap: перед словом стоит пробел. По этим пробелам растягивается строка при
            // выравнивании по обоим краям, поэтому куски разорванного слова, склеенные без
            // пробела, растягиванием не разъезжаются.
            var pending = new List<(string text, XFont font, XBrush brush, bool italic, double x, double w, bool gap, XBrush? mark)>();
            // lineH: высота шрифта самого высокого куска строки. lineSize: его же кегль. Шаг
            // считается по кеглю, а место под буквы по высоте, поэтому нужны оба числа.
            double x = LineLeft, lineH = 0, lineSize = 0;
            var mode = (align ?? "").Trim().ToLowerInvariant();

            // lastLine: последняя строка абзаца. По обоим краям она не растягивается, иначе
            // одно слово в конце абзаца растянулось бы во всю ширину листа.
            void Flush(bool lastLine)
            {
                if (pending.Count == 0) return;
                double h = Шаг(lineSize, lineH);
                Ensure(h);
                // Строка могла уехать на новую страницу изнутри обтекания: картинка осталась на
                // прошлой, и её отступ здесь уже ничего не обтекает. Слова собраны со старым
                // отступом, поэтому строка сдвигается к текущей левой границе целиком.
                var сдвигВлево = pending[0].x - LineLeft;
                if (сдвигВлево > 0)
                    for (var i = 0; i < pending.Count; i++)
                        pending[i] = pending[i] with { x = pending[i].x - сдвигВлево };
                // Место сверх обычного шага делится поровну над строкой и под ней, как половинный
                // интерлиньяж в браузере. Иначе разреженный блок весь съезжал бы к своей первой
                // строке: буквы жались бы к верху высокой строки, а пустота копилась под ними.
                // Считается только заданный оператором интервал: обычный абзац и надписи, место
                // под которые считалось отдельно, обязаны лечь ровно туда же, где лежали.
                double лишнее = lineHeightPct > 0 ? h - lineSize * ОбычныйМежстрочный : 0;
                double baseline = _y + lineH + (лишнее > 0 ? лишнее / 2 : 0);
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
                // Выделение маркером рисуется до слов и по всей строке сразу: иначе полоса
                // ложилась бы поверх букв и закрывала их.
                var прошло = 0;
                foreach (var t in pending)
                {
                    if (t.gap) прошло++;
                    if (t.mark is null) continue;
                    var мx = t.x + shift + stretch * прошло;
                    // Полоса чуть шире слова и захватывает пробел перед ним: иначе выделенная
                    // фраза выглядит как набор отдельных прямоугольников.
                    var слева = t.gap ? мx - _gfx.MeasureString(" ", t.font).Width : мx;
                    var полоса = new XRect(слева, baseline - t.font.GetHeight() * 0.85,
                        (мx - слева) + t.w, t.font.GetHeight() * 1.05);
                    _gfx.DrawRectangle(t.mark, полоса);
                    // Маркер идёт в раскладку своим видом: раскладка это опись всего, что легло
                    // на лист, и несообщённое для всякого её читателя просто не существует.
                    var цветМаркера = ColorName(t.mark);
                    Note("mark", полоса.X, полоса.Y, полоса.Width, полоса.Height,
                        цветМаркера, color: цветМаркера);
                }
                foreach (var t in pending)
                {
                    if (t.gap) passed++;
                    DrawWord(t.text, t.font, t.brush, t.italic, t.x + shift + stretch * passed, baseline);
                }
                _y += h;
                pending.Clear(); x = LineLeft; lineH = 0; lineSize = 0;
            }

            // Пробел, увиденный в тексте, но ещё не поставленный: он остаётся от конца куска, от
            // начала следующего и от двух пробелов подряд. Живёт через все куски строки, потому
            // что стык кусков это такое же место в тексте, как любое другое.
            var ждётПробел = false;
            foreach (var run in runs ?? new List<TextRun>())
            {
                var font = FontFor(RunSize(run, isHeading), isHeading || run.Bold);
                var brush = BrushFor(run.Color);
                var mark = MarkBrush(run.Mark);
                double space = _gfx.MeasureString(" ", font).Width;
                var segments = (run.Text ?? "").Replace("\r", "").Split('\n');
                for (int si = 0; si < segments.Length; si++)
                {
                    // Явный перенос строки заканчивает абзац: строка перед ним последняя и по
                    // обоим краям не растягивается.
                    if (si > 0) Flush(true);
                    var слова = segments[si].Split(' ');
                    for (var wi = 0; wi < слова.Length; wi++)
                    {
                        var raw = слова[wi];
                        // Пустой кусок разбиения это и есть пробел: он остаётся от начала строки,
                        // от её конца и от двух пробелов подряд. Само слово его не несёт, поэтому
                        // пробел запоминается и ставится перед следующим настоящим словом.
                        if (raw.Length == 0) { ждётПробел = true; continue; }
                        // Пробел перед словом ставится, только если он в тексте и был. Внутри
                        // одного куска соседние слова разделены пробелом всегда, а на стыке кусков
                        // его может не быть вовсе: на планшете куски это соседние span, и «СЛИТНОЕ»
                        // с «СЛОВО» читаются одним словом. Раньше пробел ставился на каждом стыке,
                        // и бумага расходилась с экраном: слова разъезжались, а запятая после
                        // выделенного куска отрывалась от него.
                        var нуженПробел = wi > 0 || ждётПробел;
                        ждётПробел = false;
                        var доступно = LineRight - LineLeft;
                        var pieces = _gfx.MeasureString(raw, font).Width > доступно
                            ? BreakLongWord(raw, font, доступно)
                            : new List<string> { raw };
                        var first = true;
                        foreach (var word in pieces)
                        {
                            double ww = _gfx.MeasureString(word, font).Width;
                            // Куски одного разорванного слова склеиваются без пробела, иначе
                            // разрыв читался бы как два разных слова.
                            double sp = pending.Count > 0 && first && нуженПробел ? space : 0;
                            if (pending.Count > 0 && x + sp + ww > LineRight) { Flush(false); sp = 0; }
                            x += sp;
                            pending.Add((word, font, brush, run.Italic, x, ww, sp > 0, mark));
                            x += ww;
                            lineH = Math.Max(lineH, font.GetHeight());
                            lineSize = Math.Max(lineSize, font.Size);
                            first = false;
                        }
                    }
                }
            }
            Flush(true);
        }

        /// <summary>
        /// Сколько по высоте займут куски текста, если напечатать их сейчас через Rich заголовком.
        /// Нужно там, где место резервируется заранее и целиком: у подписи надпись и поле под
        /// росчерк обязаны попасть на один лист, а узнать высоту надписи можно только посчитав
        /// перенос. Мерки те же самые, что и при печати: ширина строки, разрыв длинного слова,
        /// пробел на стыке кусков. Разойтись они могут только если поменять перенос в Rich и
        /// забыть про этот счёт, и тогда цена ошибки одна: лист переломится строкой раньше или
        /// позже, чем нужно. Сам поток идёт по настоящему _y, который двигает Rich, поэтому
        /// накопиться расхождение не может.
        /// </summary>
        private double ВысотаКусков(List<TextRun> runs, double межстрочный)
        {
            double доступно = LineRight - LineLeft;
            double x = 0, lineH = 0, всего = 0;
            var ждётПробел = false;
            foreach (var run in runs)
            {
                var font = FontFor(RunSize(run, true), true);
                double space = _gfx.MeasureString(" ", font).Width;
                var segments = (run.Text ?? "").Replace("\r", "").Split('\n');
                for (var si = 0; si < segments.Length; si++)
                {
                    // Явный перенос строки заканчивает строку, даже если на ней ещё есть место.
                    if (si > 0) { всего += lineH * межстрочный; x = 0; lineH = 0; }
                    var слова = segments[si].Split(' ');
                    for (var wi = 0; wi < слова.Length; wi++)
                    {
                        var raw = слова[wi];
                        if (raw.Length == 0) { ждётПробел = true; continue; }
                        var нуженПробел = wi > 0 || ждётПробел;
                        ждётПробел = false;
                        var pieces = _gfx.MeasureString(raw, font).Width > доступно
                            ? BreakLongWord(raw, font, доступно)
                            : new List<string> { raw };
                        var first = true;
                        foreach (var word in pieces)
                        {
                            double ww = _gfx.MeasureString(word, font).Width;
                            double sp = x > 0 && first && нуженПробел ? space : 0;
                            if (x > 0 && x + sp + ww > доступно) { всего += lineH * межстрочный; x = 0; lineH = 0; sp = 0; }
                            x += sp + ww;
                            lineH = Math.Max(lineH, font.GetHeight());
                            first = false;
                        }
                    }
                }
            }
            if (lineH > 0) всего += lineH * межстрочный;
            return всего;
        }

        /// <summary>Цвет в виде #rrggbb, чтобы предпросмотр совпадал с PDF по цвету тоже.</summary>
        private static string HexOf(XColor c) => "#" + c.R.ToString("x2") + c.G.ToString("x2") + c.B.ToString("x2");

        /// <summary>Цвет кисти в виде #rrggbb.</summary>
        private static string ColorName(XBrush brush) => brush is XSolidBrush sb ? HexOf(sb.Color) : "#000000";

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

        /// <summary>Горизонтальная черта во всю ширину текста.</summary>
        public void Divider()
        {
            Ensure(14);
            _y += 6;
            _gfx.DrawLine(new XPen(ЛинияЧерты, 0.75), Margin, _y, Margin + _contentW, _y);
            Note("divider", Margin, _y, _contentW, 1);
            _y += 8;
        }

        /// <summary>Начать новую страницу принудительно. На пустой странице ничего не делает,
        /// иначе разрыв в начале документа давал бы пустой первый лист.</summary>
        public void PageBreak()
        {
            if (_y <= Margin + 0.5) return;
            NewPage();
        }

        /// <summary>
        /// Отложить текущее место: сюда потом ляжет плашка или рамка. Высота становится известна
        /// только после вёрстки содержимого, поэтому фон рисуется задним числом, под уже
        /// напечатанным. PDF это позволяет: порядок рисования решает, что окажется сверху, и
        /// фон, положенный позже, накрыл бы текст, поэтому он кладётся на отдельном слое ниже.
        /// </summary>
        public void Boxed(DocBlock b, Action content)
        {
            var pad = Math.Clamp(b.Pad, 0, 40);
            var есть = !string.IsNullOrEmpty(b.Bg) || !string.IsNullOrEmpty(b.BorderColor);
            var сверху = _y;
            _boxParts.Clear();
            // Коробка отслеживается с самого начала: содержимое может уйти на следующий лист, и
            // тогда на каждом листе ей достанется свой кусок. Раньше в этом случае Boxed выходил
            // не нарисовав ничего, и у длинного блока плашка пропадала целиком.
            if (есть) _boxTop = сверху;
            _y += pad;
            var былОтступ = _boxPad;
            // Отступ действует и без плашки, и без рамки: на планшете padding сдвигает текст сам
            // по себе. Прежде отсюда шёл ранний выход, и голый отступ до бумаги не доезжал вовсе.
            _boxPad = былОтступ + pad;
            try { content(); }
            finally { _boxPad = былОтступ; }
            _y += pad;
            if (!есть) return;
            _boxParts.Add((_pageIndex, _boxTop ?? сверху, _y));
            _boxTop = null;
            // Огрызок в несколько точек на прошлом листе не рисуется: от блока там не осталось
            // ничего, кроме его же отступа. Порог применяется только к разорванному блоку:
            // неразорванный рисуется при любой ненулевой высоте, как рисовался всегда.
            var куски = _boxParts.Count == 1
                ? _boxParts.Where(ч => ч.Bottom - ч.Top > 0).ToList()
                : _boxParts.Where(ч => ч.Bottom - ч.Top >= 8).ToList();
            _boxParts.Clear();
            for (var i = 0; i < куски.Count; i++)
            {
                var (страница, верх, низ) = куски[i];
                // Отступ входит и в горизонталь: на экране он со всех сторон, а тут коробка всегда
                // шла от одного и того же места, и слева отступа не было вовсе.
                var rect = new XRect(Margin - 4, верх - 2, _contentW + 8, низ - верх + 4);
                // И плашка, и рамка кладутся отложенно. Фон обязан лечь ПОД уже напечатанный
                // текст, а открыть второй холст этой же страницы прямо сейчас нельзя: PDFsharp
                // держит один холст на страницу, и попытка роняла сборку PDF целиком. Рамка идёт
                // тем же путём, потому что её кусок может относиться к уже законченному листу,
                // холста которого больше нет.
                // На разрыве рамка не замыкается: блок, разрезанный между листами, это один блок,
                // а две замкнутые коробки читались бы как два. Так же ведёт себя и браузер
                // (box-decoration-break: slice).
                _boxes.Add((страница, rect, b.Bg, b.BorderColor, i == 0, i == куски.Count - 1));
                // Цвет коробки кладётся и в поле цвета, и в поле текста. Другого содержимого у
                // неё нет, а читающий раскладку одинаково законно ищет цвет и там, и там: у слова
                // цвет лежит в поле цвета, а текст это единственное, что у элемента вообще есть.
                if (!string.IsNullOrEmpty(b.Bg))
                    Note("box", rect.X, rect.Y, rect.Width, rect.Height, b.Bg!, color: b.Bg!, page: страница);
                // Рамка сообщается в раскладку наравне с плашкой: раскладка обязана описывать
                // лист целиком, иначе читающий её видит документ без половины оформления.
                if (!string.IsNullOrEmpty(b.BorderColor))
                    Note("border", rect.X, rect.Y, rect.Width, rect.Height, b.BorderColor!, color: b.BorderColor!, page: страница);
            }
        }

        /// <summary>Отложенные коробки: страница, место, цвет плашки, цвет рамки и надо ли
        /// замыкать рамку сверху и снизу (на разрыве между листами она остаётся открытой).</summary>
        private readonly List<(int Page, XRect Rect, string? Bg, string? Border, bool Top, bool Bottom)> _boxes = new();

        /// <summary>
        /// Нарисовать накопленные коробки под уже готовым текстом. Prepend кладёт рисование в
        /// начало содержимого страницы, поэтому буквы остаются видны поверх фона.
        /// </summary>
        public void FlushBoxes()
        {
            if (_boxes.Count == 0) return;
            _gfx?.Dispose();
            _gfx = null!;
            foreach (var группа in _boxes.GroupBy(x => x.Page))
            {
                if (группа.Key < 0 || группа.Key >= _doc.PageCount) continue;
                using var g = XGraphics.FromPdfPage(_doc.Pages[группа.Key], XGraphicsPdfPageOptions.Prepend);
                foreach (var b in группа)
                {
                    if (!string.IsNullOrEmpty(b.Bg)) g.DrawRectangle(new XSolidBrush(ColorOf(b.Bg)), b.Rect);
                    if (string.IsNullOrEmpty(b.Border)) continue;
                    var перо = new XPen(ColorOf(b.Border), 0.75);
                    if (b.Top && b.Bottom) { g.DrawRectangle(перо, b.Rect); continue; }
                    double x1 = b.Rect.X, x2 = b.Rect.X + b.Rect.Width;
                    double y1 = b.Rect.Y, y2 = b.Rect.Y + b.Rect.Height;
                    g.DrawLine(перо, x1, y1, x1, y2);
                    g.DrawLine(перо, x2, y1, x2, y2);
                    if (b.Top) g.DrawLine(перо, x1, y1, x2, y1);
                    if (b.Bottom) g.DrawLine(перо, x1, y2, x2, y2);
                }
            }
            _boxes.Clear();
        }

        private static XColor ColorOf(string? hex)
        {
            if (!string.IsNullOrEmpty(hex) && hex.Length == 7 && hex[0] == '#'
                && int.TryParse(hex.AsSpan(1, 2), System.Globalization.NumberStyles.HexNumber, null, out var r)
                && int.TryParse(hex.AsSpan(3, 2), System.Globalization.NumberStyles.HexNumber, null, out var g)
                && int.TryParse(hex.AsSpan(5, 2), System.Globalization.NumberStyles.HexNumber, null, out var b))
                return XColor.FromArgb(r, g, b);
            return XColors.White;
        }

        /// <summary>
        /// Список: каждая строка блока это пункт. Маркер или номер печатается отдельным куском
        /// без оформления, а сам пункт с отступом, чтобы вторая строка не подлезала под маркер.
        /// </summary>
        public void ListBlock(List<TextRun> runs, bool numbered, DocBlock block)
        {
            var пункты = new List<List<TextRun>> { new() };
            foreach (var r in runs ?? new List<TextRun>())
            {
                var segs = (r?.Text ?? "").Replace("\r", "").Split('\n');
                for (var i = 0; i < segs.Length; i++)
                {
                    if (i > 0) пункты.Add(new List<TextRun>());
                    if (segs[i].Length > 0)
                        пункты[^1].Add(new TextRun { Text = segs[i], Bold = r!.Bold, Italic = r.Italic,
                            Color = r.Color, Size = r.Size, SizePt = r.SizePt, Mark = r.Mark });
                }
            }
            var n = 1;
            foreach (var пункт in пункты)
            {
                if (пункт.Count == 0) continue;
                var маркер = numbered ? n++ + ".  " : "•  ";
                var строка = new List<TextRun> { new() { Text = маркер } };
                строка.AddRange(пункт);
                // Отступ под маркер: вторая строка пункта начинается там же, где первая буква.
                _listIndent = 16;
                // Межстрочный интервал блока действует и на пункты списка: на планшете он тоже
                // применяется, а тут его не передавали, и список на бумаге стоял тесным.
                Rich(строка, isHeading: false, block.Align, block.LineHeight);
                _listIndent = 0;
            }
        }

        /// <summary>Отступ содержимого списка, чтобы перенос строки не подлезал под маркер.</summary>
        private double _listIndent;

        /// <summary>
        /// Таблица. Строки одинаковой высоты не делаются: ячейка переносится по словам, и высота
        /// строки это высота самой длинной ячейки. Строка, не влезающая на лист, уезжает на
        /// следующий целиком, а не рвётся пополам.
        /// </summary>
        /// <param name="lineHeightPct">Межстрочный интервал блока: он относится и к строкам
        /// внутри ячейки. На планшете таблица его слушается, а на бумаге не слушалась вовсе.</param>
        public void Table(DocTable t, string? bg, string? border, int pad, int lineHeightPct = 0)
        {
            var rows = t.Rows ?? new List<List<string>>();
            if (rows.Count == 0) return;
            var cols = rows.Max(r => r?.Count ?? 0);
            if (cols == 0) return;

            var widths = new double[cols];
            var заданы = t.Widths is { Count: > 0 } && t.Widths.Count == cols;
            for (var i = 0; i < cols; i++)
                widths[i] = заданы ? _contentW * t.Widths[i] / 100.0 : _contentW / cols;

            var отступ = Math.Clamp(pad <= 0 ? 4 : pad, 2, 20);
            // Сетка внутри таблицы и рамка вокруг блока это разные вещи, как и на экране: сетка
            // всегда одного серого, а цвет рамки, заданный оператору блоку, красит только внешний
            // прямоугольник. Раньше одним пером рисовалось и то, и другое, и таблица с красной
            // рамкой на бумаге была вся расчерчена красным.
            var сетка = XColor.FromArgb(0x97, 0xa2, 0xb2);
            var рамка = string.IsNullOrEmpty(border) ? сетка : ColorOf(border);
            // Верх таблицы НА ЭТОМ ЛИСТЕ. Раньше он был один на всю таблицу, и у таблицы,
            // перешедшей на следующий лист, внешняя рамка рисовалась одним прямоугольником от
            // верха на первом листе до низа на последнем, то есть поперёк всего листа.
            var верхНаЛисте = _y;
            // Шаг строки в ячейке. Заданный оператором интервал это доля кегля, как unitless
            // line-height на планшете; незаданный это прежние 1.15 высоты шрифта, до последнего
            // знака. Прежде высота строки таблицы была одна и та же при любом интервале.
            var доля = lineHeightPct > 0 ? Math.Clamp(lineHeightPct, 100, 250) / 100.0 : 0;
            double Шаг(XFont f) => доля > 0 ? f.Size * доля : f.GetHeight() * 1.15;

            // Внешняя рамка цветом блока: на экране она обводит таблицу целиком, а не каждую
            // ячейку. Закрывается на каждом листе своим прямоугольником.
            void ЗакрытьРамку()
            {
                if (string.IsNullOrEmpty(border) || _y - верхНаЛисте <= 0) return;
                _gfx.DrawRectangle(new XPen(рамка, 1.0), Margin, верхНаЛисте, _contentW, _y - верхНаЛисте);
                Note("border", Margin, верхНаЛисте, _contentW, _y - верхНаЛисте, border!, color: border!);
            }

            void НаНовыйЛист()
            {
                ЗакрытьРамку();
                ClearFloat();
                NewPage();
                верхНаЛисте = _y;
            }

            for (var ri = 0; ri < rows.Count; ri++)
            {
                var шапка = t.HeaderRow && ri == 0;
                var font = шапка ? FontFor(Body.Size, true) : Body;
                var row = rows[ri] ?? new List<string>();

                // Высота строки: считается по самой высокой ячейке, до всякого рисования.
                double h = 0;
                var разбито = new List<List<string>>();
                for (var ci = 0; ci < cols; ci++)
                {
                    var текст = ci < row.Count ? row[ci] ?? "" : "";
                    var строки = WrapInto(текст, font, widths[ci] - 2 * отступ);
                    разбито.Add(строки);
                    h = Math.Max(h, строки.Count * Шаг(font));
                }
                h += 2 * отступ;

                // Строка рисуется частями, если целиком на лист не влезает. Раньше здесь стояло
                // одно Ensure(h): оно уводило на новый лист, а строку выше листа рисовало за его
                // нижним краем, и хвост ячейки пропадал молча. Замер до починки: ячейка из 700
                // кусков текста, клиент прочитал на планшете все 700, в бумаге оказалось 636,
                // и ни служба, ни бумага об этом не сказали ни слова. Это ровно то, чего быть
                // не должно: клиент подписал одно, а в бумаге другое.
                //
                // Тот же приём уже применён к плашке блока (см. _boxParts): часть рисуется на
                // этом листе, остальное продолжается на следующем.
                var шаг = Шаг(font);
                var строкВЯчейке = Math.Max(1, разбито.Count == 0 ? 0 : разбито.Max(c => c.Count));
                var нарисовано = 0;

                while (true)
                {
                    var свободноПодТекст = _pageH - Margin - _y - 2 * отступ;
                    var влезает = свободноПодТекст > 0 ? (int)Math.Floor(свободноПодТекст / шаг) : 0;
                    if (влезает <= 0)
                    {
                        НаНовыйЛист();
                        свободноПодТекст = _pageH - Margin - _y - 2 * отступ;
                        влезает = свободноПодТекст > 0 ? (int)Math.Floor(свободноПодТекст / шаг) : 0;
                        // На чистом листе одна строка обязана поместиться, иначе круг вечен.
                        if (влезает <= 0) влезает = 1;
                    }
                    var сколько = Math.Min(влезает, строкВЯчейке - нарисовано);
                    if (сколько <= 0) сколько = 1;
                    var высотаЧасти = сколько * шаг + 2 * отступ;

                    double x = Margin;
                    for (var ci = 0; ci < cols; ci++)
                    {
                        var rect = new XRect(x, _y, widths[ci], высотаЧасти);
                        var заливка = шапка ? "#f1f5f9" : bg;
                        // Заливка и сетка ячейки сообщаются в раскладку теми же видами, что плашка
                        // и рамка блока: читающий раскладку разбирает их одним и тем же кодом, и
                        // таблица не оказывается исключением из общего правила.
                        if (!string.IsNullOrEmpty(заливка))
                        {
                            var цвет = HexOf(ColorOf(заливка));
                            _gfx.DrawRectangle(new XSolidBrush(ColorOf(заливка)), rect);
                            Note("box", rect.X, rect.Y, rect.Width, rect.Height, цвет, color: цвет);
                        }
                        _gfx.DrawRectangle(new XPen(сетка, 0.6), rect);
                        Note("border", rect.X, rect.Y, rect.Width, rect.Height, HexOf(сетка), color: HexOf(сетка));
                        // Лишнее место от заданного межстрочного делится над строкой и под ней,
                        // как и в обычном абзаце: иначе текст ячейки прижимался бы к её верху.
                        var ty = _y + отступ + Math.Max(0, шаг - font.GetHeight() * 1.15) / 2;
                        var часть = разбито[ci].Skip(нарисовано).Take(сколько).ToList();
                        foreach (var строка in часть)
                        {
                            _gfx.DrawString(строка, font, XBrushes.Black, new XPoint(x + отступ, ty + font.GetHeight()));
                            ty += шаг;
                        }
                        Note("cell", rect.X, rect.Y, rect.Width, rect.Height,
                            string.Join(" ", часть), font.Size, шапка);
                        x += widths[ci];
                    }
                    _y += высотаЧасти;
                    нарисовано += сколько;
                    if (нарисовано >= строкВЯчейке) break;
                    НаНовыйЛист();
                }
            }
            ЗакрытьРамку();
            _y += 8;
        }

        /// <summary>Разбить текст по ширине на строки. Тот же перенос, что и у абзаца.</summary>
        private List<string> WrapInto(string text, XFont font, double width)
        {
            var out_ = new List<string>();
            if (width <= 0) { out_.Add(text); return out_; }
            foreach (var para in (text ?? "").Replace("\r", "").Split('\n'))
            {
                var line = "";
                foreach (var raw in para.Split(' '))
                {
                    var pieces = _gfx.MeasureString(raw, font).Width > width
                        ? BreakLongWord(raw, font, width)
                        : new List<string> { raw };
                    foreach (var word in pieces)
                    {
                        var trial = line.Length == 0 ? word : line + " " + word;
                        if (line.Length > 0 && _gfx.MeasureString(trial, font).Width > width)
                        {
                            out_.Add(line);
                            line = word;
                        }
                        else line = trial;
                    }
                }
                out_.Add(line);
            }
            if (out_.Count == 0) out_.Add("");
            return out_;
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
            // Пустое выравнивание у картинки означает «по центру»: так её ставит планшет и так
            // же рисует предпросмотр. Раньше пустое падало в последнюю ветку и прижимало
            // картинку к левому полю, и бумага расходилась с экраном.
            double dx = free <= 0 ? 0
                : mode is "center" or "" ? free / 2
                : mode == "right" ? free : 0;
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
        /// <param name="label">Надпись над местом подписи оформленными кусками, может отсутствовать.</param>
        /// <param name="img">Сама подпись. Пусто, если её ещё нет или встроить не удалось.</param>
        /// <param name="note">Что написать вместо подписи, когда её нет.</param>
        /// <param name="key">Имя поля подписи, попадает в раскладку.</param>
        public void SignatureBlock(List<TextRun>? label, XImage? img, string? note, string key,
            int widthPt = 0, int heightPt = 0, string? align = null)
        {
            // Размер места под подпись задаётся у самого поля, в точках. Ноль означает «как
            // всегда»: документы, собранные до появления этой настройки, выглядят как выглядели.
            double bw = widthPt > 0 ? Math.Min(Math.Clamp(widthPt, 60, 495) * _signScale, _contentW) : SignW;
            double bh = heightPt > 0 ? Math.Clamp(heightPt, 40, 300) * _signScale : SignH;
            var mode = (align ?? "").Trim().ToLowerInvariant();
            double свободно = _contentW - bw;
            double bx = Margin + (свободно <= 0 ? 0 : mode == "center" ? свободно / 2 : mode == "right" ? свободно : 0);

            // Надпись печатается теми же мерками, что и подписи остальных элементов страницы: с
            // переносом по ширине листа и с оформлением куска. Раньше это была одна строка,
            // нарисованная как есть, и надпись длиннее ширины листа обрезалась краем бумаги. Для
            // жёсткой «Подпись клиента:» это никогда не всплывало, а текст оператора длиной не
            // ограничен ничем, кроме здравого смысла.
            var надпись = (label ?? new List<TextRun>())
                .Where(r => r is not null && !string.IsNullOrEmpty(r.Text)).ToList();
            // По тому же краю, что и само место под подпись: надпись стоит над своим полем, а не
            // над соседним. При одной строке выходит ровно то же место, что и раньше.
            double head = надпись.Count == 0 ? 0 : ВысотаКусков(надпись, МежстрочныйНадписи);
            // Место под всю подпись целиком: надпись, поле и черта под ним не разъезжаются по двум
            // листам, иначе расписываться пришлось бы неизвестно подо чем.
            Ensure(head + bh + 12);
            if (надпись.Count > 0)
                // Той же меркой, какой сосчитан head: долей высоты шрифта. Проценты означают долю
                // кегля, и надпись встала бы не там, где под неё отмерено место.
                Rich(надпись, isHeading: true, align: mode, доляВысотыШрифта: МежстрочныйНадписи);
            Note("sign", bx, _y, bw, bh, key);
            if (img is not null)
            {
                var (dw, dh) = FitInto(img, bw, bh);
                _gfx.DrawImage(img, bx, _y + (bh - dh) / 2, dw, dh);
            }
            else if (!string.IsNullOrEmpty(note))
            {
                _gfx.DrawString(note, Body, ТусклыйТекст, new XPoint(bx, _y + Body.GetHeight()));
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
