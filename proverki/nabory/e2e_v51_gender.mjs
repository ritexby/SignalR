// Пол показывается по-русски (Ж и М), а на проводе остаётся M и F: так его шлёт внешняя
// система и так записаны уже существующие условия. Плюс кнопка заполнения примером в окне
// отправки: сами вымышленные значения туда не подставляются, документ уходит живому человеку.
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
  let b = null; try { b = await r.json(); } catch {} return { status: r.status, body: b };
}, [path, opts]);
const preview = (raw) => p.evaluate(async (body) => {
  const r = await fetch('/api/admin/document/preview', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body });
  let out = null; try { out = await r.json(); } catch {}
  return { status: r.status, body: out };
}, raw);

// Сервер отдаёт и значения, и подписи к ним.
const schema = (await call('/field-schema')).body;
const пол = schema.fields.find(f => f.name === 'Пол');
ok(JSON.stringify(пол.values) === '["M","F"]', 'на проводе значения прежние: ' + JSON.stringify(пол.values));
ok(пол.valueLabels && /Ж/.test(пол.valueLabels.F) && /М/.test(пол.valueLabels.M),
  'подписи для человека русские: ' + JSON.stringify(пол.valueLabels));

// Внешняя система может прислать и латиницу, и кириллицу.
await call('/document', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
  title: 'Согласие', signPrompt: 'Распишитесь', thankYouText: 'Спасибо', idleReturnSec: 0,
  pages: [{ headingRuns: [{ text: 'Данные' }],
    blocks: [{ runs: [{ text: 'пол: {{Пол}}' }], ord: 0 },
             { runs: [{ text: 'БЛОК-Ж' }], ord: 1, visibleWhen: { field: 'Пол', op: 'eq', value: 'F' } },
             { runs: [{ text: 'БЛОК-М' }], ord: 2, visibleWhen: { field: 'Пол', op: 'eq', value: 'M' } }],
    checkboxes: [], groups: [] }],
  signBlocks: [], signBlocksBelow: [] }) });

for (const [прислали, ожидаем] of [['F', 'БЛОК-Ж'], ['Ж', 'БЛОК-Ж'], ['ж', 'БЛОК-Ж'], ['M', 'БЛОК-М'], ['М', 'БЛОК-М'], ['муж', 'БЛОК-М']]) {
  const r = await preview(JSON.stringify({ fields: { 'Пол': прислали } }));
  const t = JSON.stringify(r.body.document);
  const другой = ожидаем === 'БЛОК-Ж' ? 'БЛОК-М' : 'БЛОК-Ж';
  ok(t.indexOf(ожидаем) >= 0 && t.indexOf(другой) < 0, 'прислали «' + прислали + '»: показан ' + ожидаем);
}

// Условие, записанное по-русски, тоже работает.
await call('/document', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
  title: 'Согласие', signPrompt: 'Распишитесь', thankYouText: 'Спасибо', idleReturnSec: 0,
  pages: [{ headingRuns: [{ text: 'Данные' }],
    blocks: [{ runs: [{ text: 'БЛОК-ПО-РУССКИ' }], ord: 0, visibleWhen: { field: 'Пол', op: 'eq', value: 'Ж' } }],
    checkboxes: [], groups: [] }],
  signBlocks: [], signBlocksBelow: [] }) });
let r = await preview('{"fields":{"Пол":"F"}}');
ok(/БЛОК-ПО-РУССКИ/.test(JSON.stringify(r.body.document)), 'условие «Ж» срабатывает от присланного F');
r = await preview('{"fields":{"Пол":"M"}}');
ok(!/БЛОК-ПО-РУССКИ/.test(JSON.stringify(r.body.document)), 'и не срабатывает от M');

// В интерфейсе выбор по-русски.
await p.reload(); await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
await отказатьсяОтЧерновика(p);
await p.click('.tab[data-tab="document"]');
await p.waitForSelector('.cond-box', { timeout: 5000 });
const badge = p.locator('.block-card .cond-badge').first();
ok(/Ж \(женский\)|Ж/.test(await badge.textContent()), 'значок условия читается по-русски: ' + await badge.textContent());
await badge.click(); await p.waitForTimeout(200);
const подписи = await p.locator('.block-card [data-role="cvalsel"] option').allTextContents();
ok(подписи.some(t => /Ж/.test(t)) && подписи.some(t => /М/.test(t)), 'в списке значений Ж и М: ' + JSON.stringify(подписи));
const значения = await p.locator('.block-card [data-role="cvalsel"] option').evaluateAll(ns => ns.map(n => n.value));
ok(значения.indexOf('F') >= 0 && значения.indexOf('M') >= 0, 'а уходят по-прежнему M и F: ' + JSON.stringify(значения));

// Окно отправки: пусто по умолчанию, кнопка заполняет.
const code = (await call('/devices/enroll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"name":"Планшет"}' })).body.code;
const kiosk = await (await browser.newContext()).newPage();
await kiosk.goto(BASE + '/?enroll=' + encodeURIComponent(code));
await kiosk.waitForFunction(() => !!localStorage.getItem('sk_device_token'), { timeout: 12000 });
await p.reload(); await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
await отказатьсяОтЧерновика(p);
await p.click('.tab[data-tab="document"]');
await p.waitForTimeout(600);
await call('/document', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
  title: 'Согласие', signPrompt: 'Распишитесь', thankYouText: 'Спасибо', idleReturnSec: 0,
  pages: [{ headingRuns: [{ text: 'Данные' }], blocks: [{ runs: [{ text: '{{ФИО}}, {{Пол}}' }], ord: 0 }], checkboxes: [], groups: [] }],
  signBlocks: [], signBlocksBelow: [] }) });
await p.reload(); await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
await отказатьсяОтЧерновика(p);
await p.click('.tab[data-tab="document"]');
await p.waitForTimeout(600);
await p.click('#showDocument');
await p.waitForSelector('.modal .field', { timeout: 6000 });
const первое = await p.locator('.modal input[type=text]').first().inputValue();
ok(первое === '', 'по умолчанию поля пустые: документ уходит живому человеку');
await p.locator('.modal button', { hasText: 'Заполнить примером' }).click();
await p.waitForTimeout(300);
ok((await p.locator('.modal input[type=text]').first().inputValue()).length > 0,
  'кнопка заполняет примером: ' + await p.locator('.modal input[type=text]').first().inputValue());

ok(jsErr.length === 0, 'ошибок JavaScript нет: ' + jsErr.join(' | '));
await browser.close();
console.log(fail === 0 ? '\nВСЁ ПРОЙДЕНО' : '\n' + fail + ' ПРОВЕРОК УПАЛО');
process.exit(fail === 0 ? 0 : 1);
