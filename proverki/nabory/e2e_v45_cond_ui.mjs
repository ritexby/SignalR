// The condition editor: choosing a tag and a value must be a matter of picking from a list, and
// changing a choice must not require clearing the box by hand first (the old datalist only
// offered entries matching what was already typed, so a chosen tag left the list looking empty).
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

// A document whose block already carries a condition, so the editor has to show it back.
await put('/document', {
  title: 'Согласие', signPrompt: 'Распишитесь', thankYouText: 'Спасибо', idleReturnSec: 0,
  pages: [{
    headingRuns: [{ text: 'Шаг 1' }],
    blocks: [
      { runs: [{ text: 'Для женщин' }], visibleWhen: { field: 'Пол', op: 'eq', value: 'F' } },
      { runs: [{ text: 'Свой тег' }], visibleWhen: { field: 'my-own-tag', op: 'eq', value: 'x' } }
    ],
    checkboxes: []
  }],
  signBlocks: [], signBlocksBelow: []
});
await p.reload();
await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
await отказатьсяОтЧерновика(p);
await p.click('.tab[data-tab="document"]');
await p.waitForSelector('[data-panel="document"]:not(.hidden)', { timeout: 4000 });

const first = p.locator('.block-card').first();
const firstCond = first.locator('.cond-box');
// Условие показывается свёрнутым значком; чтобы править его, значок надо раскрыть.
const openCond = async (box) => { const b = box.locator('.cond-badge'); if (await b.isVisible()) await b.click(); };
await openCond(firstCond);

// ---------- The tag is a real dropdown ----------
ok(await firstCond.locator('select[data-role="cfieldsel"]').count() === 1, 'the tag is chosen from a dropdown');
ok(await firstCond.locator('select[data-role="cfieldsel"]').inputValue() === 'Пол', 'the stored tag is selected');

const tagOptions = await firstCond.locator('select[data-role="cfieldsel"] option').allTextContents();
ok(tagOptions.indexOf('Пол') >= 0 && tagOptions.indexOf('cross-border') >= 0, 'every known tag is offered');
ok(tagOptions.some(t => /другой тег/.test(t)), 'a tag outside the list is still possible');

// The complaint: with a tag already chosen, choosing another one must just work.
await firstCond.locator('select[data-role="cfieldsel"]').selectOption('cross-border');
ok(await firstCond.locator('select[data-role="cfieldsel"]').inputValue() === 'cross-border',
  'a different tag can be chosen without clearing the field first');

// ---------- The value follows the tag ----------
let valOptions = await firstCond.locator('select[data-role="cvalsel"] option').allTextContents();
ok(valOptions.indexOf('true') >= 0 && valOptions.indexOf('false') >= 0,
  'у cross-border свои значения: ' + JSON.stringify(valOptions));

await firstCond.locator('select[data-role="cfieldsel"]').selectOption('Пол');
valOptions = await firstCond.locator('select[data-role="cvalsel"] option').evaluateAll(ns => ns.map(n => n.value));
const valLabels = await firstCond.locator('select[data-role="cvalsel"] option').allTextContents();
ok(valOptions.indexOf('M') >= 0 && valOptions.indexOf('F') >= 0, 'Пол sends M and F: ' + JSON.stringify(valOptions));
ok(valLabels.some(t => /Ж/.test(t)) && valLabels.some(t => /М/.test(t)),
  'and shows them in Russian: ' + JSON.stringify(valLabels));
ok(valLabels.some(t => /другое/.test(t)), 'a value outside the list is still possible');

// A tag with no fixed set keeps a plain text box.
await firstCond.locator('select[data-role="cfieldsel"]').selectOption('ФИО');
ok(await firstCond.locator('input[data-role="cval"]').isVisible(), 'a free-form tag keeps a text box for the value');
ok(!(await firstCond.locator('select[data-role="cvalsel"]').isVisible()), 'and no value dropdown');

// ---------- Saving keeps exactly what was chosen ----------
await firstCond.locator('select[data-role="cfieldsel"]').selectOption('Пол');
await firstCond.locator('select[data-role="cvalsel"]').selectOption('M');
await p.click('#saveDocument');
await p.waitForTimeout(700);
let doc = (await call('/document')).body;
let cond = doc.pages[0].blocks[0].visibleWhen;
ok(cond && cond.field === 'Пол' && cond.value === 'M', 'the chosen tag and value are saved: ' + JSON.stringify(cond));

// ---------- A tag outside the list still round-trips ----------
const second = p.locator('.block-card').nth(1).locator('.cond-box');
await openCond(second);
ok(await second.locator('select[data-role="cfieldsel"]').inputValue() !== 'Пол', 'the custom tag did not become a known one');
ok(await second.locator('input[data-role="cfield"]').inputValue() === 'my-own-tag', 'the custom tag is shown in its own box');
ok(await second.locator('input[data-role="cval"]').inputValue() === 'x', 'its value is shown too');

await p.click('#saveDocument');
await p.waitForTimeout(700);
doc = (await call('/document')).body;
cond = doc.pages[0].blocks[1].visibleWhen;
ok(cond && cond.field === 'my-own-tag' && cond.value === 'x', 'a custom tag survives a save: ' + JSON.stringify(cond));

// ---------- "одно из" takes a list, so it must not be a single-choice dropdown ----------
await firstCond.locator('select[data-role="cop"]').selectOption('in');
ok(await firstCond.locator('input[data-role="cval"]').isVisible(), '"одно из" gets a text box for the comma separated list');
await firstCond.locator('input[data-role="cval"]').fill('M,F');
await p.click('#saveDocument');
await p.waitForTimeout(700);
doc = (await call('/document')).body;
cond = doc.pages[0].blocks[0].visibleWhen;
ok(cond && cond.op === 'in' && cond.value === 'M,F', 'a list of values is saved as typed: ' + JSON.stringify(cond));

// ---------- "пусто" needs no value at all ----------
await firstCond.locator('select[data-role="cop"]').selectOption('empty');
ok(!(await firstCond.locator('input[data-role="cval"]').isVisible()), '"пусто" hides the value box');
ok(!(await firstCond.locator('select[data-role="cvalsel"]').isVisible()), '"пусто" hides the value dropdown');

// ---------- The preview offers the same values ----------
await firstCond.locator('select[data-role="cop"]').selectOption('eq');
await firstCond.locator('select[data-role="cfieldsel"]').selectOption('Пол');
await p.click('#previewDoc');
await p.waitForSelector('.preview-setup', { timeout: 4000 });
const previewSel = p.locator('.preview-setup label.field select');
ok(await previewSel.count() >= 1, 'the preview offers a dropdown for a tag with fixed values');
const previewOptions = await previewSel.first().locator('option').evaluateAll(ns => ns.map(n => n.value));
ok(previewOptions.indexOf('M') >= 0 && previewOptions.indexOf('F') >= 0,
  'the preview dropdown carries the same values: ' + JSON.stringify(previewOptions));

ok(jsErr.length === 0, 'no JavaScript errors in the admin panel: ' + jsErr.join(' | '));

await browser.close();
console.log(fail === 0 ? '\nALL PASS' : '\n' + fail + ' FAILED');
process.exit(fail === 0 ? 0 : 1);
