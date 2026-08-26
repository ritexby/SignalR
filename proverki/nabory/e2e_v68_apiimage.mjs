// Картинка, присланная внешней системой в BASE64, встаёт на место тега в документе: на планшете,
// в записи и в PDF. Проверяется и то, что чужое под видом картинки не принимается.
import { chromium } from 'playwright';
const BASE = 'http://127.0.0.1:5080';
// Путь к браузеру берётся из окружения: на другой машине он другой, а зашитый путь
// превращал набор в неработающий у всех, кроме одной установки. Пусто значит
// «пусть Playwright возьмёт свой», как он и делает по умолчанию.
const EXE = process.env.SK_CHROME || undefined;
let fail = 0;
const ok = (c, m) => { if (c) console.log('PASS', m); else { console.error('FAIL', m); fail++; } };

// Настоящий PNG в один пиксель и настоящий JPEG, чтобы проверка по первым байтам была честной.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const JPEG = '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const admin = await (await browser.newContext()).newPage();
admin.on('pageerror', e => { console.error('FAIL ошибка в админке: ' + e.message); fail++; });
await admin.goto(BASE + '/admin/');
await admin.fill('#password', 'test123');
await admin.click('#loginForm button[type=submit]');
await admin.waitForSelector('#app:not(.hidden)', { timeout: 8000 });

const call = (path, opts) => admin.evaluate(async ([pa, o]) => {
  const r = await fetch('/api/admin' + pa, Object.assign({ credentials: 'same-origin' }, o || {}));
  let body = null; try { body = await r.json(); } catch { body = null; }
  return { status: r.status, body };
}, [path, opts]);
const post = (path, obj) => call(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });
const put = (path, obj) => call(path, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });

const enr = (await post('/devices/enroll', { name: 'Планшет картинки', ttlMinutes: 30 })).body;
const tok = await admin.evaluate(async (code) => (await fetch('/api/kiosk/enroll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) })).json(), enr.code);

const ДОК = {
  title: 'Направление', signPrompt: 'Распишитесь', thankYouText: 'Спасибо', idleReturnSec: 0,
  pages: [{
    headingRuns: [{ text: 'Направление' }],
    blocks: [
      { runs: [{ text: 'Текст направления' }], ord: 0 },
      { imageTag: 'ПЕЧАТЬ', imageWidth: 40, ord: 1 },
      { runs: [{ text: 'Текст после печати' }], ord: 2 }
    ],
    checkboxes: [], includeDynamic: false
  }]
};
ok((await put('/document', ДОК)).status === 200, 'документ с тегом картинки сохранён');
const сохр = (await call('/document')).body;
ok((сохр.pages[0].blocks[1] || {}).imageTag === 'ПЕЧАТЬ', 'тег картинки сохранился: ' + JSON.stringify(сохр.pages[0].blocks[1]));

// ---------- 1. Картинку не прислали ----------
let пред = await post('/document/preview', { document: ДОК, fields: {} });
ok(пред.status === 200, 'предпросмотр без картинки отвечает');
let блоки = пред.body.document.pages[0].blocks;
ok(блоки.length === 2 && !блоки.some(b => b.imageUrl),
  'блок картинки исчез, пустой рамки нет: ' + JSON.stringify(блоки.map(b => b.imageUrl || 'текст')));

// ---------- 2. Картинку прислали ----------
пред = await post('/document/preview', { document: ДОК, fields: {}, images: { 'ПЕЧАТЬ': 'data:image/png;base64,' + PNG } });
ok(пред.status === 200, 'предпросмотр с картинкой отвечает');
блоки = пред.body.document.pages[0].blocks;
ok(блоки.length === 3, 'все три блока на месте');
ok(/^data:image\/png;base64,/.test(блоки[1].imageUrl || ''), 'картинка встала на место тега');
ok(блоки[1].imageWidth === 40, 'ширина блока сохранилась');

// ---------- 3. Без приставки data: тоже принимается ----------
пред = await post('/document/preview', { document: ДОК, fields: {}, images: { 'ПЕЧАТЬ': JPEG } });
ok(/^data:image\/jpeg;base64,/.test((пред.body.document.pages[0].blocks[1] || {}).imageUrl || ''),
  'голый BASE64 без приставки принят и опознан как JPEG');

// ---------- 4. Чужое под видом картинки ----------
const мусор = await post('/document/preview', { document: ДОК, fields: {}, images: { 'ПЕЧАТЬ': 'data:image/png;base64,' + Buffer.from('<html>это не картинка</html>').toString('base64') } });
ok(мусор.status === 400 && /не PNG/.test((мусор.body || {}).error || ''),
  'подделанная приставка не помогает: ' + JSON.stringify(мусор.body));
const неБаза = await post('/document/preview', { document: ДОК, fields: {}, images: { 'ПЕЧАТЬ': 'совсем не base64!!!' } });
ok(неБаза.status === 400 && /BASE64/.test((неБаза.body || {}).error || ''), 'не BASE64 отклоняется словами');
const огромная = await post('/document/preview', { document: ДОК, fields: {}, images: { 'ПЕЧАТЬ': 'A'.repeat(2 * 1024 * 1024 + 10) } });
ok(огромная.status === 400 && /слишком большая/.test((огромная.body || {}).error || ''), 'слишком большая отклоняется словами');

// ---------- 5. Планшет показывает картинку ----------
const kiosk = await (await browser.newContext({ viewport: { width: 900, height: 1400 } })).newPage();
kiosk.on('pageerror', e => { console.error('FAIL ошибка на планшете: ' + e.message); fail++; });
await kiosk.goto(BASE + '/');
await kiosk.evaluate(t => localStorage.setItem('sk_device_token', t), tok.token);
await kiosk.reload();
await kiosk.waitForTimeout(1500);
ok((await post('/show-document', { target: 'device:' + tok.deviceId, fields: {}, images: { 'ПЕЧАТЬ': 'data:image/png;base64,' + PNG } })).status === 200,
  'документ с картинкой отправлен на планшет');
await kiosk.waitForSelector('text=Текст направления', { timeout: 8000 });
const картинок = await kiosk.locator('#document .doc-image img').count();
ok(картинок === 1, 'картинка показана на планшете (' + картинок + ')');
const src = await kiosk.locator('#document .doc-image img').first().getAttribute('src');
ok(/^data:image\/png;base64,/.test(src || ''), 'и это именно присланная картинка');

// ---------- 6. Запись и PDF ----------
for (let шаг = 0; шаг < 8; шаг++) {
  if (await kiosk.$('#btnSign')) {
    const box = await kiosk.locator('#document canvas').boundingBox();
    await kiosk.mouse.move(box.x + 40, box.y + 40); await kiosk.mouse.down();
    await kiosk.mouse.move(box.x + 200, box.y + 80, { steps: 8 }); await kiosk.mouse.up();
    await kiosk.waitForSelector('#btnSign:not([disabled])', { timeout: 3000 });
    await kiosk.click('#btnSign'); break;
  } else if (await kiosk.$('#btnNext')) {
    await kiosk.waitForSelector('#btnNext:not([disabled])', { timeout: 3000 });
    await kiosk.click('#btnNext'); await kiosk.waitForTimeout(120);
  } else break;
}
await kiosk.waitForSelector('#document .thankyou', { timeout: 8000 });
await admin.waitForTimeout(700);

const { readdirSync, readFileSync } = await import('node:fs');
const SIGDIR = '' + (process.env.SK_RABOTA || '.') + '/data_v3/signatures';
const папка = readdirSync(SIGDIR).sort().reverse()[0];
const хранимое = JSON.parse(readFileSync(SIGDIR + '/' + папка + '/document.json', 'utf8'));
const блокЗаписи = (хранимое.pages[0].blocks || []).find(b => b.imageUrl);
ok(блокЗаписи && /^data:image\/png;base64,/.test(блокЗаписи.imageUrl),
  'картинка лежит в записи целиком: запись самодостаточна');

const записи = (await call('/signatures')).body;
const pdf = await admin.request.get(BASE + '/api/admin/signatures/' + записи[0].id + '/pdf');
const байты = await pdf.body();
ok(pdf.status() === 200 && байты.slice(0, 4).toString('latin1') === '%PDF', 'PDF собран');
// Картинка в PDF означает объект изображения внутри файла.
ok(/\/Subtype\s*\/Image/.test(байты.toString('latin1')), 'картинка вложена в PDF');

// ---------- 7. Запасная картинка ----------
const сЗапасной = JSON.parse(JSON.stringify(ДОК));
сЗапасной.pages[0].blocks[1].imageUrl = '/media/нетакой.png';
пред = await post('/document/preview', { document: сЗапасной, fields: {} });
ok((пред.body.document.pages[0].blocks[1] || {}).imageUrl === '/media/нетакой.png',
  'без присланной картинки остаётся запасная, заданная оператором');
пред = await post('/document/preview', { document: сЗапасной, fields: {}, images: { 'ПЕЧАТЬ': 'data:image/png;base64,' + PNG } });
ok(/^data:image\/png/.test((пред.body.document.pages[0].blocks[1] || {}).imageUrl || ''),
  'присланная картинка перебивает запасную');

await browser.close();
if (fail === 0) console.log('\nВСЁ ПРОЙДЕНО');
process.exit(fail ? 1 : 0);
