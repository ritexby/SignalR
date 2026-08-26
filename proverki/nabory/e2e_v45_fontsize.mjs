// Enlarging text and then going back to the normal size must actually change what is on screen
// and what gets saved. Size spans nest while editing, and both nesting directions have to work:
// the new span can land inside the old one, or wrap around it, depending on what was selected.
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


const BASE = 'http://127.0.0.1:5080';
// Путь к браузеру берётся из окружения: на другой машине он другой, а зашитый путь
// превращал набор в неработающий у всех, кроме одной установки. Пусто значит
// «пусть Playwright возьмёт свой», как он и делает по умолчанию.
const EXE = process.env.SK_CHROME || undefined;
let fail = 0;
const ok = (c, m) => { if (c) console.log('PASS', m); else { console.error('FAIL', m); fail++; } };

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const p = await (await browser.newContext({ viewport: { width: 1280, height: 1100 } })).newPage();
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
const put = (path, obj) => call(path, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });

// A heading already at the biggest size and in colour, exactly like the one on the live server.
await put('/document', {
  title: 'Согласие', signPrompt: 'Распишитесь', thankYouText: 'Спасибо', idleReturnSec: 0,
  pages: [{
    headingRuns: [{ text: 'Шаг 1. Ознакомление', bold: true, size: 'h', color: '#dc2626' }],
    blocks: [{ runs: [{ text: 'Обычный текст блока' }] }],
    checkboxes: []
  }],
  signBlocks: [], signBlocksBelow: []
});
await p.reload();
await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
await отказатьсяОтЧерновика(p);
await p.click('.tab[data-tab="document"]');
await p.waitForSelector('[data-panel="document"]:not(.hidden)', { timeout: 4000 });

const heading = p.locator('[data-role="heading"]').first();
const sizeOfText = () => p.evaluate(() => {
  const ed = document.querySelector('[data-role="heading"]');
  // The size actually applied to the text node, which is what the operator sees.
  const walk = document.createTreeWalker(ed, NodeFilter.SHOW_TEXT);
  const t = walk.nextNode();
  const holder = t && t.parentElement ? t.parentElement : ed;
  return parseFloat(getComputedStyle(holder).fontSize);
});

const huge = await sizeOfText();
ok(huge > 20, 'the heading starts out enlarged: ' + huge + 'px');

// ---------- Select everything inside the editor and press "A" ----------
async function selectAllIn(role) {
  await p.evaluate((r) => {
    const ed = document.querySelector('[data-role="' + r + '"]');
    ed.focus();
    const range = document.createRange();
    range.selectNodeContents(ed);
    const s = window.getSelection();
    s.removeAllRanges(); s.addRange(range);
  }, role);
}
await selectAllIn('heading');
// Панель оформления теперь одна на всю страницу и всплывает над редактируемым полем.
await p.locator('.rt-toolbar .rt-btn', { hasText: /^A$/ }).first().click();
await p.waitForTimeout(200);

const normal = await sizeOfText();
ok(normal < huge, 'pressing "A" really makes the text smaller on screen: ' + huge + 'px -> ' + normal + 'px');
ok(Math.abs(normal - 16) < 2, 'and lands on the normal size: ' + normal + 'px');

// ---------- What is saved must match what is shown ----------
await p.click('#saveDocument');
await p.waitForTimeout(700);
let doc = (await call('/document')).body;
let runs = doc.pages[0].headingRuns || [];
ok(runs.length >= 1, 'the heading is still there after the change');
ok(runs.every(r => !r.size || r.size === 'n'), 'no run is left at the big size: ' + JSON.stringify(runs.map(r => r.size)));
ok(/Шаг 1/.test(runs.map(r => r.text).join('')), 'the text itself is untouched');
ok(runs.some(r => r.color === '#dc2626'), 'the colour is untouched by a size change');
ok(runs.some(r => r.bold), 'bold is untouched by a size change');

// ---------- And back up again, so the buttons work in both directions ----------
await selectAllIn('heading');
await p.locator('.rt-toolbar .rt-btn', { hasText: /^A\+\+$/ }).first().click();
await p.waitForTimeout(200);
const hugeAgain = await sizeOfText();
ok(hugeAgain > normal, 'enlarging still works after going back to normal: ' + normal + 'px -> ' + hugeAgain + 'px');

await p.click('#saveDocument');
await p.waitForTimeout(700);
doc = (await call('/document')).body;
runs = doc.pages[0].headingRuns || [];
ok(runs.some(r => r.size === 'h'), 'the big size is saved: ' + JSON.stringify(runs.map(r => r.size)));

// ---------- One more round trip, to prove spans are not piling up ----------
await selectAllIn('heading');
await p.locator('.rt-toolbar .rt-btn', { hasText: /^A$/ }).first().click();
await p.waitForTimeout(200);
ok(Math.abs((await sizeOfText()) - 16) < 2, 'the second return to normal works too');

const spanDepth = await p.evaluate(() => {
  const ed = document.querySelector('[data-role="heading"]');
  let deepest = 0;
  ed.querySelectorAll('span').forEach(sp => {
    let d = 0, n = sp;
    while (n && n !== ed) { d++; n = n.parentElement; }
    if (d > deepest) deepest = d;
  });
  return deepest;
});
ok(spanDepth <= 3, 'size changes do not pile spans up without end (depth ' + spanDepth + ')');

// ---------- The same button inside a block, not just a heading ----------
await p.evaluate(() => {
  const ed = document.querySelector('[data-role="blockbody"]');
  ed.focus();
  const range = document.createRange(); range.selectNodeContents(ed);
  const s = window.getSelection(); s.removeAllRanges(); s.addRange(range);
});
const blockBar = p.locator('.rt-toolbar').first();
await blockBar.locator('.rt-btn', { hasText: /^A\+$/ }).click();
await p.waitForTimeout(150);
await p.evaluate(() => {
  const ed = document.querySelector('[data-role="blockbody"]');
  ed.focus();
  const range = document.createRange(); range.selectNodeContents(ed);
  const s = window.getSelection(); s.removeAllRanges(); s.addRange(range);
});
await blockBar.locator('.rt-btn', { hasText: /^A$/ }).click();
await p.waitForTimeout(150);
await p.click('#saveDocument');
await p.waitForTimeout(700);
doc = (await call('/document')).body;
const blockRuns = doc.pages[0].blocks[0].runs || [];
ok(blockRuns.every(r => !r.size || r.size === 'n'), 'a block returns to the normal size too: ' + JSON.stringify(blockRuns.map(r => r.size)));

ok(jsErr.length === 0, 'no JavaScript errors in the admin panel: ' + jsErr.join(' | '));

await browser.close();
console.log(fail === 0 ? '\nALL PASS' : '\n' + fail + ' FAILED');
process.exit(fail === 0 ? 0 : 1);
