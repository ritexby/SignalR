import { chromium } from 'playwright';
const BASE = 'http://127.0.0.1:5080';
// Путь к браузеру берётся из окружения: на другой машине он другой, а зашитый путь
// превращал набор в неработающий у всех, кроме одной установки. Пусто значит
// «пусть Playwright возьмёт свой», как он и делает по умолчанию.
const EXE = process.env.SK_CHROME || undefined;
let fail = 0;
const ok = (c, m) => { if (c) console.log('PASS', m); else { console.error('FAIL', m); fail++; } };

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const admin = await (await browser.newContext()).newPage();
const jsErr = [];
admin.on('pageerror', e => jsErr.push(e.message));
await admin.goto(BASE + '/admin/');
await admin.fill('#password', 'test123');
await admin.click('#loginForm button[type=submit]');
await admin.waitForSelector('#app:not(.hidden)', { timeout: 8000 });

await admin.click('.tab[data-tab="document"]');
await admin.waitForSelector('[data-panel="document"]:not(.hidden)', { timeout: 4000 });
await admin.waitForSelector('#pagesEditor .page-card', { timeout: 4000 });

// Simulate rich editing in the first page: styled heading, a styled+tagged block, a block condition.
await admin.evaluate(() => {
  const card = document.querySelector('#pagesEditor .page-card');
  card.querySelector('[data-role="heading"]').innerHTML =
    'Привет <b>мир</b> <span class="rt-h" style="color:#dc2626">большой</span>';
  const block = card.querySelector('[data-role="blockbody"]');
  block.innerHTML = 'Текст <i>курсив</i> {{ФИО}}';
  const cond = card.querySelector('[data-role="blockcond"]');
  const mode = cond.querySelector('.cond-mode'); mode.value = 'cond'; mode.dispatchEvent(new Event('change'));
  cond.querySelector('[data-role="cfield"]').value = 'ПОЛ';
  cond.querySelector('[data-role="cop"]').value = 'eq';
  cond.querySelector('[data-role="cval"]').value = 'F';
});
await admin.click('#saveDocument');
await admin.waitForTimeout(400);

const saved = await admin.evaluate(async () => (await fetch('/api/admin/document', { credentials: 'same-origin' })).json());
const p0 = saved.pages[0];
const hr = p0.headingRuns || [];
const findRun = (arr, t) => arr.find(r => (r.text || '').trim() === t);

ok(!!findRun(hr, 'мир') && findRun(hr, 'мир').bold === true, 'heading: "мир" serialized as bold run');
const big = findRun(hr, 'большой');
ok(big && big.size === 'h' && big.color === '#dc2626', 'heading: "большой" serialized as huge + red: ' + JSON.stringify(big));

const b0 = (p0.blocks && p0.blocks[0]) || {};
const br = b0.runs || [];
ok(!!findRun(br, 'курсив') && findRun(br, 'курсив').italic === true, 'block: "курсив" serialized as italic run');
ok(br.some(r => (r.text || '').includes('{{ФИО}}')), 'block keeps the {{ФИО}} tag as plain text');
ok(b0.visibleWhen && b0.visibleWhen.field === 'ПОЛ' && b0.visibleWhen.op === 'eq' && b0.visibleWhen.value === 'F',
  'block condition ПОЛ=F serialized: ' + JSON.stringify(b0.visibleWhen));

// Reload round-trip: the styled heading must come back into the editor as styled DOM.
await admin.reload();
if (await admin.$('#loginForm')) {
  const vis = await admin.evaluate(() => { const f = document.getElementById('loginForm'); return f && f.offsetParent !== null; });
  if (vis) { await admin.fill('#password', 'test123'); await admin.click('#loginForm button[type=submit]'); }
}
await admin.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
await admin.click('.tab[data-tab="document"]');
await admin.waitForSelector('#pagesEditor .page-card', { timeout: 4000 });
await admin.waitForTimeout(200);
const reloaded = await admin.evaluate(() => {
  const card = document.querySelector('#pagesEditor .page-card');
  const h = card.querySelector('[data-role="heading"]');
  const big = Array.from(h.querySelectorAll('span')).find(s => s.textContent.trim() === 'большой');
  return { hasBold: !!h.querySelector('b') || /font-weight/.test(h.innerHTML), bigClass: big && big.className, bigColor: big && big.style.color };
});
ok(reloaded.bigClass === 'rt-h', 'reload: "большой" comes back with rt-h class');
ok(/#dc2626|220/.test(reloaded.bigColor || ''), 'reload: "большой" keeps red colour: ' + reloaded.bigColor);

ok(jsErr.length === 0, 'no admin JS errors (' + JSON.stringify(jsErr) + ')');

await browser.close();
console.log(fail === 0 ? '\nV4.2 EDITOR ROUND-TRIP PASSED' : `\n${fail} CHECK(S) FAILED`);
process.exit(fail === 0 ? 0 : 1);
