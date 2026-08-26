// Экспорт шаблона должен уносить ВСЕ настройки, включая настройки PDF, а импорт возвращать их.
import { chromium } from 'playwright';
import fs from 'fs';
const BASE = 'http://127.0.0.1:5080';
// Путь к браузеру берётся из окружения: на другой машине он другой, а зашитый путь
// превращал набор в неработающий у всех, кроме одной установки. Пусто значит
// «пусть Playwright возьмёт свой», как он и делает по умолчанию.
const EXE = process.env.SK_CHROME || undefined;
const SP = '' + (process.env.SK_RABOTA || '.') + '';
let fail = 0;
const ok = (c, m) => { if (c) console.log('PASS', m); else { console.error('FAIL', m); fail++; } };
async function отказатьсяОтЧерновика(page) {
  // Окно появляется не сразу: черновик сравнивается с документом, а тот ещё едет с сервера.
  // Проверка «есть ли окно прямо сейчас» промахивалась, окно всплывало позже и перехватывало
  // нажатия, а набор падал на «кнопка недоступна», ничего не объясняя.
  const btn = page.locator('.modal button', { hasText: 'Отказаться от черновика' });
  try { await btn.waitFor({ state: 'visible', timeout: 2500 }); } catch { return; }
  await btn.click();
  await page.waitForTimeout(200);
}

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const p = await (await browser.newContext({ viewport: { width: 1500, height: 950 }, acceptDownloads: true })).newPage();
await p.goto(BASE + '/admin/');
await p.fill('#password', 'test123'); await p.click('#loginForm button[type=submit]');
await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
const call = (path, opts) => p.evaluate(async ([pa, o]) => {
  const r = await fetch('/api/admin' + pa, Object.assign({ credentials: 'same-origin' }, o || {}));
  let b = null; try { b = await r.json(); } catch {} return { status: r.status, body: b };
}, [path, opts]);

// Документ, в котором задействовано всё, что вообще можно задать.
const ПОЛНЫЙ = {
  title: 'ПОЛНЫЙ ДОКУМЕНТ', signPrompt: 'Распишитесь здесь', thankYouText: 'Благодарим',
  idleReturnSec: 240, pdfFontScale: 70, pdfSignatureScale: 60,
  pages: [
    { headingRuns: [{ text: 'Раздел', bold: true }], headingAlign: 'center',
      blocks: [{ runs: [{ text: 'Абзац по обоим краям.', italic: true, color: '#dc2626', size: 'l' }], ord: 0, align: 'justify' },
               { runs: [{ text: 'Второй абзац.' }], ord: 1, align: 'right',
                 visibleWhen: { field: 'Пол', op: 'eq', value: 'F' } }],
      checkboxes: [{ key: 'soglasie', label: 'Согласен', required: true, ord: 2 }],
      groups: [{ key: 'pisha', title: 'Голодание', required: true, ord: 3,
                 options: [{ key: 'da', label: 'ДА' }, { key: 'net', label: 'НЕТ' }] }],
      signatures: [{ key: 'vrach', label: 'Подпись врача', required: true, ord: 4 }],
      scans: [{ key: 'probirka', label: 'Штрихкод', required: false, ord: 5 }],
      includeDynamic: true, visibleWhen: { field: 'ДР', op: 'agelt', value: '14' } },
    { kind: 'signature', headingRuns: [{ text: 'Экран подписи' }], blocks: [], checkboxes: [], groups: [], scans: [],
      signatures: [{ key: 'klient', label: 'Распишитесь', required: true, ord: 0 }] },
    { kind: 'scan', headingRuns: [{ text: 'Экран сканирования' }], blocks: [], checkboxes: [], groups: [], signatures: [],
      scans: [{ key: 'napravlenie', label: 'QR направления', required: true, ord: 0 }] }
  ],
  signBlocks: [{ runs: [{ text: 'Над подписью.' }], ord: 0, align: 'center' }],
  signBlocksBelow: [{ runs: [{ text: 'Под подписью.' }], ord: 0 }],
  signaturePlacements: [{ key: '', page: 0, x: 0.55, y: 0.7, w: 0.3, h: 0.09 },
                        { key: 'vrach', page: 0, x: 0.1, y: 0.85, w: 0.25, h: 0.07 }]
};
await call('/document', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ПОЛНЫЙ) });
const сохранён = (await call('/document')).body;
ok(сохранён.pdfFontScale === 70 && сохранён.pdfSignatureScale === 60, 'настройки PDF сохранены');
ok((сохранён.signaturePlacements || []).length === 2, 'раскладка подписей сохранена');

await p.evaluate(() => Object.keys(localStorage).filter(k => k.indexOf('sk_doc_draft') === 0).forEach(k => localStorage.removeItem(k)));
await p.reload(); await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
await p.click('[data-tab="document"]'); await p.waitForTimeout(700);
await отказатьсяОтЧерновика(p);

// Экспорт настоящей кнопкой, а не выдуманным запросом.
const [download] = await Promise.all([
  p.waitForEvent('download', { timeout: 15000 }),
  p.click('#exportDoc')
]);
const путь = SP + '/export-check.json';
await download.saveAs(путь);
const файл = JSON.parse(fs.readFileSync(путь, 'utf8'));
ok(файл.kind === 'helix-signtablet-document', 'файл помечен как шаблон документа');
const d = файл.document;

ok(d.pdfFontScale === 70, 'в файле размер шрифта PDF: ' + d.pdfFontScale);
ok(d.pdfSignatureScale === 60, 'в файле размер подписи в PDF: ' + d.pdfSignatureScale);
ok((d.signaturePlacements || []).length === 2, 'в файле раскладка подписей: ' + (d.signaturePlacements || []).length);
ok(d.idleReturnSec === 240, 'в файле возврат к рекламе: ' + d.idleReturnSec);
ok(d.signPrompt === 'Распишитесь здесь' && d.thankYouText === 'Благодарим', 'в файле тексты экранов');
ok(d.pages.length === 3, 'в файле три страницы: ' + d.pages.length);
ok(d.pages[0].headingAlign === 'center', 'в файле выравнивание заголовка');
ok(d.pages[0].blocks[0].align === 'justify' && d.pages[0].blocks[1].align === 'right', 'в файле выравнивание абзацев');
ok(d.pages[0].blocks[0].runs[0].color === '#dc2626' && d.pages[0].blocks[0].runs[0].size === 'l', 'в файле оформление текста');
ok(!!d.pages[0].visibleWhen && d.pages[0].visibleWhen.op === 'agelt', 'в файле условие показа страницы');
ok(!!d.pages[0].blocks[1].visibleWhen, 'в файле условие показа блока');
ok(d.pages[0].includeDynamic === true, 'в файле пометка приёмника чекбоксов из API');
ok(d.pages[0].signatures.length === 1 && d.pages[0].scans.length === 1, 'в файле подпись и сканирование блоками');
ok(d.pages[1].kind === 'signature' && d.pages[2].kind === 'scan', 'в файле виды страниц');
ok((d.signBlocks || []).length === 1 && (d.signBlocksBelow || []).length === 1, 'в файле блоки вокруг подписи');
ok(d.signBlocks[0].align === 'center', 'и их выравнивание тоже');

// Импорт: всё возвращается на место.
await call('/document', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
  title: 'ПУСТО', signPrompt: 'x', thankYouText: 'x', idleReturnSec: 0,
  pages: [{ headingRuns: [{ text: 'Пусто' }], blocks: [{ runs: [{ text: 'Ничего.' }], ord: 0 }],
    checkboxes: [], groups: [], signatures: [], scans: [] }], signBlocks: [], signBlocksBelow: [] }) });
const пусто = (await call('/document')).body;
ok(пусто.pdfFontScale === 100 && пусто.pdfSignatureScale === 100, 'документ заменён на пустой');

// Импорт заводит НОВЫЙ документ в библиотеке, а не затирает открытый: файл шаблона это
// отдельный документ. Читать после импорта надо именно его, по возвращённому идентификатору.
const r = await p.evaluate(async (текст) => {
  const res = await fetch('/api/admin/document/import', { method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' }, body: текст });
  return { status: res.status, body: await res.text() };
}, JSON.stringify(файл));
let импортированный = '';
try { импортированный = (JSON.parse(r.body) || {}).id || ''; } catch (e) { импортированный = ''; }
ok(r.status === 200, 'импорт принят: ' + r.status + ' ' + r.body.slice(0, 80));

const назад = (await call('/document?id=' + импортированный)).body;
ok(назад.pdfFontScale === 70, 'после импорта размер шрифта PDF вернулся: ' + назад.pdfFontScale);
ok(назад.pdfSignatureScale === 60, 'и размер подписи в PDF: ' + назад.pdfSignatureScale);
ok((назад.signaturePlacements || []).length === 2, 'и раскладка подписей: ' + (назад.signaturePlacements || []).length);
ok(назад.idleReturnSec === 240, 'и возврат к рекламе');
ok(назад.pages.length === 3 && назад.pages[1].kind === 'signature' && назад.pages[2].kind === 'scan', 'и виды страниц');
ok(назад.pages[0].headingAlign === 'center' && назад.pages[0].blocks[0].align === 'justify', 'и выравнивание');
ok(назад.pages[0].includeDynamic === true, 'и пометка приёмника');
ok(назад.pages[0].signatures[0].key === 'vrach' && назад.pages[0].scans[0].key === 'probirka', 'и поля внутри страницы');

// Ничего не потерялось: сравниваем целиком, кроме служебного порядка.
const срез = (x) => JSON.stringify(x, Object.keys(x).sort());
ok(срез(назад) === срез(сохранён), 'документ после импорта совпадает с исходным целиком');

await browser.close();
console.log(fail === 0 ? '\nВСЁ ПРОЙДЕНО' : '\n' + fail + ' ПРОВЕРОК УПАЛО');
process.exit(fail === 0 ? 0 : 1);
