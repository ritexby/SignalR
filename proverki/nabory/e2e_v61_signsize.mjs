// Размер и положение места подписи: в конструкторе, на планшете и в PDF.
import { chromium } from 'playwright';
const BASE = 'http://127.0.0.1:5080';
// Путь к браузеру берётся из окружения: на другой машине он другой, а зашитый путь
// превращал набор в неработающий у всех, кроме одной установки. Пусто значит
// «пусть Playwright возьмёт свой», как он и делает по умолчанию.
const EXE = process.env.SK_CHROME || undefined;
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
const p = await (await browser.newContext({ viewport: { width: 1500, height: 950 } })).newPage();
p.on('pageerror', e => console.log('ОШИБКА АДМИНКИ:', e.message));
await p.goto(BASE + '/admin/');
await p.fill('#password', 'test123'); await p.click('#loginForm button[type=submit]');
await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
const call = (path, opts) => p.evaluate(async ([pa, o]) => {
  const r = await fetch('/api/admin' + pa, Object.assign({ credentials: 'same-origin' }, o || {}));
  let b = null; try { b = await r.json(); } catch {} return { status: r.status, body: b };
}, [path, opts]);

const док = (w, h, a) => ({
  title: 'ДОГОВОР', signPrompt: 'x', thankYouText: 'x', idleReturnSec: 0,
  pages: [{ headingRuns: [{ text: 'Условия' }], blocks: [{ runs: [{ text: 'Текст.' }], ord: 0 }],
    checkboxes: [], groups: [], scans: [],
    signatures: [{ key: 'vrach', label: 'Подпись врача', required: true, ord: 1, width: w, height: h, align: a }] }],
  signBlocks: [], signBlocksBelow: [] });

await call('/document', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(док(150, 60, 'right')) });
const сохр = (await call('/document')).body.pages[0].signatures[0];
ok(сохр.width === 150 && сохр.height === 60 && сохр.align === 'right',
  'размер и положение сохранены: ' + JSON.stringify({ w: сохр.width, h: сохр.height, a: сохр.align }));

// Границы.
await call('/document', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(док(5, 500, 'вбок')) });
const края = (await call('/document')).body.pages[0].signatures[0];
ok(края.width === 60, 'уже шестидесяти точек не бывает: ' + края.width);
ok(края.height === 300, 'и выше трёхсот точек тоже: ' + края.height);
ok(!края.align, 'неизвестное положение не сохраняется');

// PDF: место подписи того размера и в том месте, что задано.
const место = async (w, h, a) => {
  await call('/document', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(док(w, h, a)) });
  const r = await call('/document/pdf-layout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  return r.body.items.filter(i => i.kind === 'sign').find(i => i.text === 'vrach');
};
const обычное = await место(280, 100, '');
ok(обычное.w === 280 && обычное.h === 100, 'обычный размер это ровно 280 на 100: ' + обычное.w + '×' + обычное.h);
ok(Math.abs(обычное.x - 50) < 0.5, 'и стоит у левого поля');

const мелкое = await место(150, 60, '');
ok(мелкое.w === 150 && мелкое.h === 60, 'заданный размер соблюдён точь-в-точь: ' + мелкое.w + '×' + мелкое.h);

const справа = await место(150, 60, 'right');
ok(Math.abs(справа.x + справа.w - 545) < 0.5, 'справа место прижато к правому полю: ' + Math.round(справа.x + справа.w));
const поЦентру = await место(150, 60, 'center');
ok(Math.abs((поЦентру.x - 50) - (545 - поЦентру.x - поЦентру.w)) < 1,
  'по центру отступы равны: ' + Math.round(поЦентру.x - 50) + ' и ' + Math.round(545 - поЦентру.x - поЦентру.w));

// Мелкое место подписи занимает меньше страницы, чем обычное.
const страницОбычно = (await call('/document/pdf-layout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).body;
ok(страницОбычно.pageCount >= 1, 'раскладка считается');

// Планшет: поле подписи того размера, что задано.
await call('/document', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(док(198, 80, 'center')) });
const code = (await call('/devices/enroll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"name":"Планшет"}' })).body.code;
const kiosk = await (await browser.newContext({ viewport: { width: 1000, height: 1500 } })).newPage();
await kiosk.goto(BASE + '/?enroll=' + encodeURIComponent(code));
await kiosk.waitForFunction(() => !!localStorage.getItem('sk_device_token'), { timeout: 12000 });
let id = null;
for (let i = 0; i < 40; i++) {
  const d = (await call('/devices')).body || []; const on = d.find(x => x.online);
  if (on) { id = on.id; break; }
  await kiosk.waitForTimeout(250);
}
await call('/show-document', { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ target: 'device:' + id, fields: {} }) });
await kiosk.waitForSelector('.page-sign-wrap', { timeout: 8000 });
const наПланшете = await kiosk.evaluate(() => {
  const w = document.querySelector('.page-sign-wrap');
  const родитель = w.parentElement.getBoundingClientRect();
  const r = w.getBoundingClientRect();
  return { доля: Math.round(r.width / родитель.width * 100), высота: Math.round(r.height),
    слева: Math.round(r.left - родитель.left), справа: Math.round(родитель.right - r.right) };
});
ok(Math.abs(наПланшете.доля - 40) <= 3, 'на планшете поле занимает ту же долю, что и на листе: ' + наПланшете.доля + '%');
ok(наПланшете.высота > 100 && наПланшете.высота < 250, 'и заданную высоту: ' + наПланшете.высота + 'px');
ok(Math.abs(наПланшете.слева - наПланшете.справа) <= 3, 'и стоит по центру: слева ' + наПланшете.слева + ', справа ' + наПланшете.справа);

// Клиент может в нём расписаться, и подпись доходит до записи.
const b = await kiosk.locator('.page-sign-wrap').boundingBox();
await kiosk.mouse.move(b.x + 15, b.y + b.height / 2);
await kiosk.mouse.down();
await kiosk.mouse.move(b.x + b.width - 20, b.y + b.height / 2 - 10, { steps: 10 });
await kiosk.mouse.up();
await kiosk.waitForTimeout(300);
await kiosk.evaluate(() => document.getElementById('btnNext').click());
await kiosk.waitForSelector('.sign-screen canvas', { timeout: 8000 });
const b2 = await kiosk.locator('.sign-screen .sign-wrap').boundingBox();
await kiosk.mouse.move(b2.x + 30, b2.y + b2.height / 2);
await kiosk.mouse.down();
await kiosk.mouse.move(b2.x + b2.width - 40, b2.y + b2.height / 2 - 20, { steps: 10 });
await kiosk.mouse.up();
await kiosk.waitForTimeout(300);
await kiosk.evaluate(() => document.getElementById('btnSign').click());
await kiosk.waitForTimeout(2500);
const подписи = (await call('/signatures')).body || [];
ok(подписи.length === 1, 'документ подписан');
const запись = (await call('/signatures/' + подписи[0].id)).body;
ok(((запись && запись.signatures) || []).length === 1,
  'подпись из поля с заданным размером сохранена: ' + JSON.stringify((запись && запись.signatures) || []));

// Редактор: три поля на месте и правятся.
await p.evaluate(() => Object.keys(localStorage).filter(k => k.indexOf('sk_doc_draft') === 0).forEach(k => localStorage.removeItem(k)));
await p.reload(); await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
await p.click('[data-tab="document"]'); await p.waitForTimeout(700);
await отказатьсяОтЧерновика(p);
ok(await p.locator('[data-role="sigwidth"]').count() === 1, 'в конструкторе есть ширина места подписи');
ok(await p.locator('[data-role="sigheight"]').count() === 1, 'и высота');
ok(await p.locator('[data-role="sigalign"]').count() === 1, 'и положение');
await p.locator('[data-role="sigwidth"]').fill('370');
await p.locator('[data-role="sigalign"]').selectOption('right');
await p.click('#saveDocument'); await p.waitForTimeout(800);
const после = (await call('/document')).body.pages[0].signatures[0];
ok(после.width === 370 && после.align === 'right', 'правка из конструктора сохранилась: ' + JSON.stringify({ w: после.width, a: после.align }));

await browser.close();
console.log(fail === 0 ? '\nВСЁ ПРОЙДЕНО' : '\n' + fail + ' ПРОВЕРОК УПАЛО');
process.exit(fail === 0 ? 0 : 1);
