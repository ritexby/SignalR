// Составные условия: показывать, только если выполнены оба сразу (Пол равно F И UG равно true).
// Проверяется весь путь: редактор, сохранение, сервер, планшет, предпросмотр.
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
const p = await (await browser.newContext({ viewport: { width: 1500, height: 1100 } })).newPage();
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
const preview = (raw) => p.evaluate(async (body) => {
  const r = await fetch('/api/admin/document/preview', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body });
  let out = null; try { out = await r.json(); } catch { out = null; }
  return { status: r.status, body: out };
}, raw);
const shown = (r) => JSON.stringify(r.body && r.body.document);

// ---------- Сервер: два тега через «и» ----------
// Итог сохранения проверяется вслух: набор, не проверяющий собственную подготовку, при
// неудачном сохранении показывает не свою ошибку, а десяток чужих.
const сохранение = await put('/document', {
  title: 'Согласие', signPrompt: 'Распишитесь', thankYouText: 'Спасибо', idleReturnSec: 0,
  pages: [{
    headingRuns: [{ text: 'Данные' }],
    blocks: [
      { runs: [{ text: 'БЛОК-Ж-И-UG' }], ord: 0,
        visibleWhen: { field: 'Пол', op: 'eq', value: 'F', and: [{ field: 'UG', op: 'eq', value: 'true' }] } },
      { runs: [{ text: 'БЛОК-ТОЛЬКО-Ж' }], visibleWhen: { field: 'Пол', op: 'eq', value: 'F' }, ord: 1 }
    ],
    checkboxes: [{ key: 'consent', label: 'Согласен', required: true, ord: 2 }],
    groups: []
  }],
  signBlocks: [], signBlocksBelow: []
});

ok(сохранение.status === 200, 'документ сохранён: ' + сохранение.status + ' ' + JSON.stringify(сохранение.body).slice(0, 200));

let r = await preview('{"fields":{"Пол":"F","UG":"true"}}');
if (r.status !== 200) { console.error('FAIL предпросмотр вернул ' + r.status + ': ' + JSON.stringify(r.body)); }
ok(/БЛОК-Ж-И-UG/.test(shown(r)), 'обе части выполнены: блок показан');
r = await preview('{"fields":{"Пол":"F","UG":"false"}}');
ok(!/БЛОК-Ж-И-UG/.test(shown(r)), 'вторая часть не выполнена: блок скрыт');
ok(/БЛОК-ТОЛЬКО-Ж/.test(shown(r)), 'а простое условие рядом продолжает работать');
r = await preview('{"fields":{"Пол":"M","UG":"true"}}');
ok(!/БЛОК-Ж-И-UG/.test(shown(r)), 'первая часть не выполнена: блок скрыт');
r = await preview('{"fields":{"Пол":"F"}}');
ok(!/БЛОК-Ж-И-UG/.test(shown(r)), 'непереданный тег во второй части не считается выполненным');

// ---------- Смешанное условие: тег и чекбокс ----------
await put('/document', {
  title: 'Согласие', signPrompt: 'Распишитесь', thankYouText: 'Спасибо', idleReturnSec: 0,
  pages: [{
    headingRuns: [{ text: 'Данные' }],
    blocks: [{ runs: [{ text: 'СМЕШАННЫЙ-БЛОК' }], ord: 1,
      visibleWhen: { field: 'Пол', op: 'eq', value: 'F', and: [{ field: 'consent', op: 'eq', value: 'true' }] } }],
    checkboxes: [{ key: 'consent', label: 'Согласен', required: false, ord: 0 }],
    groups: []
  }],
  signBlocks: [], signBlocksBelow: []
});

r = await preview('{"fields":{"Пол":"M"}}');
ok(!/СМЕШАННЫЙ-БЛОК/.test(shown(r)), 'часть про тег не выполнена: блок вообще не уходит с сервера');
r = await preview('{"fields":{"Пол":"F"}}');
ok(/СМЕШАННЫЙ-БЛОК/.test(shown(r)), 'часть про тег выполнена: блок уходит на планшет');
const doc = (r.body.document.pages[0].blocks || []).find(b => JSON.stringify(b).includes('СМЕШАННЫЙ'));
ok(doc && doc.visibleWhen && doc.visibleWhen.field === 'consent' && !doc.visibleWhen.and,
  'на планшет уезжает только часть про чекбокс, значение тега ему не сообщается: ' + JSON.stringify(doc && doc.visibleWhen));

// ---------- Редактор: добавление и чтение второго условия ----------
await put('/document', {
  title: 'Согласие', signPrompt: 'Распишитесь', thankYouText: 'Спасибо', idleReturnSec: 0,
  pages: [{ headingRuns: [{ text: 'Страница' }], blocks: [{ runs: [{ text: 'Текст' }], ord: 0 }], checkboxes: [], groups: [] }],
  signBlocks: [], signBlocksBelow: []
});
await p.reload();
await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
await отказатьсяОтЧерновика(p);
await p.click('.tab[data-tab="document"]');
await p.waitForSelector('[data-role="itemlist"]', { timeout: 5000 });

const cond = p.locator('.block-card .cond-box').first();
await cond.locator('.cond-badge').click();
await p.waitForTimeout(150);
ok(await cond.locator('[data-role="crow"]').count() === 1, 'сначала одна строка условия');
await cond.locator('[data-role="crow"]').first().locator('[data-role="cfieldsel"]').selectOption('Пол');
await cond.locator('[data-role="crow"]').first().locator('[data-role="cvalsel"]').selectOption('F');

await cond.locator('.cond-add').click();
await p.waitForTimeout(150);
ok(await cond.locator('[data-role="crow"]').count() === 2, 'добавилась вторая строка');
ok(await cond.locator('[data-role="crow"]').nth(1).evaluate(e => e.classList.contains('cond-extra')),
  'вторая строка помечена как присоединённая через «и»');
await cond.locator('[data-role="crow"]').nth(1).locator('[data-role="cfieldsel"]').selectOption('UG');
await cond.locator('[data-role="crow"]').nth(1).locator('[data-role="cvalsel"]').selectOption('true');
await p.waitForTimeout(150);

await p.click('#saveDocument');
await p.waitForTimeout(800);
const saved = (await call('/document')).body.pages[0].blocks[0].visibleWhen;
ok(saved && saved.field === 'Пол' && saved.value === 'F', 'первая часть сохранилась: ' + JSON.stringify(saved));
ok(saved && saved.and && saved.and.length === 1 && saved.and[0].field === 'UG' && saved.and[0].value === 'true',
  'вторая часть сохранилась: ' + JSON.stringify(saved && saved.and));

// Значок читается одной фразой.
await p.reload();
await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
await отказатьсяОтЧерновика(p);
await p.click('.tab[data-tab="document"]');
await p.waitForSelector('[data-role="itemlist"]', { timeout: 5000 });
const badge = await p.locator('.block-card .cond-badge').first().textContent();
ok(/«Пол» равно Ж.* и «UG» равно true/.test(badge), 'значок читается одной фразой: ' + badge);

// Обе строки восстановились из сохранённого документа.
await p.locator('.block-card .cond-box').first().locator('.cond-badge').click();
await p.waitForTimeout(150);
ok(await p.locator('.block-card .cond-box').first().locator('[data-role="crow"]').count() === 2,
  'после перезагрузки обе строки на месте');

// Удаление второй строки возвращает простое условие.
await p.locator('.block-card .cond-box').first().locator('[data-role="crow"]').nth(1).locator('.cond-drop').click();
await p.waitForTimeout(150);
await p.click('#saveDocument');
await p.waitForTimeout(800);
const after = (await call('/document')).body.pages[0].blocks[0].visibleWhen;
ok(after && after.field === 'Пол' && !after.and, 'вторую часть можно убрать: ' + JSON.stringify(after));

// ---------- Планшет: условие на два чекбокса сразу ----------
// Блок появляется, только когда клиент отметил оба пункта, и исчезает, если снял любой из них.
await put('/document', {
  title: 'Согласие', signPrompt: 'Распишитесь', thankYouText: 'Спасибо', idleReturnSec: 0,
  pages: [{
    headingRuns: [{ text: 'Страница' }],
    blocks: [{ runs: [{ text: 'ВИДЕН-ПРИ-ОБОИХ' }], ord: 2,
      visibleWhen: { field: 'a', op: 'eq', value: 'true', and: [{ field: 'b', op: 'eq', value: 'true' }] } }],
    checkboxes: [{ key: 'a', label: 'Первый пункт', required: false, ord: 0 },
                 { key: 'b', label: 'Второй пункт', required: false, ord: 1 }],
    groups: []
  }],
  signBlocks: [], signBlocksBelow: []
});

const code = (await call('/devices/enroll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"name":"И-планшет"}' })).body.code;
const kiosk = await (await browser.newContext()).newPage();
await kiosk.goto(BASE + '/?enroll=' + encodeURIComponent(code));
await kiosk.waitForFunction(() => !!localStorage.getItem('sk_device_token'), { timeout: 12000 });
let deviceId = null;
for (let i = 0; i < 40; i++) {
  const d = (await call('/devices')).body || [];
  const on = d.find(x => x.online);
  if (on) { deviceId = on.id; break; }
  await kiosk.waitForTimeout(250);
}
ok(!!deviceId, 'планшет на связи');
await call('/show-document', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target: 'device:' + deviceId, fields: {} }) });
await kiosk.waitForSelector('.check', { timeout: 8000 });

const visibleOnTablet = () => kiosk.evaluate(() => document.querySelector('.doc-body').textContent.indexOf('ВИДЕН-ПРИ-ОБОИХ') >= 0);
const tick = (n, on) => kiosk.evaluate(([i, v]) => {
  const inputs = document.querySelectorAll('.checks .check input');
  inputs[i].checked = v; inputs[i].dispatchEvent(new Event('change', { bubbles: true }));
}, [n, on]);

ok(!(await visibleOnTablet()), 'пока ничего не отмечено, блока нет');
await tick(0, true); await kiosk.waitForTimeout(250);
ok(!(await visibleOnTablet()), 'отмечен только первый пункт: блока по-прежнему нет');
await tick(1, true); await kiosk.waitForTimeout(250);
ok(await visibleOnTablet(), 'отмечены оба: блок появился');
await tick(0, false); await kiosk.waitForTimeout(250);
ok(!(await visibleOnTablet()), 'сняли первый: блок снова исчез');

ok(jsErr.length === 0, 'ошибок JavaScript нет: ' + jsErr.join(' | '));
await browser.close();
console.log(fail === 0 ? '\nВСЁ ПРОЙДЕНО' : '\n' + fail + ' ПРОВЕРОК УПАЛО');
process.exit(fail === 0 ? 0 : 1);
