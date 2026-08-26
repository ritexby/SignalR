// Условие «и не»: часть под пометкой «не» должна быть НЕ выполнена. Проверяется и то, что
// отрицание в точности обратно обычной части, включая случай непришедшего тега: иначе клиент не
// увидел бы ни одного из двух вариантов, между которыми оператор его делил.
import { chromium } from 'playwright';
async function отказатьсяОтЧерновика(page) {
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
const admin = await (await browser.newContext()).newPage();
admin.on('pageerror', e => { console.error('FAIL ошибка в админке: ' + e.message); fail++; });
await admin.goto(BASE + '/admin/');
await admin.fill('#password', 'test123');
await admin.click('#loginForm button[type=submit]');
await admin.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
await отказатьсяОтЧерновика(admin);

const call = (path, opts) => admin.evaluate(async ([pa, o]) => {
  const r = await fetch('/api/admin' + pa, Object.assign({ credentials: 'same-origin' }, o || {}));
  let body = null; try { body = await r.json(); } catch { body = null; }
  return { status: r.status, body };
}, [path, opts]);
const post = (path, obj) => call(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });
const put = (path, obj) => call(path, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });

const год = new Date().getFullYear();
const ДЕТСКАЯ = (год - 10) + '-06-15';
const ВЗРОСЛАЯ = (год - 40) + '-06-15';

function док(cond) {
  return {
    title: 'Согласие', signPrompt: 'Подпись', thankYouText: 'Спасибо', idleReturnSec: 0,
    pages: [{
      headingRuns: [{ text: 'Страница' }],
      blocks: [
        { runs: [{ text: 'общий текст' }] },
        { runs: [{ text: 'спорный блок' }], visibleWhen: cond }
      ],
      checkboxes: [
        { key: 'предст', label: 'Законный представитель', required: false, checked: false },
        { key: 'второй', label: 'Второй пункт', required: false, checked: false }
      ],
      includeDynamic: false
    }]
  };
}
function спорный(resolved) {
  const blocks = ((resolved.pages || [])[0] || {}).blocks || [];
  return blocks.find(b => (b.runs || []).some(r => (r.text || '').indexOf('спорный') >= 0)) || null;
}
async function разбор(cond, fields) {
  const r = await post('/document/preview', { document: док(cond), fields: fields || {} });
  if (r.status !== 200) { console.error('FAIL предпросмотр вернул ' + r.status + ': ' + JSON.stringify(r.body)); fail++; return null; }
  return спорный(r.body.document);
}

// ---------- 1. «Не» в точности обратно ----------
ok(await разбор({ field: 'Пол', op: 'eq', value: 'Ж', not: true }, { 'Пол': 'М' }) !== null,
  'не равно Ж: мужчина видит блок');
ok(await разбор({ field: 'Пол', op: 'eq', value: 'Ж', not: true }, { 'Пол': 'Ж' }) === null,
  'не равно Ж: женщина блок не видит');
ok(await разбор({ field: 'Пол', op: 'ne', value: 'Ж', not: true }, { 'Пол': 'Ж' }) !== null,
  'двойное отрицание возвращает исходный смысл');

// ---------- 2. То, чего без пометки выразить было нечем ----------
const НИ_ОДНО = { field: 'Гражданство', op: 'in', value: 'RU,BY,KZ', not: true };
ok(await разбор(НИ_ОДНО, { 'Гражданство': 'DE' }) !== null, 'ни одно из списка: чужое гражданство видит блок');
ok(await разбор(НИ_ОДНО, { 'Гражданство': 'BY' }) === null, 'ни одно из списка: своё гражданство блок не видит');

// ---------- 3. Возраст ----------
const НЕ_МЛАДШЕ = { field: 'ДР', op: 'agelt', value: '14', not: true };
ok(await разбор(НЕ_МЛАДШЕ, { 'ДР': ВЗРОСЛАЯ }) !== null, 'не младше 14: взрослый видит блок');
ok(await разбор(НЕ_МЛАДШЕ, { 'ДР': ДЕТСКАЯ }) === null, 'не младше 14: ребёнок блок не видит');
// Дата не пришла вовсе. Обычная часть при этом не выполняется, значит отрицание обязано
// выполниться: иначе оператор, разделивший клиентов на две ветки, не показал бы ни одной.
ok(await разбор({ field: 'ДР', op: 'agelt', value: '14' }, {}) === null,
  'даты нет: обычное условие по возрасту не выполнено');
ok(await разбор(НЕ_МЛАДШЕ, {}) !== null,
  'даты нет: отрицание выполнено, и ветка «для взрослых» всё же показывается');

// ---------- 4. И НЕ: часть про тег на сервере, отрицание про чекбокс на планшете ----------
const И_НЕ = { field: 'Пол', op: 'eq', value: 'Ж', and: [{ field: 'предст', op: 'eq', value: 'true', not: true }] };
let b = await разбор(И_НЕ, { 'Пол': 'М' });
ok(b === null, 'и не: часть про тег не выполнена, блок не уходит с сервера');
b = await разбор(И_НЕ, { 'Пол': 'Ж' });
ok(b !== null && b.visibleWhen && b.visibleWhen.field === 'предст' && b.visibleWhen.not === true,
  'и не: на планшет уехала отрицаемая часть вместе с пометкой');
ok(b && JSON.stringify(b.visibleWhen).indexOf('Пол') < 0,
  'и не: решённая на сервере часть на планшет не попала');

// ---------- 5. ИЛИ НЕ ----------
const ИЛИ_НЕ = { field: 'Пол', op: 'eq', value: 'Ж', or: [{ field: 'Гражданство', op: 'eq', value: 'RU', not: true }] };
ok(await разбор(ИЛИ_НЕ, { 'Пол': 'М', 'Гражданство': 'DE' }) !== null, 'или не: второй набор выполнен');
ok(await разбор(ИЛИ_НЕ, { 'Пол': 'М', 'Гражданство': 'RU' }) === null, 'или не: ни один набор не выполнен');

// ---------- 6. Хранение ----------
ok((await put('/document', док(И_НЕ))).status === 200, 'документ с «и не» сохраняется');
let c = спорный((await call('/document')).body).visibleWhen;
ok(c && c.and && c.and[0].not === true, 'пометка «не» пережила сохранение и чтение');
// Пометка не пишется, когда её нет: иначе каждое существующее условие в файле и в выгрузке
// обзавелось бы лишним полем, а сравнение выгрузок показывало бы изменения там, где их нет.
await put('/document', док({ field: 'Пол', op: 'eq', value: 'Ж' }));
const без = JSON.stringify(спорный((await call('/document')).body).visibleWhen);
ok(без.indexOf('not') < 0, 'условию без отрицания лишнее поле не приписывается: ' + без);

// ---------- 7. Планшет считает отрицание сам ----------
const ws = (await post('/workstations', { externalId: 'WS-NOT', name: 'Не', location: '' })).body;
const enr = (await post('/devices/enroll', { name: 'Планшет', workstationId: ws.id, ttlMinutes: 30 })).body;
const tok = await admin.evaluate(async (code) => (await fetch('/api/kiosk/enroll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) })).json(), enr.code);

await put('/document', док({ field: 'предст', op: 'eq', value: 'true', not: true }));
const kiosk = await (await browser.newContext({ viewport: { width: 900, height: 1400 } })).newPage();
kiosk.on('pageerror', e => { console.error('FAIL ошибка на планшете: ' + e.message); fail++; });
await kiosk.goto(BASE + '/');
await kiosk.evaluate(t => localStorage.setItem('sk_device_token', t), tok.token);
await kiosk.reload();
await kiosk.waitForTimeout(1200);
ok((await post('/show-document', { target: 'device:' + tok.deviceId, fields: {} })).status === 200, 'документ отправлен на планшет');
await kiosk.waitForSelector('text=общий текст', { timeout: 8000 });
const виден = () => kiosk.locator('text=спорный блок').count();
ok(await виден() === 1, 'на планшете: пункт не отмечен, отрицание выполнено, блок виден');
await kiosk.locator('label', { hasText: 'Законный представитель' }).click();
await kiosk.waitForTimeout(300);
ok(await виден() === 0, 'на планшете: пункт отмечен, блок исчез');
await kiosk.locator('label', { hasText: 'Законный представитель' }).click();
await kiosk.waitForTimeout(300);
ok(await виден() === 1, 'на планшете: пункт снят, блок вернулся');

// ---------- 8. Редактор ----------
await put('/document', док({ field: 'Пол', op: 'eq', value: 'Ж', and: [{ field: 'Гражданство', op: 'in', value: 'RU,BY', not: true }] }));
await admin.reload();
await admin.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
await отказатьсяОтЧерновика(admin);
await admin.click('.tab[data-tab="document"]');
await admin.waitForSelector('[data-panel="document"]:not(.hidden)', { timeout: 4000 });
await admin.waitForTimeout(400);
const строка = await admin.locator('.cond-badge.set').first().textContent({ timeout: 5000 });
ok(строка && строка.indexOf('ни одно из') > 0, 'свёрнутая строка называет обратное сравнение словами: ' + строка);
ok(строка && строка.indexOf('не «') < 0, 'а не приставляет «не» перед фразой');

const свой = admin.locator('[data-role="blockcond"]').filter({ has: admin.locator('.cond-badge.set') }).first();
const пометка = свой.locator('[data-role="crow"]').nth(1).locator('[data-role="cnot"]');
ok(await пометка.getAttribute('aria-pressed') === 'true', 'редактор показал пометку «не» нажатой');
ok(await свой.locator('[data-role="crow"]').nth(0).locator('[data-role="cnot"]').getAttribute('aria-pressed') === 'false',
  'у строки без отрицания пометка не нажата');

// Снять пометку мышью и сохранить: смысл условия должен смениться на обратный.
await свой.locator('.cond-badge').click();
await admin.waitForTimeout(200);
await пометка.click();
await admin.waitForTimeout(200);
await admin.click('#saveDocument');
await admin.waitForTimeout(700);
c = спорный((await call('/document')).body).visibleWhen;
ok(c && c.and && !c.and[0].not, 'пометка снята мышью и сохранена снятой');

await browser.close();
if (fail === 0) console.log('\nВСЁ ПРОЙДЕНО');
process.exit(fail ? 1 : 0);
