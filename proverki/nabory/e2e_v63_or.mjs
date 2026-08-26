// Условие «или»: содержимое показывается, если выполнен хотя бы один набор целиком. Проверяется
// не только сам ответ да/нет, но и разделение: часть наборов решается на сервере по присланным
// тегам, часть уезжает на планшет и вычисляется там, пока клиент отмечает пункты. Ошибка в этом
// разделении опаснее обычной: чужой клиент увидел бы блок, предназначенный не ему.
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
admin.on('pageerror', e => { console.error('FAIL ошибка в админке: ' + e.message); fail++; });
await admin.goto(BASE + '/admin/');
await admin.fill('#password', 'test123');
await admin.click('#loginForm button[type=submit]');
await admin.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
const отказ = admin.locator('.modal button', { hasText: 'Отказаться от черновика' });
if (await отказ.count()) { await отказ.click(); await admin.waitForTimeout(200); }

const call = (path, opts) => admin.evaluate(async ([pa, o]) => {
  const r = await fetch('/api/admin' + pa, Object.assign({ credentials: 'same-origin' }, o || {}));
  let body = null; try { body = await r.json(); } catch { body = null; }
  return { status: r.status, body };
}, [path, opts]);
const post = (path, obj) => call(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });
const put = (path, obj) => call(path, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });

// Год рождения ребёнка и взрослого считаются от сегодняшнего дня, иначе набор перестал бы
// работать через несколько лет и падал бы без всякой связи с кодом.
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
// Блок, который живёт под условием, ищется по своему тексту: по номеру нельзя, соседние блоки
// тоже могут исчезнуть, и тогда проверка сравнивала бы не то, что нужно.
function спорный(resolved) {
  const blocks = ((resolved.pages || [])[0] || {}).blocks || [];
  return blocks.find(b => (b.runs || []).some(r => (r.text || '').indexOf('спорный') >= 0)) || null;
}
async function разбор(cond, fields, checks) {
  const r = await post('/document/preview', { document: док(cond), fields: fields || {}, checkboxes: checks || [] });
  if (r.status !== 200) { console.error('FAIL предпросмотр вернул ' + r.status + ': ' + JSON.stringify(r.body)); fail++; return null; }
  return спорный(r.body.document);
}

// ---------- 1. Оба набора решаются на сервере ----------
const ПОЛ_ИЛИ = {
  field: 'Пол', op: 'eq', value: 'Ж',
  and: [{ field: 'ДР', op: 'agelt', value: '14' }],
  or: [{ field: 'Пол', op: 'eq', value: 'М' }]
};
ok(await разбор(ПОЛ_ИЛИ, { 'Пол': 'Ж', 'ДР': ДЕТСКАЯ }) !== null, 'первый набор выполнен: девочка младше 14 видит блок');
ok(await разбор(ПОЛ_ИЛИ, { 'Пол': 'М', 'ДР': ВЗРОСЛАЯ }) !== null, 'второй набор выполнен: мужчина видит блок');
ok(await разбор(ПОЛ_ИЛИ, { 'Пол': 'Ж', 'ДР': ВЗРОСЛАЯ }) === null, 'ни один набор не выполнен: взрослая женщина блок не видит');

// Проверка, что «или» не превратилось в «и»: при выполненном первом наборе второй не мешает.
ok(await разбор({ field: 'Пол', op: 'eq', value: 'Ж', or: [{ field: 'Пол', op: 'eq', value: 'М' }] }, { 'Пол': 'Ж' }) !== null,
  'взаимно исключающие наборы: выполненный первый достаточен');

// ---------- 2. Разделение сервер / планшет ----------
const СМЕШАННОЕ = { field: 'Пол', op: 'eq', value: 'Ж', or: [{ field: 'предст', op: 'eq', value: 'true' }] };
let b = await разбор(СМЕШАННОЕ, { 'Пол': 'Ж' });
ok(b !== null && !b.visibleWhen, 'набор выполнен по тегам: блок виден сразу, условие на планшет не едет');

b = await разбор(СМЕШАННОЕ, { 'Пол': 'М' });
ok(b !== null, 'набор по тегам провалился, но остался набор про чекбокс: блок доезжает до планшета');
ok(b && b.visibleWhen && b.visibleWhen.field === 'предст' && !b.visibleWhen.or,
  'на планшет уехал только живой набор, без второго');
ok(b && JSON.stringify(b.visibleWhen).indexOf('Пол') < 0,
  'решённая на сервере часть на планшет не попала: планшет не знает про пол клиента');

// Оба набора смешанные: живёт только тот, чья теговая часть прошла.
const ДВА_СМЕШАННЫХ = {
  field: 'Пол', op: 'eq', value: 'Ж', and: [{ field: 'предст', op: 'eq', value: 'true' }],
  or: [{ field: 'Пол', op: 'eq', value: 'М', and: [{ field: 'второй', op: 'eq', value: 'true' }] }]
};
b = await разбор(ДВА_СМЕШАННЫХ, { 'Пол': 'Ж' });
ok(b && b.visibleWhen && b.visibleWhen.field === 'предст' && !b.visibleWhen.or,
  'из двух смешанных наборов уехал тот, чья теговая часть прошла');
b = await разбор(ДВА_СМЕШАННЫХ, { 'Пол': 'М' });
ok(b && b.visibleWhen && b.visibleWhen.field === 'второй' && !b.visibleWhen.or,
  'при другом поле уезжает другой набор');
b = await разбор(ДВА_СМЕШАННЫХ, { 'Пол': 'Х' });
ok(b === null, 'провалились обе теговые части: блок не доезжает до планшета вовсе');

// Оба набора живые: уезжают целиком.
const ДВА_ЖИВЫХ = { field: 'предст', op: 'eq', value: 'true', or: [{ field: 'второй', op: 'eq', value: 'true' }] };
b = await разбор(ДВА_ЖИВЫХ, {});
ok(b && b.visibleWhen && b.visibleWhen.field === 'предст'
   && b.visibleWhen.or && b.visibleWhen.or.length === 1 && b.visibleWhen.or[0].field === 'второй',
  'оба набора про чекбоксы: «или» доезжает до планшета целиком');

// ---------- 3. Хранение ----------
const st = await put('/document', док(ДВА_СМЕШАННЫХ));
ok(st.status === 200, 'документ с «или» сохраняется');
const back = (await call('/document')).body;
const сохр = спорный(back);
ok(сохр && сохр.visibleWhen && сохр.visibleWhen.or && сохр.visibleWhen.or.length === 1,
  'после сохранения и чтения «или» на месте');
ok(сохр && сохр.visibleWhen.and && сохр.visibleWhen.and.length === 1
   && сохр.visibleWhen.or[0].and && сохр.visibleWhen.or[0].and.length === 1,
  'списки «и» внутри наборов сохранились каждый в своём наборе');

// ---------- 4. Приведение в порядок ----------
await put('/document', док({
  field: 'Пол', op: 'eq', value: 'Ж',
  or: [{ field: '', op: 'eq', value: 'что-то' }, { field: 'предст', op: 'eq', value: 'true' }]
}));
let c = спорный((await call('/document')).body).visibleWhen;
ok(c.or && c.or.length === 1 && c.or[0].field === 'предст',
  'пустой набор выброшен: иначе он делал бы условие выполненным всегда');

await put('/document', док({
  field: 'Пол', op: 'eq', value: 'Ж',
  or: [{ field: 'предст', op: 'eq', value: 'true', or: [{ field: 'второй', op: 'eq', value: 'true' }] }]
}));
c = спорный((await call('/document')).body).visibleWhen;
ok(c.or && c.or.length === 1 && !c.or[0].or, 'вложенное «или» внутри набора убрано: дерево не хранится');

await put('/document', док({
  field: 'Пол', op: 'eq', value: 'Ж',
  or: [1, 2, 3, 4, 5, 6, 7].map(i => ({ field: 'предст', op: 'eq', value: 'v' + i }))
}));
c = спорный((await call('/document')).body).visibleWhen;
ok(c.or && c.or.length === 5, 'число наборов ограничено пятью: импортированный файл не принесёт список любой длины');

// Условие только из «или», без первой части: первый набор становится основным.
await put('/document', док({ field: '', op: 'eq', value: '', or: [{ field: 'предст', op: 'eq', value: 'true' }] }));
c = спорный((await call('/document')).body).visibleWhen;
ok(c && c.field === 'предст' && !c.or, 'условие без первой части не стало «показывать всегда»');

// ---------- 5. Планшет считает «или» сам ----------
const ws = (await post('/workstations', { externalId: 'WS-OR', name: 'Или', location: '' })).body;
const enr = (await post('/devices/enroll', { name: 'Планшет', workstationId: ws.id, ttlMinutes: 30 })).body;
const tok = await admin.evaluate(async (code) => (await fetch('/api/kiosk/enroll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) })).json(), enr.code);

await put('/document', док(ДВА_ЖИВЫХ));
const kiosk = await (await browser.newContext({ viewport: { width: 900, height: 1400 } })).newPage();
kiosk.on('pageerror', e => { console.error('FAIL ошибка на планшете: ' + e.message); fail++; });
await kiosk.goto(BASE + '/');
await kiosk.evaluate(t => localStorage.setItem('sk_device_token', t), tok.token);
await kiosk.reload();
await kiosk.waitForTimeout(1200);
const пок = await post('/show-document', { target: 'device:' + tok.deviceId, fields: {} });
ok(пок.status === 200, 'документ отправлен на планшет: ' + JSON.stringify(пок.body));
await kiosk.waitForSelector('text=общий текст', { timeout: 8000 });
const виден = () => kiosk.locator('text=спорный блок').count();
ok(await виден() === 0, 'на планшете: ни один пункт не отмечен, блок скрыт');
await kiosk.locator('label', { hasText: 'Законный представитель' }).click();
await kiosk.waitForTimeout(300);
ok(await виден() === 1, 'на планшете: отмечен первый пункт, блок появился');
await kiosk.locator('label', { hasText: 'Законный представитель' }).click();
await kiosk.waitForTimeout(300);
ok(await виден() === 0, 'на планшете: пункт снят, блок снова скрыт');
await kiosk.locator('label', { hasText: 'Второй пункт' }).click();
await kiosk.waitForTimeout(300);
ok(await виден() === 1, 'на планшете: второго пункта тоже достаточно, это «или», а не «и»');
await kiosk.locator('label', { hasText: 'Законный представитель' }).click();
await kiosk.waitForTimeout(300);
ok(await виден() === 1, 'на планшете: оба пункта отмечены, блок остаётся');

// ---------- 6. Редактор показывает и возвращает то же самое ----------
await admin.reload();
await admin.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
const отказ2 = admin.locator('.modal button', { hasText: 'Отказаться от черновика' });
if (await отказ2.count()) { await отказ2.click(); await admin.waitForTimeout(300); }
await admin.click('.tab[data-tab="document"]');
await admin.waitForSelector('[data-panel="document"]:not(.hidden)', { timeout: 4000 });
await admin.waitForTimeout(400);
const строка = await admin.locator('.cond-badge.set').first().textContent({ timeout: 5000 });
ok(строка && строка.indexOf(' или ') > 0, 'свёрнутая строка показывает наборы через «или»: ' + строка);
ok(строка && строка.indexOf('(') < 0, 'наборам из одной части скобки не рисуются: ' + строка);
// Строки условия у того самого блока, а не у всех сразу: у соседнего блока условия нет, и его
// пустая строка исказила бы счёт.
const свой = admin.locator('[data-role="blockcond"]').filter({ has: admin.locator('.cond-badge.set') }).first();
ok(await свой.locator('[data-role="crow"]').count() === 2, 'редактор развернул оба набора в две строки');
const связка = await свой.locator('[data-role="crow"]').nth(1).locator('[data-role="cjoin"]').inputValue();
ok(связка === 'or', 'вторая строка соединена через «или», а не «и»');

// Составное условие: набор из двух частей берётся в скобки, набор из одной нет.
await put('/document', док({ field: 'Пол', op: 'eq', value: 'Ж', and: [{ field: 'ДР', op: 'agelt', value: '14' }], or: [{ field: 'предст', op: 'eq', value: 'true' }] }));
await admin.reload();
await admin.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
const отказ3 = admin.locator('.modal button', { hasText: 'Отказаться от черновика' });
if (await отказ3.count()) { await отказ3.click(); await admin.waitForTimeout(300); }
await admin.click('.tab[data-tab="document"]');
await admin.waitForSelector('[data-panel="document"]:not(.hidden)', { timeout: 4000 });
await admin.waitForTimeout(400);
const строка2 = await admin.locator('.cond-badge.set').first().textContent({ timeout: 5000 });
ok(строка2 && /^только если \(.+ и .+\) или [^(]+$/.test(строка2),
  'набор из двух частей в скобках, набор из одной без них: ' + строка2);

// ---------- 7. Тег, названный только после «или», доходит до записи ----------
// В подписанную запись попадают только те поля, которые документ действительно использует:
// внешняя система вправе прислать и свои служебные, но человек их не видел и не подписывал.
// Тег из набора после «или» решает, что клиент увидел, и в записи он обязан быть.
await put('/document', док({ field: 'Пол', op: 'eq', value: 'Ж', or: [{ field: 'Гражданство', op: 'eq', value: 'RU' }] }));
await post('/show-document', { target: 'device:' + tok.deviceId, fields: { 'Пол': 'М', 'Гражданство': 'RU', 'НомерЗаказа': 'A-77' } });
await kiosk.waitForSelector('#document:not(.hidden)', { timeout: 8000 });
await kiosk.waitForTimeout(300);
ok((await kiosk.textContent('#document')).indexOf('спорный блок') >= 0,
  'блок виден по набору после «или»: пол не подошёл, гражданство подошло');

for (let шаг = 0; шаг < 12; шаг++) {
  if (await kiosk.$('#btnSign')) {
    const box = await kiosk.locator('#document canvas').boundingBox();
    await kiosk.mouse.move(box.x + 40, box.y + 40); await kiosk.mouse.down();
    await kiosk.mouse.move(box.x + 160, box.y + 90, { steps: 6 });
    await kiosk.mouse.move(box.x + 240, box.y + 50, { steps: 6 }); await kiosk.mouse.up();
    await kiosk.waitForSelector('#btnSign:not([disabled])', { timeout: 3000 });
    await kiosk.click('#btnSign'); break;
  } else if (await kiosk.$('#btnNext')) {
    await kiosk.waitForSelector('#btnNext:not([disabled])', { timeout: 3000 });
    await kiosk.click('#btnNext'); await kiosk.waitForTimeout(120);
  } else break;
}
await kiosk.waitForSelector('#document .thankyou', { timeout: 8000 });
await admin.waitForTimeout(500);
const записи = (await call('/signatures')).body;
// Список записей это сводка без данных подписанта: сами поля лежат в самой записи.
const запись = (await call('/signatures/' + (записи[0] || {}).id)).body || {};
const поля = запись.fields || {};
ok(поля['Гражданство'] === 'RU', 'тег из набора после «или» сохранён в записи: ' + JSON.stringify(поля));
ok(поля['НомерЗаказа'] === undefined, 'служебное поле, которого нет в документе, в запись не попало');

await browser.close();
if (fail === 0) console.log('\nВСЁ ПРОЙДЕНО');
process.exit(fail ? 1 : 0);
