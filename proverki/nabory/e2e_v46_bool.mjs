// Boolean tags: cross-border, urine, UG. An integration written the obvious way sends a real JSON
// boolean, and that has to work; a wrong value has to be refused by name rather than quietly
// hiding a block; and a condition saved before a tag became a boolean must keep matching.
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

// Raw bodies, because the point is what the wire carries, not what a helper stringifies.
const post = (path, raw) => p.evaluate(async ([pa, body]) => {
  const r = await fetch('/api/admin' + pa, {
    method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' }, body
  });
  let out = null; try { out = await r.json(); } catch { out = null; }
  return { status: r.status, body: out };
}, [path, raw]);
const call = (path, opts) => p.evaluate(async ([pa, o]) => {
  const r = await fetch('/api/admin' + pa, Object.assign({ credentials: 'same-origin' }, o || {}));
  let body = null; try { body = await r.json(); } catch { body = null; }
  return { status: r.status, body };
}, [path, opts]);
const put = (path, obj) => call(path, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });

// ---------- The tag list comes from the server ----------
const schema = (await call('/field-schema')).body;
const names = schema.fields.map(f => f.name);
ok(names.indexOf('Пол') >= 0 && names.indexOf('ПОЛ') < 0, 'the tag is Пол now, not ПОЛ');
ok(names.indexOf('urine') >= 0 && names.indexOf('UG') >= 0, 'urine and UG are offered');
const valuesOf = (n) => (schema.fields.find(f => f.name === n) || {}).values;
ok(JSON.stringify(valuesOf('Пол')) === '["M","F"]', 'Пол offers M and F');
ok(JSON.stringify(valuesOf('cross-border')) === '["true","false"]', 'cross-border offers true and false');
ok(JSON.stringify(valuesOf('urine')) === '["true","false"]', 'urine offers true and false');
ok(JSON.stringify(valuesOf('UG')) === '["true","false"]', 'UG offers true and false');
ok(valuesOf('ФИО') == null, 'a free-form tag offers no fixed values');

// ---------- A document driven by the boolean tags ----------
await put('/document', {
  title: 'Согласие', signPrompt: 'Распишитесь', thankYouText: 'Спасибо', idleReturnSec: 0,
  pages: [{
    headingRuns: [{ text: 'Данные' }],
    blocks: [
      { runs: [{ text: 'БЛОК-URINE' }], visibleWhen: { field: 'urine', op: 'eq', value: 'true' } },
      { runs: [{ text: 'БЛОК-UG' }], visibleWhen: { field: 'UG', op: 'eq', value: 'true' } },
      { runs: [{ text: 'БЛОК-ЖЕНЩИНЫ' }], visibleWhen: { field: 'Пол', op: 'eq', value: 'F' } },
      // Saved before the tag became a boolean: it has to keep working, not silently stop matching.
      { runs: [{ text: 'БЛОК-СТАРОЕ-ДА' }], visibleWhen: { field: 'cross-border', op: 'eq', value: 'да' } }
    ],
    checkboxes: []
  }],
  signBlocks: [], signBlocksBelow: []
});

const preview = (raw) => post('/document/preview', raw);
const shown = (r) => JSON.stringify((r.body && r.body.document && r.body.document.pages) || []);

// A real JSON boolean, which is what new { urine = true } produces.
let r = await preview('{"fields":{"urine":true,"UG":false,"Пол":"F","cross-border":true}}');
ok(r.status === 200, 'a real JSON boolean is accepted, not rejected with the whole request');
ok(/БЛОК-URINE/.test(shown(r)), 'urine=true shows its block');
ok(!/БЛОК-UG/.test(shown(r)), 'UG=false hides its block');
ok(/БЛОК-ЖЕНЩИНЫ/.test(shown(r)), 'Пол still works after the rename');
ok(/БЛОК-СТАРОЕ-ДА/.test(shown(r)), 'a condition written as "да" matches a tag sent as true');

// The string form, for a caller that prefers it.
r = await preview('{"fields":{"urine":"true","UG":"TRUE"}}');
ok(r.status === 200, 'the string form is accepted too');
ok(/БЛОК-URINE/.test(shown(r)) && /БЛОК-UG/.test(shown(r)), 'and the case does not matter');

// Not sent at all is not the same as false, and must not be an error.
r = await preview('{"fields":{"Пол":"F"}}');
ok(r.status === 200, 'omitting a boolean tag is fine');
ok(!/БЛОК-URINE/.test(shown(r)), 'an omitted boolean tag hides its block');

// ---------- A wrong value is refused by name ----------
for (const bad of ['"да"', '"yes"', '1', '"1"', '"истина"']) {
  const res = await preview('{"fields":{"urine":' + bad + '}}');
  ok(res.status === 400, 'urine=' + bad + ' is refused (' + res.status + ')');
  ok(/urine/.test((res.body || {}).error || ''), 'and the error names the tag: ' + (res.body || {}).error);
}
// The refusal has to say what is allowed, or the integrator is left guessing.
r = await preview('{"fields":{"UG":"maybe"}}');
ok(/true/.test((r.body || {}).error || '') && /false/.test((r.body || {}).error || ''),
  'the error says what is allowed: ' + (r.body || {}).error);

// A free-form tag is untouched by any of this.
r = await preview('{"fields":{"text1":"любой текст","ФИО":"Иванова"}}');
ok(r.status === 200, 'free-form tags accept anything');
r = await preview('{"fields":{"text1":42}}');
ok(r.status === 200, 'a number in a free-form tag no longer rejects the request');

// ---------- The same rules on the real API used by integrations ----------
const key = (await call('/apikeys', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"label":"ERP"}' })).body.key;
const ext = (raw) => p.evaluate(async ([k, body]) => {
  const r = await fetch('/api/ext/show-document', {
    method: 'POST', headers: { 'X-Api-Key': k, 'Content-Type': 'application/json' }, body
  });
  let out = null; try { out = await r.json(); } catch { out = null; }
  return { status: r.status, body: out };
}, [key, raw]);

r = await ext('{"deviceId":"dev-nope","fields":{"urine":"да"}}');
ok(r.status === 400 && /urine/.test((r.body || {}).error || ''),
  'the external API refuses a wrong boolean before anything else: ' + (r.body || {}).error);

// ---------- The editor offers the same values ----------
await p.reload();
await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
await отказатьсяОтЧерновика(p);
await p.click('.tab[data-tab="document"]');
await p.waitForSelector('.cond-box', { timeout: 5000 });
const firstCond = p.locator('.block-card').first().locator('.cond-box');
const badge = firstCond.locator('.cond-badge');
if (await badge.isVisible()) await badge.click();
const tagOptions = await firstCond.locator('select[data-role="cfieldsel"] option').allTextContents();
ok(tagOptions.indexOf('urine') >= 0 && tagOptions.indexOf('UG') >= 0, 'the editor offers the new tags');
ok(tagOptions.indexOf('Пол') >= 0, 'the editor offers Пол');
await firstCond.locator('select[data-role="cfieldsel"]').selectOption('UG');
const valOptions = await firstCond.locator('select[data-role="cvalsel"] option').allTextContents();
ok(valOptions.indexOf('true') >= 0 && valOptions.indexOf('false') >= 0,
  'choosing UG offers true and false: ' + JSON.stringify(valOptions));

ok(jsErr.length === 0, 'no JavaScript errors in the admin panel: ' + jsErr.join(' | '));

await browser.close();
console.log(fail === 0 ? '\nALL PASS' : '\n' + fail + ' FAILED');
process.exit(fail === 0 ? 0 : 1);
