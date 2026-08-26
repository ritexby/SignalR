// Что теряется при экспорте и импорте. Документ собран так, чтобы задействовать каждое поле
// модели, включая картинку в блоке. Сравнение поэлементное: любое расхождение печатается
// своим путём, а не прячется за «не совпало».
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

// Картинка в медиатеке: блок с картинкой ссылается на файл, а не несёт его в себе.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAFUlEQVR42mNk+M/wn4EIwDiqkL4KAcT9A/1G3AxaAAAAAElFTkSuQmCC';
const залито = await p.evaluate(async (b64) => {
  const bin = atob(b64), arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  const fd = new FormData();
  fd.append('file', new Blob([arr], { type: 'image/png' }), 'gerb.png');
  const r = await fetch('/api/admin/images', { method: 'POST', credentials: 'same-origin', body: fd });
  return { status: r.status, body: await r.text() };
}, PNG);
console.log('загрузка картинки:', залито.status, залито.body.slice(0, 160));
let imgUrl = null;
try {
  const j = JSON.parse(залито.body);
  const first = Array.isArray(j) ? j[0] : (j.added ? j.added[0] : j);
  imgUrl = first && (first.url || first.Url || (first.fileName ? '/media/' + first.fileName : null));
} catch {}
ok(!!imgUrl, 'картинка загружена: ' + imgUrl);

const ПОЛНЫЙ = {
  title: 'ПОЛНЫЙ ДОКУМЕНТ {{ФИО}}', signPrompt: 'Распишитесь здесь', thankYouText: 'Благодарим, {{ФИО}}',
  idleReturnSec: 240, pdfFontScale: 70, pdfSignatureScale: 60,
  thankYouRuns: [{ text: 'Готово, ' }, { text: 'спасибо', bold: true, color: '#16a34a', size: 'l' }],
  thankYouAlign: 'center', thankYouSec: 9,
  thankYouBlocks: [{ runs: [{ text: 'Заберите экземпляр у администратора.' }], ord: 0, align: 'center' }],
  pages: [
    { headingRuns: [{ text: 'Раздел ', bold: true }, { text: 'важный', bold: true, italic: true, color: '#dc2626', size: 'h' }],
      headingAlign: 'center',
      blocks: [
        { runs: [{ text: 'Жирный ', bold: true }, { text: 'курсив ', italic: true },
                 { text: 'цветной ', color: '#2563eb' }, { text: 'крупный', size: 'l' }], ord: 0, align: 'justify' },
        { imageUrl: imgUrl, imageWidth: 45, ord: 1, align: 'center' },
        { imageUrl: imgUrl, imageWidth: 35, ord: 8, wrap: 'right', wrapGap: 18 },
        { runs: [{ text: 'Условный абзац.' }], ord: 2, align: 'right',
          visibleWhen: { field: 'Пол', op: 'eq', value: 'F', and: [{ field: 'ДР', op: 'agelt', value: '14' }] } }],
      checkboxes: [{ key: 'soglasie', label: 'Согласен на {{Адрес регистрации}}', required: true, checked: true, ord: 3,
                     visibleWhen: { field: 'UG', op: 'eq', value: 'true' } },
                   { key: 'vtoroy', label: 'Не обязательный', required: false, checked: false, ord: 4 }],
      groups: [{ key: 'pisha', title: 'Голодание', required: true, selected: 'da', ord: 5,
                 options: [{ key: 'da', label: 'ДА' }, { key: 'net', label: 'НЕТ' }],
                 visibleWhen: { field: 'urine', op: 'eq', value: 'true' } }],
      signatures: [{ key: 'vrach', label: 'Подпись врача', required: true, ord: 6,
                     width: 175, height: 70, align: 'center',
                     visibleWhen: { field: 'Пол', op: 'eq', value: 'M' } }],
      scans: [{ key: 'probirka', label: 'Штрихкод', required: false, ord: 7 }],
      includeDynamic: true,
      visibleWhen: { field: 'cross-border', op: 'eq', value: 'true' } },
    { kind: 'signature', headingRuns: [{ text: 'Экран подписи' }], headingAlign: 'right',
      blocks: [{ runs: [{ text: 'Пояснение над полем.' }], ord: 0, align: 'center' }],
      checkboxes: [], groups: [], scans: [],
      signatures: [{ key: 'klient', label: 'Распишитесь', required: true, ord: 1 }],
      visibleWhen: { field: 'ДР', op: 'agege', value: '18' } },
    { kind: 'scan', headingRuns: [{ text: 'Экран сканирования' }], blocks: [], checkboxes: [], groups: [], signatures: [],
      scans: [{ key: 'napravlenie', label: 'QR направления', required: true, ord: 0 }] }
  ],
  signBlocks: [{ runs: [{ text: 'Над подписью.', bold: true }], ord: 0, align: 'center' }],
  signBlocksBelow: [{ runs: [{ text: 'Под подписью.', color: '#16a34a' }], ord: 0, align: 'justify' }],
  signaturePlacements: [{ key: '', page: 0, x: 0.55, y: 0.7, w: 0.3, h: 0.09 },
                        { key: 'vrach', page: 1, x: 0.1, y: 0.85, w: 0.25, h: 0.07 }]
};
await call('/document', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ПОЛНЫЙ) });
const исходный = (await call('/document')).body;
ok(исходный.pages.length === 3, 'документ сохранён: страниц ' + исходный.pages.length);
ok(!!(исходный.pages[0].blocks || []).find(b => b.imageUrl), 'блок с картинкой на месте');
const обт = (исходный.pages[0].blocks || []).find(b => b.wrap);
ok(обт && обт.wrap === 'right' && обт.wrapGap === 18, 'обтекание в исходном документе: ' + JSON.stringify(обт && { w: обт.wrap, g: обт.wrapGap }));
const подп = исходный.pages[0].signatures[0];
ok(подп.width === 175 && подп.height === 70 && подп.align === 'center',
  'размер места подписи в исходном документе: ' + JSON.stringify({ w: подп.width, h: подп.height, a: подп.align }));
ok(исходный.thankYouSec === 9 && (исходный.thankYouBlocks || []).length === 1, 'экран «Спасибо» в исходном документе');

// Экспорт настоящей кнопкой.
await p.evaluate(() => Object.keys(localStorage).filter(k => k.indexOf('sk_doc_draft') === 0).forEach(k => localStorage.removeItem(k)));
await p.reload(); await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
await p.click('[data-tab="document"]'); await p.waitForTimeout(700);
await отказатьсяОтЧерновика(p);
const [download] = await Promise.all([p.waitForEvent('download', { timeout: 15000 }), p.click('#exportDoc')]);
const путь = SP + '/export-full.json';
await download.saveAs(путь);
const файл = JSON.parse(fs.readFileSync(путь, 'utf8'));

// Сбрасываем документ и импортируем обратно.
await call('/document', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
  title: 'ПУСТО', signPrompt: 'x', thankYouText: 'x', idleReturnSec: 0,
  pages: [{ headingRuns: [{ text: 'Пусто' }], blocks: [{ runs: [{ text: 'Ничего.' }], ord: 0 }],
    checkboxes: [], groups: [], signatures: [], scans: [] }], signBlocks: [], signBlocksBelow: [] }) });
// Импорт заводит НОВЫЙ документ в библиотеке, а не затирает открытый: файл шаблона это
// отдельный документ. Читать после импорта надо именно его, по возвращённому идентификатору.
const r = await p.evaluate(async (текст) => {
  const res = await fetch('/api/admin/document/import', { method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' }, body: текст });
  return { status: res.status, body: await res.text() };
}, JSON.stringify(файл));
let импортированный = '';
try { импортированный = (JSON.parse(r.body) || {}).id || ''; } catch (e) { импортированный = ''; }
ok(r.status === 200, 'импорт принят: ' + r.status);
const назад = (await call('/document?id=' + импортированный)).body;

// Поэлементное сравнение: печатаем каждый путь, где значения разошлись.
function сравнить(a, b, путь, расхождения) {
  if (a === b) return;
  const типA = a === null ? 'null' : Array.isArray(a) ? 'array' : typeof a;
  const типB = b === null ? 'null' : Array.isArray(b) ? 'array' : typeof b;
  if (типA !== типB) { расхождения.push(путь + ': было ' + JSON.stringify(a) + ', стало ' + JSON.stringify(b)); return; }
  if (типA === 'array') {
    if (a.length !== b.length) { расхождения.push(путь + ': длина ' + a.length + ' против ' + b.length); return; }
    a.forEach((v, i) => сравнить(v, b[i], путь + '[' + i + ']', расхождения));
    return;
  }
  if (типA === 'object') {
    const ключи = new Set(Object.keys(a).concat(Object.keys(b)));
    ключи.forEach(k => сравнить(a[k], b[k], путь ? путь + '.' + k : k, расхождения));
    return;
  }
  расхождения.push(путь + ': было ' + JSON.stringify(a) + ', стало ' + JSON.stringify(b));
}
const расхождения = [];
сравнить(исходный, назад, '', расхождения);
if (расхождения.length) { console.log('РАСХОЖДЕНИЯ ПОСЛЕ ИМПОРТА:'); расхождения.forEach(x => console.log('  ' + x)); }
ok(расхождения.length === 0, 'после импорта документ совпадает целиком, расхождений: ' + расхождения.length);

// Картинка целиком лежит в файле, поэтому шаблон переносится на другой сервер.
const блокКартинки = (файл.document.pages[0].blocks || []).find(b => b.imageUrl);
ok(!!блокКартинки, 'ссылка на картинку в файле есть: ' + (блокКартинки && блокКартинки.imageUrl));
ok(файл.version === 2, 'файл новой версии: ' + файл.version);
ok(Array.isArray(файл.images) && файл.images.length === 1, 'картинка вложена в файл: ' + (файл.images || []).length);
const имяВФайле = блокКартинки.imageUrl.slice('/media/'.length);
ok(файл.images[0].file === имяВФайле, 'имя вложенной картинки совпадает со ссылкой: ' + файл.images[0].file);
ok(файл.images[0].data === PNG, 'и содержимое то же самое, байт в байт');

// Перенос на чистый сервер: удаляем картинку из медиатеки и импортируем файл заново.
const удалено = await p.evaluate(async (id) => {
  const r = await fetch('/api/admin/images/' + id, { method: 'DELETE', credentials: 'same-origin' });
  return r.status;
}, (await call('/images')).body[0].id);
console.log('удаление картинки:', удалено);
const пусто = (await call('/images')).body || [];
ok(пусто.length === 0, 'медиатека очищена: ' + пусто.length);
const снова = await p.evaluate(async (текст) => {
  const res = await fetch('/api/admin/document/import', { method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' }, body: текст });
  return { status: res.status, body: await res.text() };
}, JSON.stringify(файл));
ok(снова.status === 200, 'повторный импорт принят: ' + снова.status + ' ' + снова.body.slice(0, 80));
ok(/"images":1/.test(снова.body), 'импорт сообщил, что восстановил картинку: ' + снова.body);
const вернулась = (await call('/images')).body || [];
ok(вернулась.length === 1, 'картинка вернулась в медиатеку: ' + вернулась.length);
const проверка = await p.evaluate(async (url) => {
  const r = await fetch(url, { credentials: 'same-origin' });
  if (!r.ok) return { status: r.status };
  const b = await r.blob();
  return { status: r.status, size: b.size };
}, блокКартинки.imageUrl);
ok(проверка.status === 200 && проверка.size > 0, 'и отдаётся по той же ссылке: ' + JSON.stringify(проверка));

await browser.close();
console.log(fail === 0 ? '\nВСЁ ПРОЙДЕНО' : '\n' + fail + ' ПРОВЕРОК УПАЛО');
process.exit(fail === 0 ? 0 : 1);
