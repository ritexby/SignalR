// Правило должно сработать само, по часам сервера, без участия оператора. Проверяется на живом
// сервисе: ставим правило на ближайшую минуту и ждём. Тест намеренно медленный: это единственный
// способ убедиться, что фоновый исполнитель действительно работает.
import { chromium } from 'playwright';
const BASE = 'http://127.0.0.1:5080';
// Путь к браузеру берётся из окружения: на другой машине он другой, а зашитый путь
// превращал набор в неработающий у всех, кроме одной установки. Пусто значит
// «пусть Playwright возьмёт свой», как он и делает по умолчанию.
const EXE = process.env.SK_CHROME || undefined;
let fail = 0;
const ok = (c, m) => { if (c) console.log('PASS', m); else { console.error('FAIL', m); fail++; } };

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const p = await (await browser.newContext()).newPage();
await p.goto(BASE + '/admin/');
await p.fill('#password', 'test123'); await p.click('#loginForm button[type=submit]');
await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
const call = (path, opts) => p.evaluate(async ([pa, o]) => {
  const r = await fetch('/api/admin' + pa, Object.assign({ credentials: 'same-origin' }, o || {}));
  let b = null; try { b = await r.json(); } catch {} return { status: r.status, body: b };
}, [path, opts]);

// Планшет, который должно вернуть к рекламе. Возврат рекламы выбран намеренно: он идёт через
// уже открытое соединение, поэтому не зависит от локальной сети и проверяется целиком.
const code = (await call('/devices/enroll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"name":"По расписанию"}' })).body.code;
const kiosk = await (await browser.newContext()).newPage();
await kiosk.goto(BASE + '/?enroll=' + encodeURIComponent(code));
await kiosk.waitForFunction(() => !!localStorage.getItem('sk_device_token'), { timeout: 12000 });
let deviceId = null;
for (let i = 0; i < 40; i++) {
  const d = (await call('/devices')).body || [];
  const on = d.find(x => x.online); if (on) { deviceId = on.id; break; }
  await kiosk.waitForTimeout(250);
}
ok(!!deviceId, 'планшет на связи');

await call('/document', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
  title: 'Согласие', signPrompt: 'Распишитесь', thankYouText: 'Спасибо', idleReturnSec: 0,
  pages: [{ headingRuns: [{ text: 'Страница' }], blocks: [{ runs: [{ text: 'Текст' }], ord: 0 }], checkboxes: [], groups: [] }],
  signBlocks: [], signBlocksBelow: [] }) });
await call('/show-document', { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ target: 'device:' + deviceId, fields: {} }) });
await p.waitForTimeout(500);
ok(((await call('/playlist?target=device:' + deviceId)).body || {}).mode === 'document', 'на планшете открыт документ');

// Ставим правило на следующую минуту по часам сервера.
const serverNow = ((await call('/schedule')).body || {}).serverTime;
const [h, m] = serverNow.split(':').map(Number);
const next = new Date(2000, 0, 1, h, m + 1);
const время = String(next.getHours()).padStart(2, '0') + ':' + String(next.getMinutes()).padStart(2, '0');
console.log('часы сервера ' + serverNow + ', правило на ' + время);

await call('/schedule', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify([{ enabled: true, time: время, days: [], action: 'return-slides', target: 'all', skipBusy: false, note: 'Проверка' }]) });

// Ждём до двух с половиной минут: такт исполнителя полминуты.
let сработало = null;
for (let i = 0; i < 30; i++) {
  await p.waitForTimeout(5000);
  const rules = ((await call('/schedule')).body || {}).rules || [];
  if (rules[0] && rules[0].lastRunUtc) { сработало = rules[0]; break; }
}
ok(!!сработало, 'правило сработало само по времени');
if (сработало) {
  ok(/выполнено на 1/.test(сработало.lastResult || ''), 'итог записан: ' + сработало.lastResult);
  ok(!!сработало.lastRunLocalDate, 'дата запуска записана, второй раз за сутки не повторится');
}
ok(((await call('/playlist?target=device:' + deviceId)).body || {}).mode === 'slides',
  'планшет действительно вернулся к рекламе по расписанию');

const logs = ((await call('/logs?q=Расписание')).body || {}).entries || [];
ok(logs.some(e => /Вернуть рекламу/.test(e.message)), 'в логе видно, что сделало расписание');

await browser.close();
console.log(fail === 0 ? '\nВСЁ ПРОЙДЕНО' : '\n' + fail + ' ПРОВЕРОК УПАЛО');
process.exit(fail === 0 ? 0 : 1);
