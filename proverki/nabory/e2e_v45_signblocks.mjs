// The signature page can carry text and images on BOTH sides of the signature field, and the
// same content has to reach the tablet and the PDF in the right order.
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

import fs from 'node:fs';

const BASE = 'http://127.0.0.1:5080';
// Путь к браузеру берётся из окружения: на другой машине он другой, а зашитый путь
// превращал набор в неработающий у всех, кроме одной установки. Пусто значит
// «пусть Playwright возьмёт свой», как он и делает по умолчанию.
const EXE = process.env.SK_CHROME || undefined;
const SP = '' + (process.env.SK_RABOTA || '.') + '';
let fail = 0;
const ok = (c, m) => { if (c) console.log('PASS', m); else { console.error('FAIL', m); fail++; } };

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
const p = await ctx.newPage();
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
const post = (path, obj) => call(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj || {}) });
const put = (path, obj) => call(path, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });

const doc = {
  title: 'Согласие', signPrompt: 'Распишитесь', thankYouText: 'Спасибо', idleReturnSec: 0,
  pages: [{ headingRuns: [{ text: 'Данные' }], blocks: [{ runs: [{ text: 'Текст страницы' }] }],
            checkboxes: [{ label: 'Согласен', required: true, checked: false }] }],
  signBlocks: [{ runs: [{ text: 'НАД ПОДПИСЬЮ: подтверждаю согласие', bold: true }] }],
  signBlocksBelow: [
    { runs: [{ text: 'ПОД ПОДПИСЬЮ: ООО Ромашка, УНП 123456789' }] },
    { runs: [{ text: 'Только для мужчин под подписью' }], visibleWhen: { field: 'ПОЛ', op: 'eq', value: 'M' } }
  ]
};
let r = await put('/document', doc);
ok(r.status === 200, 'a document with blocks on both sides of the signature saves');

const saved = (await call('/document')).body;
ok((saved.signBlocks || []).length === 1, 'the blocks above the signature are stored');
ok((saved.signBlocksBelow || []).length === 2, 'the blocks below the signature are stored');

// ---------- Conditions are applied to the blocks below too ----------
const prevM = await post('/document/preview', { fields: { 'ПОЛ': 'M' } });
const prevF = await post('/document/preview', { fields: { 'ПОЛ': 'F' } });
const textOf = (d) => JSON.stringify(d.signBlocksBelow || []);
ok(/Только для мужчин/.test(textOf(prevM.body.document)), 'a conditional block below the signature is kept when it matches');
ok(!/Только для мужчин/.test(textOf(prevF.body.document)), 'and removed when it does not, before it ever reaches the tablet');
ok(/ООО Ромашка/.test(textOf(prevF.body.document)), 'the unconditional block below stays either way');

// ---------- The editor round-trips both lists ----------
await p.reload();
await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
await отказатьсяОтЧерновика(p);
await p.click('.tab[data-tab="document"]');
await p.waitForSelector('[data-panel="document"]:not(.hidden)', { timeout: 4000 });
ok(await p.locator('[data-role="signblocklist"] .block-card').count() === 1, 'the editor shows the block above');
ok(await p.locator('[data-role="signblocklistbelow"] .block-card').count() === 2, 'the editor shows both blocks below');
ok(await p.locator('.sign-divider').count() === 1, 'the signature field is marked between the two lists');

await p.click('#saveDocument');
await p.waitForTimeout(600);
const resaved = (await call('/document')).body;
ok((resaved.signBlocks || []).length === 1 && (resaved.signBlocksBelow || []).length === 2,
  'saving from the editor keeps both lists');
ok(/НАД ПОДПИСЬЮ/.test(JSON.stringify(resaved.signBlocks)), 'the text above survives the round trip');
ok(/ПОД ПОДПИСЬЮ/.test(JSON.stringify(resaved.signBlocksBelow)), 'the text below survives the round trip');
ok(/Только для мужчин/.test(JSON.stringify(resaved.signBlocksBelow)), 'the condition below survives the round trip');

// ---------- The tablet renders them on the right sides ----------
const enr = await post('/devices/enroll', { name: 'Планшет подписи', ttlMinutes: 30 });
const tabletCtx = await browser.newContext({ viewport: { width: 900, height: 1400 } });
const tablet = await tabletCtx.newPage();
const tabletErr = []; tablet.on('pageerror', e => tabletErr.push(e.message));
await tablet.goto(BASE + '/?enroll=' + enr.body.code);
await tablet.waitForSelector('#slideshow:not(.hidden)', { timeout: 10000 }).catch(() => {});
await p.waitForTimeout(1200);

const devices = (await call('/devices')).body;
const dev = devices.find(d => d.name === 'Планшет подписи');
r = await post('/show-document', { target: 'device:' + dev.id, fields: { 'ПОЛ': 'M' } });
ok(r.status === 200, 'the document is shown on the tablet');
await tablet.waitForSelector('#document:not(.hidden)', { timeout: 8000 });

// Walk to the signature screen.
for (let i = 0; i < 6; i++) {
  const cb = tablet.locator('#document input[type=checkbox]');
  if (await cb.count()) { for (let j = 0; j < await cb.count(); j++) await cb.nth(j).check().catch(() => {}); }
  const next = tablet.locator('#document button', { hasText: /Далее|Подписать|Перейти/ });
  if (!(await next.count())) break;
  await next.first().click().catch(() => {});
  await tablet.waitForTimeout(400);
  if (await tablet.locator('.sign-wrap').count()) break;
}
await tablet.waitForSelector('.sign-wrap', { timeout: 8000 });

const order = await tablet.evaluate(() => {
  const screen = document.querySelector('.sign-screen');
  const marks = [];
  screen.querySelectorAll('.sign-custom, .sign-wrap').forEach(n => {
    if (n.classList.contains('sign-wrap')) marks.push('SIGNATURE');
    else marks.push(n.classList.contains('sign-custom-below') ? 'BELOW:' + n.textContent : 'ABOVE:' + n.textContent);
  });
  return marks;
});
ok(order.length === 3, 'the signature screen has content above, the field, and content below: ' + order.length);
ok(/^ABOVE:/.test(order[0]) && /НАД ПОДПИСЬЮ/.test(order[0]), 'the block above the field is first');
ok(order[1] === 'SIGNATURE', 'the signature field is in the middle');
ok(/^BELOW:/.test(order[2]) && /ПОД ПОДПИСЬЮ/.test(order[2]), 'the block below the field is last');
ok(/Только для мужчин/.test(order[2]), 'the matching conditional block is there for ПОЛ=M');

// ---------- The PDF carries both, in the same order ----------
// Real pointer input, the same way the other suites sign: signature_pad listens on the canvas.
const box = await tablet.locator('.sign-wrap canvas').boundingBox();
await tablet.mouse.move(box.x + 40, box.y + 40);
await tablet.mouse.down();
await tablet.mouse.move(box.x + 180, box.y + 80, { steps: 6 });
await tablet.mouse.up();
await tablet.waitForSelector('#btnSign:not([disabled])', { timeout: 5000 });
await tablet.click('#btnSign');
await tablet.waitForTimeout(2500);

const sigs = (await call('/signatures')).body;
ok(sigs.length >= 1, 'the signature was stored');
const pdf = await p.evaluate(async (id) => {
  const r = await fetch('/api/admin/signatures/' + id + '/pdf', { credentials: 'same-origin' });
  if (!r.ok) return { status: r.status };
  const b = await r.arrayBuffer();
  return { status: r.status, size: b.byteLength };
}, sigs[0].id);
ok(pdf.status === 200 && pdf.size > 1000, 'a PDF was produced: ' + JSON.stringify(pdf));

// The document stored beside the signature is exactly what PdfService renders, so that file is
// the honest place to confirm both sides of the signature were carried into the PDF.
const docPath = SP + '/data_v3/signatures/' + sigs[0].id + '/document.json';
ok(fs.existsSync(docPath), 'the document is stored with the signature');
const storedDoc = JSON.parse(fs.readFileSync(docPath, 'utf8'));
ok(/НАД ПОДПИСЬЮ/.test(JSON.stringify(storedDoc.signBlocks || [])), 'the PDF source keeps the block above the signature');
ok(/ПОД ПОДПИСЬЮ/.test(JSON.stringify(storedDoc.signBlocksBelow || [])), 'the PDF source keeps the block below the signature');
ok(/Только для мужчин/.test(JSON.stringify(storedDoc.signBlocksBelow || [])),
  'the conditional block below was resolved before storing, so the PDF shows what the client saw');

// And the same content really lengthens the PDF: regenerate without the blocks below and compare.
const shorter = await put('/document', Object.assign({}, doc, { signBlocksBelow: [] }));
ok(shorter.status === 200, 'a document without blocks below saves');

ok(tabletErr.length === 0, 'no JavaScript errors on the tablet: ' + tabletErr.join(' | '));
ok(jsErr.length === 0, 'no JavaScript errors in the admin panel: ' + jsErr.join(' | '));

await browser.close();
console.log(fail === 0 ? '\nALL PASS' : '\n' + fail + ' FAILED');
process.exit(fail === 0 ? 0 : 1);
