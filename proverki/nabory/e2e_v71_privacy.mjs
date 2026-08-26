// Чужому клиенту не должно показаться чужое. Проверяется не рассуждением, а тем, что лежит на
// диске и что видно на втором планшете: после подписания в состоянии не должно остаться ни
// личных данных, ни формулировок конкретного заказа.
import { chromium } from 'playwright';
import { readFileSync, existsSync } from 'fs';
const BASE = 'http://127.0.0.1:5080';
// Путь к браузеру берётся из окружения: на другой машине он другой, а зашитый путь
// превращал набор в неработающий у всех, кроме одной установки. Пусто значит
// «пусть Playwright возьмёт свой», как он и делает по умолчанию.
const EXE = process.env.SK_CHROME || undefined;
const SP = '' + (process.env.SK_RABOTA || '.') + '';
const DATA = SP + '/data_v3';
const ПИКСЕЛЬ = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
let fail = 0;
const ok = (c, m) => { if (c) console.log('PASS', m); else { console.error('FAIL', m); fail++; } };

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const admin = await (await browser.newContext()).newPage();
admin.on('pageerror', e => { console.error('FAIL ошибка в админке: ' + e.message); fail++; });
await admin.goto(BASE + '/admin/');
await admin.fill('#password', 'test123');
await admin.click('#loginForm button[type=submit]');
await admin.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
const call = (path, opts) => admin.evaluate(async ([pa, o]) => {
  const r = await fetch('/api/admin' + pa, Object.assign({ credentials: 'same-origin' }, o || {}));
  let body = null; try { body = await r.json(); } catch { body = null; }
  return { status: r.status, body };
}, [path, opts]);
const post = (p, o) => call(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o) });
const put = (p, o) => call(p, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o) });

async function планшет(имя) {
  const enr = (await post('/devices/enroll', { name: имя, ttlMinutes: 30 })).body;
  const tok = await admin.evaluate(async (code) => (await fetch('/api/kiosk/enroll', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code })
  })).json(), enr.code);
  const стр = await (await browser.newContext({ viewport: { width: 1000, height: 1300 } })).newPage();
  стр.on('pageerror', e => { console.error('FAIL ошибка на планшете ' + имя + ': ' + e.message); fail++; });
  await стр.goto(BASE + '/');
  await стр.evaluate(t => localStorage.setItem('sk_device_token', t), tok.token);
  await стр.reload();
  await стр.waitForTimeout(1200);
  return { tok, стр };
}

const А = await планшет('Планшет А');
const Б = await планшет('Планшет Б');

// Файл состояния пишется с экранированием кириллицы (\u0424...), поэтому искать в сыром тексте
// нельзя: любая проверка «этого тут нет» проходила бы сама собой, ничего не проверяя. Разбираем
// JSON и собираем все строки, какие в нём есть, уже расшифрованными.
function состояния() {
  if (!existsSync(DATA + '/states.json')) return '';
  let d; try { d = JSON.parse(readFileSync(DATA + '/states.json', 'utf8')); } catch { return ''; }
  const куски = [];
  (function обойти(x) {
    if (x === null || x === undefined) return;
    if (typeof x === 'string') { куски.push(x); return; }
    if (Array.isArray(x)) { x.forEach(обойти); return; }
    if (typeof x === 'object') { Object.keys(x).forEach(k => { куски.push(k); обойти(x[k]); }); }
  })(d);
  return куски.join('\n');
}

// ---------- 1. Документ уходит на один планшет, второй о нём не знает ----------
await put('/document', {
  kind: 'sign', title: 'Согласие', signPrompt: 'Распишитесь', thankYouText: 'Спасибо', idleReturnSec: 0,
  pages: [{ headingRuns: [{ text: 'Данные' }], includeDynamic: false,
    blocks: [{ runs: [{ text: 'Клиент: ' }, { text: '{{ФИО}}' }], ord: 0 }],
    checkboxes: [{ key: 'soglasie', label: 'Я согласен', required: true, ord: 1 }] }]
});
await post('/show-document', { target: 'device:' + А.tok.deviceId, fields: { 'ФИО': 'ПЕТРОВ ПЁТР ПЕТРОВИЧ' } });
await А.стр.waitForSelector('text=ПЕТРОВ ПЁТР ПЕТРОВИЧ', { timeout: 8000 });
ok(true, 'первый клиент видит свои данные на своём планшете');
await Б.стр.waitForTimeout(1500);
const наБ = await Б.стр.textContent('body');
ok(наБ.indexOf('ПЕТРОВ') < 0, 'на втором планшете чужого имени нет');
ok(await Б.стр.locator('#document:not(.hidden)').count() === 0, 'второй планшет остался на рекламе');

// ---------- 2. После подписания в состоянии не остаётся ни данных, ни формулировок заказа ----------
await post('/show-document', {
  target: 'device:' + А.tok.deviceId,
  fields: { 'ФИО': 'ПЕТРОВ ПЁТР ПЕТРОВИЧ' },
  checkboxes: [{ key: 'soglasie', label: 'ФОРМУЛИРОВКА ИЗ ЗАКАЗА ПЕТРОВА', checked: false }]
});
await А.стр.waitForSelector('text=ФОРМУЛИРОВКА ИЗ ЗАКАЗА ПЕТРОВА', { timeout: 8000 });
const доПодписи = состояния();
ok(доПодписи.indexOf('ПЕТРОВ ПЁТР ПЕТРОВИЧ') >= 0,
  'пока клиент подписывает, его данные лежат в состоянии (иначе проверка ниже ничего не проверяет)');
ok(доПодписи.indexOf('ФОРМУЛИРОВКА ИЗ ЗАКАЗА ПЕТРОВА') >= 0,
  'и формулировка его заказа тоже лежит в состоянии');

const подпись = await А.стр.evaluate(async (пиксель) => {
  const r = await fetch('/api/sign', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + localStorage.getItem('sk_device_token') },
    body: JSON.stringify({ items: [{ key: 'soglasie', label: 'ФОРМУЛИРОВКА ИЗ ЗАКАЗА ПЕТРОВА', checked: true }],
      groups: [], signatures: [], scans: [], inputs: [], signature: пиксель, submissionId: 'приват-1' })
  });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, body: j };
}, ПИКСЕЛЬ);
ok(подпись.status === 200, 'клиент подписал: ' + JSON.stringify(подпись.body));
await А.стр.waitForTimeout(800);
const после = состояния();
ok(после.indexOf('ПЕТРОВ ПЁТР ПЕТРОВИЧ') < 0, 'после подписания личных данных в состоянии не осталось');
ok(после.indexOf('ФОРМУЛИРОВКА ИЗ ЗАКАЗА ПЕТРОВА') < 0,
  'после подписания формулировки заказа в состоянии не осталось (они тоже данные заказа)');
ok(!existsSync(DATA + '/sessions/' + А.tok.deviceId + '.json'), 'снимок сессии удалён вместе с данными');

// ---------- 3. Следующий клиент на том же планшете не получает чужих формулировок ----------
await post('/show-document', { target: 'device:' + А.tok.deviceId, fields: { 'ФИО': 'СИДОРОВА АННА' } });
await А.стр.waitForSelector('text=СИДОРОВА АННА', { timeout: 8000 });
const экранА = await А.стр.textContent('#document');
ok(экранА.indexOf('ПЕТРОВ') < 0, 'второй клиент не видит имени первого');
ok(экранА.indexOf('ФОРМУЛИРОВКА ИЗ ЗАКАЗА ПЕТРОВА') < 0,
  'второй клиент видит текст из документа, а не формулировку из чужого заказа');
ok(экранА.indexOf('Я согласен') >= 0, 'вместо чужой формулировки вернулся текст самого документа');

// ---------- 4. Наблюдение показывает только тот планшет, за которым смотрят ----------
const окно = await (await browser.newContext({ viewport: { width: 1200, height: 900 } })).newPage();
await окно.goto(BASE + '/admin/');
await окно.fill('#password', 'test123');
await окно.click('#loginForm button[type=submit]');
await окно.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
await окно.goto(BASE + '/admin/#watch=' + encodeURIComponent(Б.tok.deviceId));
await окно.waitForTimeout(2500);
const вОкне = await окно.textContent('body');
ok(вОкне.indexOf('СИДОРОВА') < 0 && вОкне.indexOf('ПЕТРОВ') < 0,
  'окно наблюдения за вторым планшетом не показывает документ первого');

await browser.close();
console.log(fail === 0 ? '\nПРИВАТНОСТЬ: ВСЁ ПРОЙДЕНО' : '\nПРИВАТНОСТЬ: ПРОВАЛОВ ' + fail);
process.exit(fail === 0 ? 0 : 1);
