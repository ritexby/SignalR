// Проверки на то, что нашла ревизия. Каждая доводит дело до наблюдаемого следа: файла записи,
// текста в PDF или того, что видит клиент на экране. Рассуждений тут нет, только факты.
import { chromium } from 'playwright';
import { readFileSync, existsSync, readdirSync, mkdirSync, rmSync } from 'fs';
import { execSync } from 'child_process';
const BASE = 'http://127.0.0.1:5080';
// Путь к браузеру берётся из окружения: на другой машине он другой, а зашитый путь
// превращал набор в неработающий у всех, кроме одной установки. Пусто значит
// «пусть Playwright возьмёт свой», как он и делает по умолчанию.
const EXE = process.env.SK_CHROME || undefined;
const SP = '' + (process.env.SK_RABOTA || '.') + '';
const DATA = SP + '/data_v3';
let fail = 0;
const ok = (c, m) => { if (c) console.log('PASS', m); else { console.error('FAIL', m); fail++; } };
const ПИКСЕЛЬ = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
// Две разные картинки: если файл один перезапишет другой, это будет видно по размеру.
const ПИКСЕЛЬ2 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR42mNkYPhfz0AEYBxVSF+FAP5FBAXjb2fTAAAAAElFTkSuQmCC';

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
const post = (p, o) => call(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o) });
const put = (p, o) => call(p, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o) });

const enr = (await post('/devices/enroll', { name: 'Планшет ревизии', ttlMinutes: 30 })).body;
const tok = await admin.evaluate(async (code) => (await fetch('/api/kiosk/enroll', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code })
})).json(), enr.code);

const kiosk = await (await browser.newContext({ viewport: { width: 1100, height: 1500 } })).newPage();
kiosk.on('pageerror', e => { console.error('FAIL ошибка на планшете: ' + e.message); fail++; });
await kiosk.goto(BASE + '/');
await kiosk.evaluate(t => localStorage.setItem('sk_device_token', t), tok.token);
await kiosk.reload();
await kiosk.waitForTimeout(1200);

const подписать = (тело) => kiosk.evaluate(async (t) => {
  const r = await fetch('/api/sign', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + localStorage.getItem('sk_device_token') },
    body: JSON.stringify(t)
  });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, body: j };
}, тело);

// ================= 1. Блок, открытый вписанным значением, должен попасть в PDF =================
// Клиент вписывает телефон, и от этого на странице появляется абзац. Он его видел, значит он
// должен быть и в PDF: иначе бумага расходится с тем, под чем человек расписался.
await put('/document', {
  kind: 'sign', title: 'Проверка условия по вписанному', signPrompt: 'Распишитесь', thankYouText: 'Спасибо',
  idleReturnSec: 0, pdfFooterBarcode: true, pdfFooterRecordId: true,
  pages: [{
    headingRuns: [{ text: 'Связь' }], includeDynamic: false,
    blocks: [
      { runs: [{ text: 'Всегда видимый абзац.' }], ord: 0 },
      { runs: [{ text: 'СОГЛАСЕН НА ЗВОНКИ ПО ЭТОМУ НОМЕРУ' }], ord: 1,
        visibleWhen: { field: 'телефон', op: 'notempty', value: '' } }
    ],
    inputs: [{ key: 'телефон', label: 'Телефон', kind: 'phone', required: false, ord: 2 }]
  }]
});
await post('/show-document', { target: 'device:' + tok.deviceId, fields: {} });
await kiosk.waitForSelector('text=Всегда видимый абзац', { timeout: 8000 });
ok(!(await kiosk.locator('text=СОГЛАСЕН НА ЗВОНКИ').count()), 'до ввода телефона условный абзац скрыт');
await kiosk.fill('.page-input-field', '+7 999 123 45 67');
await kiosk.waitForTimeout(600);
ok((await kiosk.locator('text=СОГЛАСЕН НА ЗВОНКИ').count()) === 1, 'вписанный телефон открыл абзац на планшете');

const подпись1 = await подписать({
  items: [], groups: [], signatures: [], scans: [],
  inputs: [{ key: 'телефон', value: '+7 999 123 45 67' }],
  signature: ПИКСЕЛЬ, submissionId: 'ревизия-1'
});
ok(подпись1.status === 200, 'подпись принята: ' + JSON.stringify(подпись1.body));
const id1 = (подпись1.body || {}).id;
await new Promise(r => setTimeout(r, 1200));
const пдф1 = DATA + '/pdf/' + id1 + '.pdf';
ok(existsSync(пдф1), 'PDF записи создан');
let текст1 = '';
try { текст1 = execSync('pdftotext -layout ' + пдф1 + ' -', { encoding: 'utf8' }); } catch (e) { текст1 = ''; }
ok(текст1.indexOf('Запись ' + id1) >= 0,
  'номер записи из настроек колонтитула напечатан в PDF (настройка доходит до бумаги)');
ok(/Всегда видимый абзац/.test(текст1), 'обычный абзац в PDF есть');
ok(/СОГЛАСЕН НА ЗВОНКИ/.test(текст1),
  'абзац, который клиент открыл вписанным телефоном, попал в PDF (иначе бумага не совпадает с экраном)');

// ================= 2. Штрихкод записи должен читаться сканером =================
// Штрихкод без символов начала и конца не декодирует ни один сканер: он выглядит штрихкодом,
// но не является им. Проверяем не глазами, а декодером.
// Папку чистим: снимок от прошлого прогона декодировался бы вместо нынешнего, и проверка
// показывала бы чужой номер, ничего при этом не проверяя.
rmSync(SP + '/bc', { recursive: true, force: true });
mkdirSync(SP + '/bc', { recursive: true });
try { execSync('pdftoppm -r 300 -png -f 1 -l 1 ' + пдф1 + ' ' + SP + '/bc/страница'); } catch (e) { /* ниже увидим */ }
const снимки = existsSync(SP + '/bc') ? readdirSync(SP + '/bc').filter(f => f.endsWith('.png')) : [];
ok(снимки.length > 0, 'страница PDF превращена в картинку для декодера');
if (снимки.length) {
  const png = readFileSync(SP + '/bc/' + снимки[0]).toString('base64');
  const декод = await kiosk.evaluate(async (b64) => {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = 'data:image/png;base64,' + b64; });
    const ZX = window.ZXingBrowser || window.ZXing;
    if (!ZX) return { нет: 'библиотека декодера не подключена на странице планшета' };
    // Берём нижнюю полосу листа, а не весь лист: декодер щупает изображение по горизонтальным
    // линиям, и на странице в три тысячи точек высотой тонкий подвал он просто не пересекает.
    // Сканер в руках человека наводят точно так же, на сам код.
    const h = Math.round(img.height * 0.10);
    const c = document.createElement('canvas'); c.width = img.width; c.height = h;
    c.getContext('2d').drawImage(img, 0, img.height - h, img.width, h, 0, 0, img.width, h);
    try {
      const reader = new ZX.BrowserMultiFormatReader();
      const r = await reader.decodeFromCanvas(c);
      return { текст: r && r.getText ? r.getText() : String(r) };
    } catch (e) { return { ошибка: String(e && e.message || e) }; }
  }, png);
  if (декод && декод.нет) console.log('ИНФО ' + декод.нет);
  else ok(декод && декод.текст && String(декод.текст).toUpperCase() === String(id1).toUpperCase(),
    'штрихкод записи в подвале PDF декодируется и равен номеру записи: ' + JSON.stringify(декод));
}

// ================= 3. Отказ сервера объясняется клиенту, а не выдаётся за обрыв связи =================
await put('/document', {
  kind: 'sign', title: 'Проверка отказа', signPrompt: 'Распишитесь', thankYouText: 'Спасибо', idleReturnSec: 0,
  pages: [{ headingRuns: [{ text: 'Согласие' }], includeDynamic: false,
    blocks: [{ runs: [{ text: 'Отметьте пункт ниже.' }], ord: 0 }],
    checkboxes: [{ key: 'soglasie', label: 'Я согласен', required: true, ord: 1 }] }]
});
await post('/show-document', { target: 'device:' + tok.deviceId, fields: {} });
await kiosk.waitForSelector('text=Отметьте пункт ниже', { timeout: 8000 });
// Обходим страницу и отправляем подпись без обязательной отметки: так же сделала бы сломанная
// страница. Сервер обязан отказать, а планшет обязан объяснить причину.
await kiosk.evaluate(async () => {
  window.__ответ = null;
  const r = await fetch('/api/sign', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + localStorage.getItem('sk_device_token') },
    body: JSON.stringify({ items: [{ key: 'soglasie', label: 'Я согласен', checked: false }], groups: [], signatures: [], scans: [], inputs: [],
      signature: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', submissionId: 'ревизия-отказ' })
  });
  window.__ответ = { status: r.status, body: await r.text() };
});
const отказ = await kiosk.evaluate(() => window.__ответ);
ok(отказ.status === 400, 'сервер отказал в записи без обязательной отметки: ' + отказ.status);

// Теперь то же самое, но через кнопку планшета: важно, что видит человек. Чтобы отказ пришёл
// именно от сервера, убираем обязательный пункт из того, что знает страница: снимок на сервере
// его по-прежнему требует. Ровно так расходятся экран и снимок в жизни.
await kiosk.click('.check');
await kiosk.waitForTimeout(200);
await kiosk.click('#btnNext');
await kiosk.waitForSelector('#document canvas', { timeout: 6000 });
const холст = await kiosk.locator('#document canvas').first().boundingBox();
await kiosk.mouse.move(холст.x + 40, холст.y + 50);
await kiosk.mouse.down(); await kiosk.mouse.move(холст.x + 180, холст.y + 90, { steps: 10 }); await kiosk.mouse.up();
await kiosk.waitForTimeout(300);
await kiosk.evaluate(() => {
  const d = window.__docForTest;
  if (d && d.config && d.config.pages && d.config.pages[0]) d.config.pages[0].checkboxes = [];
});
await kiosk.click('#btnSign');
await kiosk.waitForTimeout(2500);
const примечание = await kiosk.evaluate(() => {
  const n = document.getElementById('footerNote');
  if (n && n.textContent.trim()) return n.textContent;
  const f = document.getElementById('docFooter');
  return f ? f.textContent : '';
});
ok(!/нет связи с сервером/i.test(примечание),
  'отказ сервера не выдаётся за обрыв связи: «' + примечание.trim() + '»');
ok(/обязательн/i.test(примечание),
  'клиенту сказано, что именно не так: «' + примечание.trim() + '»');

// ================= 4. Повтор чужой отправки не трогает сессию нового клиента =================
await put('/document', {
  kind: 'sign', title: 'Первый клиент', signPrompt: 'Распишитесь', thankYouText: 'Спасибо', idleReturnSec: 0,
  pages: [{ headingRuns: [{ text: 'Первый' }], includeDynamic: false,
    blocks: [{ runs: [{ text: 'ТЕКСТ ПЕРВОГО КЛИЕНТА' }], ord: 0 }] }]
});
await post('/show-document', { target: 'device:' + tok.deviceId, fields: {} });
await kiosk.waitForSelector('text=ТЕКСТ ПЕРВОГО КЛИЕНТА', { timeout: 8000 });
const первая = await подписать({ items: [], groups: [], signatures: [], scans: [], inputs: [],
  signature: ПИКСЕЛЬ, submissionId: 'ревизия-повтор' });
ok(первая.status === 200, 'первый клиент подписал');

await put('/document', {
  kind: 'sign', title: 'Второй клиент', signPrompt: 'Распишитесь', thankYouText: 'Спасибо', idleReturnSec: 0,
  pages: [{ headingRuns: [{ text: 'Второй' }], includeDynamic: false,
    blocks: [{ runs: [{ text: 'ТЕКСТ ВТОРОГО КЛИЕНТА' }], ord: 0 }] }]
});
await post('/show-document', { target: 'device:' + tok.deviceId, fields: { ФИО: 'Второй Клиент' } });
await kiosk.waitForSelector('text=ТЕКСТ ВТОРОГО КЛИЕНТА', { timeout: 8000 });
const повтор = await подписать({ items: [], groups: [], signatures: [], scans: [], inputs: [],
  signature: ПИКСЕЛЬ, submissionId: 'ревизия-повтор' });
ok(повтор.status === 409, 'повтор отправки первого клиента отклонён: ' + повтор.status);
await new Promise(r => setTimeout(r, 500));
const вторая = await подписать({ items: [], groups: [], signatures: [], scans: [], inputs: [],
  signature: ПИКСЕЛЬ, submissionId: 'ревизия-второй' });
ok(вторая.status === 200,
  'сессия второго клиента жива после чужого повтора: он смог подписать (' + вторая.status + ' ' + JSON.stringify(вторая.body) + ')');

// ================= 5. Сканирование по команде оператора не сбрасывает открытый документ =================
await put('/document', {
  kind: 'sign', title: 'Документ со сканом', signPrompt: 'Распишитесь', thankYouText: 'Спасибо', idleReturnSec: 0,
  pages: [
    { headingRuns: [{ text: 'Страница один' }], includeDynamic: false,
      blocks: [{ runs: [{ text: 'ПЕРВАЯ СТРАНИЦА' }], ord: 0 }],
      checkboxes: [{ key: 'otmetka', label: 'Отметка клиента', required: false, ord: 1 }] },
    { headingRuns: [{ text: 'Страница два' }], includeDynamic: false,
      blocks: [{ runs: [{ text: 'ВТОРАЯ СТРАНИЦА' }], ord: 0 }] }
  ]
});
await post('/show-document', { target: 'device:' + tok.deviceId, fields: {} });
await kiosk.waitForSelector('text=ПЕРВАЯ СТРАНИЦА', { timeout: 8000 });
await kiosk.click('.check');
await kiosk.waitForTimeout(200);
await kiosk.click('#btnNext');
await kiosk.waitForSelector('text=ВТОРАЯ СТРАНИЦА', { timeout: 6000 });
ok((await kiosk.textContent('#docProgress') || '').indexOf('Шаг 2') >= 0, 'клиент на второй странице');

await post('/scan/start', { target: 'device:' + tok.deviceId });
await kiosk.waitForSelector('#scan:not(.hidden)', { timeout: 8000 });
// Код подсовывается тем же путём, каким его отдаёт камера: у проверки камеры нет, а разбирать
// надо именно то, что происходит после считывания. Дальше планшет сам скажет серверу, что
// сканирование закончено, и вот на этом документ и сбрасывался.
await kiosk.evaluate(() => window.__sk_test_scan('1234567890128', 'EAN_13'));
await kiosk.waitForTimeout(5000);
const шаг = (await kiosk.textContent('#docProgress')) || '';
ok(шаг.indexOf('Шаг 2') >= 0, 'после сканирования клиент остался на своей странице: «' + шаг.trim() + '»');
await kiosk.locator('#docFooter .btn', { hasText: 'Назад' }).click();
await kiosk.waitForTimeout(600);
const отмечено = await kiosk.locator('#document input[type=checkbox]:checked').count();
ok(отмечено === 1, 'отметка клиента пережила сканирование: отмечено ' + отмечено);

// ================= 6. Две безымянные подписи внутри страниц не сливаются в одну =================
await put('/document', {
  kind: 'sign', title: 'Две подписи', signPrompt: 'Распишитесь', thankYouText: 'Спасибо', idleReturnSec: 0,
  pages: [
    { headingRuns: [{ text: 'Первая' }], includeDynamic: false,
      blocks: [{ runs: [{ text: 'Первая страница' }], ord: 0 }],
      signatures: [{ key: '', label: 'Подпись на первой', required: false, ord: 1 }] },
    { headingRuns: [{ text: 'Вторая' }], includeDynamic: false,
      blocks: [{ runs: [{ text: 'Вторая страница' }], ord: 0 }],
      signatures: [{ key: '', label: 'Подпись на второй', required: false, ord: 1 }] }
  ]
});
const сохранён = (await call('/document')).body || {};
const ключи = (сохранён.pages || []).map(p => ((p.signatures || [])[0] || {}).key);
ok(ключи.length === 2 && ключи[0] && ключи[1] && ключи[0] !== ключи[1],
  'безымянным полям подписи на разных страницах выданы разные имена: ' + JSON.stringify(ключи));

await post('/show-document', { target: 'device:' + tok.deviceId, fields: {} });
await kiosk.waitForSelector('text=Первая страница', { timeout: 8000 });
const дв = await подписать({
  items: [], groups: [], inputs: [], scans: [],
  signatures: [{ key: ключи[0], label: 'Подпись на первой', image: ПИКСЕЛЬ },
               { key: ключи[1], label: 'Подпись на второй', image: ПИКСЕЛЬ2 }],
  signature: ПИКСЕЛЬ, submissionId: 'ревизия-две-подписи'
});
ok(дв.status === 200, 'запись с двумя подписями внутри страниц сохранена: ' + JSON.stringify(дв.body));
const каталог = DATA + '/signatures/' + (дв.body || {}).id;
const файлы = existsSync(каталог) ? readdirSync(каталог).filter(f => f.startsWith('signature-')) : [];
ok(файлы.length === 2, 'на диске лежат две разные картинки подписей, а не одна поверх другой: ' + JSON.stringify(файлы));

await browser.close();
console.log(fail === 0 ? '\nРЕВИЗИЯ: ВСЁ ПРОЙДЕНО' : '\nРЕВИЗИЯ: ПРОВАЛОВ ' + fail);
process.exit(fail === 0 ? 0 : 1);
