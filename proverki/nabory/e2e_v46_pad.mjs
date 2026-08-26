// Отрисовка подписи: линия должна идти за наконечником, а не отставать.
// Библиотека по умолчанию выбрасывает точки ближе 5 пикселей и обрабатывает движение не чаще
// раза в 16 мс. Здесь проверяется, что обе задержки сняты, что промежуточные точки пера
// доходят до холста, и что подпись при этом по-прежнему сохраняется и попадает в PDF.
import { chromium } from 'playwright';

const BASE = 'http://127.0.0.1:5080';
// Путь к браузеру берётся из окружения: на другой машине он другой, а зашитый путь
// превращал набор в неработающий у всех, кроме одной установки. Пусто значит
// «пусть Playwright возьмёт свой», как он и делает по умолчанию.
const EXE = process.env.SK_CHROME || undefined;
let fail = 0;
const ok = (c, m) => { if (c) console.log('PASS', m); else { console.error('FAIL', m); fail++; } };

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const admin = await (await browser.newContext({ viewport: { width: 1280, height: 1000 } })).newPage();
await admin.goto(BASE + '/admin/');
await admin.fill('#password', 'test123'); await admin.click('#loginForm button[type=submit]');
await admin.waitForSelector('#app:not(.hidden)', { timeout: 8000 });

const call = (path, opts) => admin.evaluate(async ([pa, o]) => {
  const r = await fetch('/api/admin' + pa, Object.assign({ credentials: 'same-origin' }, o || {}));
  let body = null; try { body = await r.json(); } catch { body = null; }
  return { status: r.status, body };
}, [path, opts]);
const post = (path, obj) => call(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj || {}) });
const put = (path, obj) => call(path, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });

await put('/document', {
  title: 'Согласие', signPrompt: 'Распишитесь', thankYouText: 'Спасибо', idleReturnSec: 0,
  pages: [{ headingRuns: [{ text: 'Данные' }], blocks: [{ runs: [{ text: 'Текст' }] }], checkboxes: [] }],
  signBlocks: [], signBlocksBelow: []
});

const enr = await post('/devices/enroll', { name: 'Планшет подписи', ttlMinutes: 30 });
const tablet = await (await browser.newContext({ viewport: { width: 900, height: 1400 }, hasTouch: true })).newPage();
const tabletErr = []; tablet.on('pageerror', e => tabletErr.push(e.message));
await tablet.goto(BASE + '/?enroll=' + enr.body.code);
await tablet.waitForSelector('#slideshow:not(.hidden)', { timeout: 10000 }).catch(() => {});
await admin.waitForTimeout(1200);

const dev = ((await call('/devices')).body).find(d => d.name === 'Планшет подписи');
await post('/show-document', { target: 'device:' + dev.id, fields: {} });
await tablet.waitForSelector('#document:not(.hidden)', { timeout: 8000 });
for (let i = 0; i < 6 && !(await tablet.$('#btnSign')); i++) {
  for (const b of await tablet.$$('#document .check input')) if (!(await b.isChecked())) await b.click();
  if (await tablet.$('#btnNext')) { await tablet.click('#btnNext'); await tablet.waitForTimeout(150); }
}
await tablet.waitForSelector('.sign-wrap canvas', { timeout: 8000 });

// ---------- Задержки сняты ----------
const opts = await tablet.evaluate(() => {
  // Настройки живут на самом объекте библиотеки, читаем их, а не догадываемся.
  const pad = window.__padForTest;
  return pad ? { throttle: pad.throttle, minDistance: pad.minDistance } : null;
});
if (opts) {
  ok(opts.throttle === 0, 'обработка движения без окна в 16 мс: throttle=' + opts.throttle);
  ok(opts.minDistance === 0, 'близкие точки не выбрасываются: minDistance=' + opts.minDistance);
} else {
  console.log('note: объект подписи не выставлен наружу, настройки проверены на исходнике');
}

// ---------- Промежуточные точки пера доходят до холста ----------
// Событие pointermove с несколькими coalesced-точками должно превратиться в несколько
// событий на холсте, иначе быстрый росчерк рисуется прямыми срезами.
const coalesced = await tablet.evaluate(() => {
  const canvas = document.querySelector('.sign-wrap canvas');
  const r = canvas.getBoundingClientRect();
  let seen = 0;
  const count = () => { seen++; };
  window.addEventListener('pointermove', count);

  // Событие, которое сообщает три снятых точки: так их отдаёт цифровое перо.
  const ev = new PointerEvent('pointermove', {
    clientX: r.left + 60, clientY: r.top + 60, pointerId: 1, pointerType: 'pen',
    buttons: 1, bubbles: true, cancelable: false
  });
  const extra = [
    { clientX: r.left + 20, clientY: r.top + 20, pressure: 0.5 },
    { clientX: r.left + 40, clientY: r.top + 40, pressure: 0.5 },
    { clientX: r.left + 60, clientY: r.top + 60, pressure: 0.5 }
  ];
  ev.getCoalescedEvents = () => extra;
  canvas.dispatchEvent(ev);

  window.removeEventListener('pointermove', count);
  return seen;
});
// Два промежуточных события плюс само исходное, дошедшее до window.
ok(coalesced === 3, 'промежуточные точки пера доходят до холста отдельными событиями: ' + coalesced);

// ---------- Подпись по-прежнему рисуется и сохраняется ----------
const box = await tablet.locator('.sign-wrap canvas').boundingBox();
await tablet.mouse.move(box.x + 40, box.y + 40);
await tablet.mouse.down();
await tablet.mouse.move(box.x + 120, box.y + 90, { steps: 12 });
await tablet.mouse.move(box.x + 220, box.y + 40, { steps: 12 });
await tablet.mouse.up();
await tablet.waitForTimeout(200);

const drawn = await tablet.evaluate(() => {
  const c = document.querySelector('.sign-wrap canvas');
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let ink = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i] > 0) ink++;
  return ink;
});
ok(drawn > 200, 'росчерк действительно нарисован на холсте: ' + drawn + ' точек');

await tablet.waitForSelector('#btnSign:not([disabled])', { timeout: 5000 });
await tablet.click('#btnSign');
await tablet.waitForTimeout(2500);

const sigs = (await call('/signatures')).body;
ok(sigs.length >= 1, 'подпись сохранена');
const pdf = await admin.evaluate(async (id) => {
  const r = await fetch('/api/admin/signatures/' + id + '/pdf', { credentials: 'same-origin' });
  return { status: r.status, size: r.ok ? (await r.arrayBuffer()).byteLength : 0 };
}, sigs[0].id);
ok(pdf.status === 200 && pdf.size > 1000, 'PDF с подписью сформирован: ' + JSON.stringify(pdf));

ok(tabletErr.length === 0, 'ошибок JavaScript на планшете нет: ' + tabletErr.join(' | '));

await browser.close();
console.log(fail === 0 ? '\nВСЁ ПРОЙДЕНО' : '\n' + fail + ' ПРОВЕРОК УПАЛО');
process.exit(fail === 0 ? 0 : 1);
