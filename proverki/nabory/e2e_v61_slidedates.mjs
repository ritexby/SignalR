// Сроки показа картинок в рекламе: с какого и по какой день.
import { chromium } from 'playwright';
const BASE = 'http://127.0.0.1:5080';
// Путь к браузеру берётся из окружения: на другой машине он другой, а зашитый путь
// превращал набор в неработающий у всех, кроме одной установки. Пусто значит
// «пусть Playwright возьмёт свой», как он и делает по умолчанию.
const EXE = process.env.SK_CHROME || undefined;
let fail = 0;
const ok = (c, m) => { if (c) console.log('PASS', m); else { console.error('FAIL', m); fail++; } };
const день = (сдвиг) => { const d = new Date(); d.setDate(d.getDate() + сдвиг);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const p = await (await browser.newContext({ viewport: { width: 1500, height: 950 } })).newPage();
p.on('pageerror', e => console.log('ОШИБКА АДМИНКИ:', e.message));
await p.goto(BASE + '/admin/');
await p.fill('#password', 'test123'); await p.click('#loginForm button[type=submit]');
await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
const call = (path, opts) => p.evaluate(async ([pa, o]) => {
  const r = await fetch('/api/admin' + pa, Object.assign({ credentials: 'same-origin' }, o || {}));
  let b = null; try { b = await r.json(); } catch {} return { status: r.status, body: b };
}, [path, opts]);

// Три картинки: одна без сроков, одна только для будущего, одна уже просроченная.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAFUlEQVR42mNk+M/wn4EIwDiqkL4KAcT9A/1G3AxaAAAAAElFTkSuQmCC';
const залить = (имя) => p.evaluate(async ([b64, n]) => {
  const bin = atob(b64), arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  const fd = new FormData();
  fd.append('files', new Blob([arr], { type: 'image/png' }), n);
  const r = await fetch('/api/admin/images', { method: 'POST', credentials: 'same-origin', body: fd });
  // Ответ загрузки: список принятых и список отклонённых с причиной. Раньше был просто массив,
  // и молча пропущенный файл выглядел как успешно загруженный.
  const ответ = await r.json();
  return (ответ.added || ответ)[0];
}, [PNG, имя]);

const всегда = await залить('vsegda.png');
const будущее = await залить('budushee.png');
const прошлое = await залить('proshloe.png');
ok(!!всегда && !!будущее && !!прошлое, 'три картинки загружены');

await call('/images/' + будущее.id + '/dates', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ showFrom: день(3), showTo: день(10) }) });
await call('/images/' + прошлое.id + '/dates', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ showFrom: день(-20), showTo: день(-2) }) });

const список = (await call('/images')).body;
const по = {}; список.forEach(i => { по[i.originalName] = i; });
ok(по['vsegda.png'].showsToday === true, 'картинка без сроков показывается сегодня');
ok(по['budushee.png'].showsToday === false, 'будущая сегодня не показывается');
ok(по['proshloe.png'].showsToday === false, 'просроченная тоже');
ok(по['budushee.png'].showFrom === день(3), 'дата начала сохранена: ' + по['budushee.png'].showFrom);
ok(по['budushee.png'].showTo === день(10), 'и дата окончания: ' + по['budushee.png'].showTo);

// Плейлист из трёх, а планшет получает только ту, что показывается сегодня.
await call('/playlist', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ target: 'all', imageIds: [всегда.id, будущее.id, прошлое.id], intervalSec: 5 }) });
const code = (await call('/devices/enroll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"name":"Планшет"}' })).body.code;
const kiosk = await (await browser.newContext({ viewport: { width: 900, height: 1400 } })).newPage();
await kiosk.goto(BASE + '/?enroll=' + encodeURIComponent(code));
await kiosk.waitForFunction(() => !!localStorage.getItem('sk_device_token'), { timeout: 12000 });
await kiosk.waitForTimeout(2500);
const список0 = await kiosk.evaluate(() => window.__slidesForTest || []);
ok(список0.length === 1, 'планшет получил ровно одну картинку: ' + JSON.stringify(список0));
ok(список0[0].indexOf(всегда.url.split('/').pop()) >= 0, 'и это картинка без сроков');

// Срок открыли: планшет получает картинку сразу, без перезагрузки.
await call('/images/' + будущее.id + '/dates', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ showFrom: день(-1), showTo: день(10) }) });
await kiosk.waitForTimeout(2000);
const после = await kiosk.evaluate(() => window.__slidesForTest || []);
ok(после.some(u => u.indexOf(будущее.url.split('/').pop()) >= 0),
  'после открытия срока картинка доехала до планшета без перезагрузки: ' + JSON.stringify(после));

// Срок наоборот отклоняется с понятной ошибкой.
const наоборот = await call('/images/' + всегда.id + '/dates', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ showFrom: день(10), showTo: день(1) }) });
ok(наоборот.status === 400 && /никогда/.test(JSON.stringify(наоборот.body)),
  'срок наоборот отклонён: ' + JSON.stringify(наоборот.body));
const мусор = await call('/images/' + всегда.id + '/dates', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ showFrom: 'скоро' }) });
ok(мусор.status === 400, 'неразобранная дата отклонена: ' + мусор.status);

// Пустые даты снимают ограничение.
await call('/images/' + прошлое.id + '/dates', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ showFrom: '', showTo: '' }) });
const снято = ((await call('/images')).body || []).find(i => i.originalName === 'proshloe.png');
ok(!снято.showFrom && !снято.showTo && снято.showsToday === true, 'пустые даты сняли ограничение');

// В админке у карточки есть оба поля и метка состояния.
await p.reload();
await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
await p.click('[data-tab="slides"]'); await p.waitForTimeout(1200);
const карточек = await p.locator('#imageGrid .card').count();
ok(карточек === 3, 'три карточки картинок в админке: ' + карточек);
ok(await p.locator('#imageGrid .card .img-dates input[type=date]').count() === 6, 'у каждой карточки два поля даты');
const метки = await p.locator('#imageGrid .card .img-date-state').allTextContents();
ok(метки.some(t => /показывается всегда/.test(t)), 'карточка без сроков подписана «показывается всегда»');
ok(метки.some(t => /сегодня не показывается|показывается сегодня/.test(t)), 'а со сроками сказано, идёт ли она сегодня: ' + JSON.stringify(метки));

await browser.close();
console.log(fail === 0 ? '\nВСЁ ПРОЙДЕНО' : '\n' + fail + ' ПРОВЕРОК УПАЛО');
process.exit(fail === 0 ? 0 : 1);
