// Вставка из буфера. Смысл проверки: что оператор увидел в редакторе после вставки, то и должно
// уехать на планшет. Раньше редактор показывал чужую разметку (шрифты Word, списки, таблицы),
// а документ её не хранил, и на планшете текст выглядел иначе.
import { chromium } from 'playwright';
// После перезагрузки редактор может предложить восстановить черновик. Эти проверки про другое,
// поэтому черновик отклоняется, если он предложен.
async function отказатьсяОтЧерновика(page) {
  // Окно появляется не сразу: черновик сравнивается с документом, а тот ещё едет с сервера.
  // Проверка «есть ли окно прямо сейчас» промахивалась, окно всплывало позже и перехватывало
  // нажатия, а набор падал на «кнопка недоступна», ничего не объясняя.
  const btn = page.locator('.modal button', { hasText: 'Отказаться от черновика' });
  try { await btn.waitFor({ state: 'visible', timeout: 2500 }); } catch { return; }
  await btn.click();
  await page.waitForTimeout(200);
}


const BASE = 'http://127.0.0.1:5080';
// Путь к браузеру берётся из окружения: на другой машине он другой, а зашитый путь
// превращал набор в неработающий у всех, кроме одной установки. Пусто значит
// «пусть Playwright возьмёт свой», как он и делает по умолчанию.
const EXE = process.env.SK_CHROME || undefined;
let fail = 0;
const ok = (c, m) => { if (c) console.log('PASS', m); else { console.error('FAIL', m); fail++; } };

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const p = await (await browser.newContext({ viewport: { width: 1400, height: 1100 } })).newPage();
const jsErr = []; p.on('pageerror', e => jsErr.push(e.message));
p.on('dialog', d => d.accept());
await p.goto(BASE + '/admin/');
await p.fill('#password', 'test123'); await p.click('#loginForm button[type=submit]');
await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
await отказатьсяОтЧерновика(p);

const call = (path, opts) => p.evaluate(async ([pa, o]) => {
  const r = await fetch('/api/admin' + pa, Object.assign({ credentials: 'same-origin' }, o || {}));
  let body = null; try { body = await r.json(); } catch { body = null; }
  return { status: r.status, body };
}, [path, opts]);
const put = (path, obj) => call(path, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });

await put('/document', {
  title: 'Согласие', signPrompt: 'Распишитесь', thankYouText: 'Спасибо', idleReturnSec: 0,
  pages: [{ headingRuns: [{ text: 'Страница' }], blocks: [{ runs: [{ text: '' }] }], checkboxes: [], groups: [] }],
  signBlocks: [], signBlocksBelow: []
});
await p.reload();
await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
await отказатьсяОтЧерновика(p);
await p.click('.tab[data-tab="document"]');
await p.waitForSelector('[data-role="pagecard"]', { timeout: 5000 });

// Вставка идёт настоящим событием paste с настоящим DataTransfer: именно так это делает браузер.
async function paste(html, plain) {
  await p.evaluate(([h, t]) => {
    const ed = document.querySelector('.block-card .rt-editor');
    ed.innerHTML = '';
    ed.focus();
    const r = document.createRange(); r.selectNodeContents(ed); r.collapse(true);
    const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
    const dt = new DataTransfer();
    if (h) dt.setData('text/html', h);
    dt.setData('text/plain', t != null ? t : '');
    ed.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, [html, plain]);
  await p.waitForTimeout(150);
  // То, что редактор реально показывает, и то, что уедет на сервер.
  return await p.evaluate(() => {
    const ed = document.querySelector('.block-card .rt-editor');
    return { html: ed.innerHTML, text: ed.innerText };
  });
}

// Что сохранится в документ (и, значит, попадёт на планшет и в PDF).
async function saved() {
  await p.click('#saveDocument');
  await p.waitForTimeout(700);
  const doc = (await call('/document')).body;
  return doc.pages[0].blocks[0].runs || [];
}
const asText = (runs) => runs.map(r => r.text).join('');

// ---------- Разметка Word ----------
// Шрифты, размеры в пунктах, служебные стили, переносы строк прямо в исходнике.
const word = `<html xmlns:o="urn:schemas-microsoft-com:office:office"><head><style>p.MsoNormal{margin:0}</style></head>
<body lang=RU><p class=MsoNormal><span style='font-size:14.0pt;font-family:"Times New Roman",serif'>Настоящим
я даю согласие</span><b><span style='font-size:14.0pt;font-family:"Times New Roman",serif'> на обработку</span></b><span
 style='font-size:14.0pt'> персональных данных.<o:p></o:p></span></p>
<p class=MsoNormal><span style='font-size:14.0pt'>Второй абзац.</span></p></body></html>`;
let r = await paste(word, 'Настоящим я даю согласие на обработку персональных данных.\nВторой абзац.');
ok(!/font-family/i.test(r.html), 'чужой шрифт не остаётся в редакторе');
ok(!/font-size/i.test(r.html), 'чужой размер в пунктах не остаётся в редакторе');
ok(!/mso|MsoNormal|o:p/i.test(r.html), 'служебная разметка Word не остаётся');
ok(!/\n/.test(r.text.split('\n')[0]) && /Настоящим я даю согласие на обработку персональных данных\./.test(r.text),
  'перенос строки внутри тега не рвёт абзац: ' + JSON.stringify(r.text));
ok(/Второй абзац/.test(r.text) && r.text.split('\n').filter(x => x.trim()).length === 2,
  'абзацы остались абзацами: ' + JSON.stringify(r.text));
let runs = await saved();
ok(/на обработку/.test(asText(runs)), 'текст доехал до документа');
ok(runs.some(x => x.bold && /на обработку/.test(x.text)), 'жирный сохранён: ' + JSON.stringify(runs.map(x => [x.text, !!x.bold])));
ok(!runs.some(x => x.size), 'чужие размеры не превратились в размеры документа');
// Главное: редактор и документ показывают одно и то же.
ok(asText(runs).replace(/\s+/g, ' ').trim() === r.text.replace(/\s+/g, ' ').trim(),
  'в редакторе и в документе один и тот же текст');

// ---------- Список ----------
r = await paste('<ul><li>Первый пункт</li><li>Второй пункт</li></ul>', 'Первый пункт\nВторой пункт');
ok(!/<ul|<li/i.test(r.html), 'список не остаётся списком в разметке');
ok(/• Первый пункт/.test(r.text) && /• Второй пункт/.test(r.text), 'маркеры стали обычным текстом: ' + JSON.stringify(r.text));
runs = await saved();
ok(/• Первый пункт\n• Второй пункт/.test(asText(runs)), 'на планшет уедет тот же список: ' + JSON.stringify(asText(runs)));

r = await paste('<ol start="3"><li>Третий</li><li>Четвёртый</li></ol>', 'Третий\nЧетвёртый');
ok(/3\. Третий/.test(r.text) && /4\. Четвёртый/.test(r.text), 'нумерация сохранена: ' + JSON.stringify(r.text));

// ---------- Таблица ----------
r = await paste('<table><tr><td>Фамилия</td><td>Иванов</td></tr><tr><td>Год</td><td>1990</td></tr></table>', 'Фамилия Иванов Год 1990');
ok(!/<table|<tr|<td/i.test(r.html), 'таблица не остаётся таблицей');
const rows = r.text.split('\n').filter(x => x.trim());
ok(rows.length === 2 && /Фамилия Иванов/.test(rows[0]) && /Год 1990/.test(rows[1]),
  'строки таблицы стали строками текста: ' + JSON.stringify(r.text));

// ---------- Неразрывные пробелы и мусор ----------
r = await paste('<p>Сумма: 1 000­ руб.​</p>', 'Сумма: 1 000 руб.');
ok(!/[ ­​]/.test(r.text), 'неразрывные пробелы и мягкие переносы убраны: ' + JSON.stringify(r.text));
ok(/Сумма: 1 000 руб\./.test(r.text), 'текст при этом не пострадал: ' + JSON.stringify(r.text));

// ---------- Только обычный текст ----------
r = await paste('', 'Строка один\r\nСтрока два');
ok(/Строка один\nСтрока два/.test(r.text), 'обычный текст вставляется с переносами: ' + JSON.stringify(r.text));
ok(!/\r/.test(r.text), 'возврат каретки убран');

// ---------- Своё же содержимое вставляется без потерь ----------
r = await paste('<span style="font-weight:700">Жирно</span><span class="rt-l" style="color:#dc2626"> и крупно</span>', 'Жирно и крупно');
runs = await saved();
ok(runs.some(x => x.bold && /Жирно/.test(x.text)), 'свой жирный переживает вставку');
ok(runs.some(x => x.size === 'l' && x.color === '#dc2626'), 'свой размер и цвет переживают вставку: ' + JSON.stringify(runs));

// ---------- Опасное содержимое ----------
r = await paste('<p>До<script>window.__pwned=1;<\/script><img src=x onerror="window.__pwned=1">После</p>', 'ДоПосле');
ok(await p.evaluate(() => !window.__pwned), 'скрипт и картинка из буфера не выполняются');
ok(/ДоПосле/.test(r.text.replace(/\s+/g, '')), 'а текст вокруг них сохраняется: ' + JSON.stringify(r.text));

// ---------- Заголовок страницы ----------
// Word переносит строку там, где она кончилась на бумаге, и заголовок приезжает разорванным.
// Поле заголовка должно вести себя так же, как блок текста.
await p.evaluate(() => {
  const ed = document.querySelector('[data-role="heading"]');
  ed.innerHTML = ''; ed.focus();
  const r = document.createRange(); r.selectNodeContents(ed); r.collapse(true);
  const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
  const dt = new DataTransfer();
  dt.setData('text/html', "<p class=MsoNormal><b><span style='font-size:14.0pt;font-family:\"Times New Roman\",serif'>3. Информация о медицинском\nвмешательстве и связанные с ним риски</span></b></p>");
  dt.setData('text/plain', '3. Информация о медицинском вмешательстве и связанные с ним риски');
  ed.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
});
await p.waitForTimeout(200);
const head = await p.evaluate(() => document.querySelector('[data-role="heading"]').innerText);
ok(!/\n/.test(head.trim()), 'заголовок не разрывается на две строки: ' + JSON.stringify(head));
ok(/медицинском вмешательстве/.test(head), 'слова не склеились и не потерялись: ' + JSON.stringify(head));

await p.click('#saveDocument');
await p.waitForTimeout(700);
const hruns = ((await call('/document')).body.pages[0].headingRuns || []).map(r => r.text).join('');
ok(!/\n/.test(hruns), 'и в документе перенос не сохранился: ' + JSON.stringify(hruns));

// ---------- Склейка строк кнопкой ¶ ----------
// Копия из PDF приходит обычным текстом, где перенос стоит в конце каждой строки показа.
await paste('', 'Первая часть предложения\nи его продолжение\n\nНовый абзац\nтоже разорван');
// Панель всплывает над тем полем, которое редактируется, поэтому сначала входим в него.
await p.locator('.block-card .rt-editor').first().click();
await p.waitForTimeout(200);
await p.locator('.rt-toolbar button', { hasText: '¶' }).first().click();
await p.waitForTimeout(200);
const joined = await p.evaluate(() => document.querySelector('.block-card .rt-editor').innerText);
ok(/Первая часть предложения и его продолжение/.test(joined), 'строки одного абзаца склеились: ' + JSON.stringify(joined));
ok(/Новый абзац тоже разорван/.test(joined), 'и во втором абзаце тоже: ' + JSON.stringify(joined));
ok(joined.split('\n').filter(x => x.trim()).length === 2, 'граница между абзацами осталась: ' + JSON.stringify(joined));

ok(jsErr.length === 0, 'ошибок JavaScript нет: ' + jsErr.join(' | '));
await browser.close();
console.log(fail === 0 ? '\nВСЁ ПРОЙДЕНО' : '\n' + fail + ' ПРОВЕРОК УПАЛО');
process.exit(fail === 0 ? 0 : 1);
