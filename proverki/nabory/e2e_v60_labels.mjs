// Оформление текста пунктов, вариантов и заголовков групп: как у обычных абзацев.
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

await call('/document', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
  title: 'СОГЛАСИЕ', signPrompt: 'Распишитесь', thankYouText: 'Спасибо', idleReturnSec: 0,
  pages: [{ headingRuns: [{ text: 'Условия' }], blocks: [], signatures: [], scans: [],
    checkboxes: [{ key: 'vazhno', required: true, ord: 0,
      labelRuns: [{ text: 'Подтверждаю ' }, { text: 'важное', bold: true, color: '#dc2626', size: 'l' },
                  { text: ' условие' }] }],
    groups: [{ key: 'pisha', required: true, ord: 1,
      titleRuns: [{ text: 'Голодание ' }, { text: 'обязательно', bold: true, color: '#2563eb' }],
      options: [{ key: 'da', labelRuns: [{ text: 'ДА', bold: true, size: 'l' }] },
                { key: 'net', labelRuns: [{ text: 'НЕТ', italic: true }] }] }] }],
  signBlocks: [], signBlocksBelow: [] }) });

// Простой текст держится в согласии с оформленным: по нему пункт узнают в записи и в API.
const сохр = (await call('/document')).body;
const cb = сохр.pages[0].checkboxes[0];
ok(cb.label === 'Подтверждаю важное условие', 'простой текст пункта собран из оформленного: ' + cb.label);
ok((cb.labelRuns || []).length === 3, 'оформление сохранено: кусков ' + (cb.labelRuns || []).length);
ok(cb.labelRuns[1].bold === true && cb.labelRuns[1].color === '#dc2626' && cb.labelRuns[1].size === 'l',
  'жирный, цвет и размер на месте: ' + JSON.stringify(cb.labelRuns[1]));
const гр = сохр.pages[0].groups[0];
ok(гр.title === 'Голодание обязательно', 'заголовок группы простым текстом: ' + гр.title);
ok(гр.options[0].label === 'ДА' && гр.options[0].labelRuns[0].bold === true, 'вариант тоже оформлен');

// Планшет рисует оформление.
const code = (await call('/devices/enroll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"name":"Планшет"}' })).body.code;
const kiosk = await (await browser.newContext({ viewport: { width: 800, height: 1200 } })).newPage();
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
await kiosk.waitForSelector('.check', { timeout: 8000 });
const наПланшете = await kiosk.evaluate(() => {
  const n = Array.from(document.querySelectorAll('.checks .check .label'))
    .find(x => x.textContent.includes('Подтверждаю'));
  if (!n) return null;
  const b = Array.from(n.querySelectorAll('*')).find(x => x.textContent === 'важное');
  if (!b) return { нетКуска: n.innerHTML.slice(0, 120) };
  const cs = getComputedStyle(b);
  return { текст: n.textContent, вес: cs.fontWeight, цвет: cs.color, размер: cs.fontSize,
    обычныйРазмер: getComputedStyle(n).fontSize };
});
ok(наПланшете && !наПланшете.нетКуска, 'оформленный кусок дошёл до планшета: ' + JSON.stringify(наПланшете));
ok(наПланшете.текст === 'Подтверждаю важное условие *' || наПланшете.текст.includes('Подтверждаю важное условие'),
  'текст пункта целиком: ' + наПланшете.текст);
ok(parseInt(наПланшете.вес, 10) >= 600, 'жирный на планшете: ' + наПланшете.вес);
ok(/220|dc2626|rgb\(220, 38, 38\)/.test(наПланшете.цвет), 'цвет на планшете: ' + наПланшете.цвет);
ok(parseFloat(наПланшете.размер) > parseFloat(наПланшете.обычныйРазмер),
  'крупнее обычного: ' + наПланшете.размер + ' против ' + наПланшете.обычныйРазмер);

const заголовокГруппы = await kiosk.evaluate(() => {
  const n = document.querySelector('.group-title');
  const b = n ? Array.from(n.querySelectorAll('*')).find(x => x.textContent === 'обязательно') : null;
  return b ? { вес: getComputedStyle(b).fontWeight, цвет: getComputedStyle(b).color } : null;
});
ok(!!заголовокГруппы && parseInt(заголовокГруппы.вес, 10) >= 600, 'заголовок группы оформлен: ' + JSON.stringify(заголовокГруппы));

// Редактор: текст пункта правится с оформлением.
await p.evaluate(() => Object.keys(localStorage).filter(k => k.indexOf('sk_doc_draft') === 0).forEach(k => localStorage.removeItem(k)));
await p.reload(); await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
await p.click('[data-tab="document"]'); await p.waitForTimeout(700);
await отказатьсяОтЧерновика(p);
const поле = p.locator('[data-role="cblabel"]').first();
ok(await поле.count() === 1, 'текст пункта редактируется полем с оформлением');
ok((await поле.textContent()).includes('Подтверждаю важное условие'), 'и показывает свой текст');
ok(await поле.locator('b, strong, .rt-l, [style*="color"]').count() >= 1, 'оформление видно прямо в редакторе');

// Панель оформления цепляется к этому полю.
await поле.click();
await p.waitForTimeout(300);
ok(!(await p.locator('.rt-toolbar').getAttribute('class')).includes('rt-idle'),
  'панель оформления ожила для текста пункта');

// Правка сохраняется вместе с оформлением.
await p.evaluate(() => {
  const ed = document.querySelector('[data-role="cblabel"]');
  ed.focus();
  const r = document.createRange();
  r.selectNodeContents(ed);
  const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
});
await p.locator('.rt-toolbar button', { hasText: 'К' }).first().click();
await p.waitForTimeout(200);
await p.click('#saveDocument'); await p.waitForTimeout(800);
const после = (await call('/document')).body.pages[0].checkboxes[0];
ok((после.labelRuns || []).some(r => r.italic), 'курсив, поставленный в редакторе, сохранился: ' + JSON.stringify(после.labelRuns));
ok(после.label === 'Подтверждаю важное условие', 'простой текст не изменился: ' + после.label);

await browser.close();
console.log(fail === 0 ? '\nВСЁ ПРОЙДЕНО' : '\n' + fail + ' ПРОВЕРОК УПАЛО');
process.exit(fail === 0 ? 0 : 1);
