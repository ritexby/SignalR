// Расписание управления планшетами: правило создаётся, сохраняется, читается обратно и
// выполняется. Проверяется и защита: планшет, на котором идёт подписание, не трогают.
import { chromium } from 'playwright';
const BASE = 'http://127.0.0.1:5080';
// Путь к браузеру берётся из окружения: на другой машине он другой, а зашитый путь
// превращал набор в неработающий у всех, кроме одной установки. Пусто значит
// «пусть Playwright возьмёт свой», как он и делает по умолчанию.
const EXE = process.env.SK_CHROME || undefined;
let fail = 0;
const ok = (c, m) => { if (c) console.log('PASS', m); else { console.error('FAIL', m); fail++; } };

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const p = await (await browser.newContext({ viewport: { width: 1600, height: 1100 } })).newPage();
const jsErr = []; p.on('pageerror', e => jsErr.push(e.message));
p.on('dialog', d => d.accept());
await p.goto(BASE + '/admin/');
await p.fill('#password', 'test123'); await p.click('#loginForm button[type=submit]');
await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
const call = (path, opts) => p.evaluate(async ([pa, o]) => {
  const r = await fetch('/api/admin' + pa, Object.assign({ credentials: 'same-origin' }, o || {}));
  let b = null; try { b = await r.json(); } catch {} return { status: r.status, body: b };
}, [path, opts]);

// Список действий отдаёт сервер: интерфейс не должен знать его сам.
const actions = (await call('/schedule/actions')).body || [];
ok(actions.length >= 10, 'сервер отдаёт список действий: ' + actions.length);
const byKey = {}; actions.forEach(a => byKey[a.key] = a);
ok(byKey['screen-on'] && byKey['screen-off'], 'экран включить и выключить есть');
ok(byKey['reboot'] && byKey['restart-app'] && byKey['reload'] && byKey['clear-cache'], 'перезагрузка и перезапуск есть');
ok(byKey['brightness'] && byKey['brightness'].needsValue, 'яркость есть и просит значение');
ok(byKey['screen-on'].catchUp === true, 'включение экрана можно догнать');
ok(byKey['reboot'].catchUp === false, 'перезагрузку догонять нельзя');

// Правило через интерфейс.
await p.click('.tab[data-tab="devices"]');
await p.waitForSelector('#scheduleList', { timeout: 5000 });
await p.click('#addSchedule');
await p.waitForTimeout(200);
const row = p.locator('[data-role="schrule"]').first();
ok(await row.count() === 1, 'правило добавилось на экран');
await row.locator('[data-role="schtime"]').fill('06:50');
await row.locator('[data-role="schaction"]').selectOption('screen-on');
await row.locator('[data-role="schnote"]').fill('Утреннее включение');
ok(await row.locator('.sch-day.on').count() === 5, 'по умолчанию будни: ' + await row.locator('.sch-day.on').count());
await row.locator('.sch-day[data-day="6"]').click();
await p.waitForTimeout(100);
ok(await row.locator('.sch-day.on').count() === 6, 'суббота добавилась');

await p.click('#saveSchedule');
await p.waitForTimeout(700);
let rules = ((await call('/schedule')).body || {}).rules || [];
ok(rules.length === 1, 'правило сохранено: ' + rules.length);
ok(rules[0].time === '06:50' && rules[0].action === 'screen-on', 'время и действие на месте: ' + JSON.stringify(rules[0].time) + ' ' + rules[0].action);
ok(JSON.stringify(rules[0].days) === '[1,2,3,4,5,6]', 'дни сохранены: ' + JSON.stringify(rules[0].days));
ok(rules[0].skipBusy === true, 'защита подписания включена по умолчанию');
ok(!!rules[0].id, 'сервер выдал правилу идентификатор');

// Поле значения появляется только у действий, которым оно нужно.
await row.locator('[data-role="schaction"]').selectOption('brightness');
await p.waitForTimeout(150);
ok(await row.locator('[data-role="schvalue"]').isVisible(), 'у яркости поле значения показано');
await row.locator('[data-role="schaction"]').selectOption('screen-on');
await p.waitForTimeout(150);
ok(!(await row.locator('[data-role="schvalue"]').isVisible()), 'у включения экрана поле значения скрыто');

// Мусор в поле времени не должен ломать расписание.
await call('/schedule', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify([{ time: '99:99', action: 'нетТакого', days: [0, 9, 3], value: 500, target: 'all' }]) });
rules = ((await call('/schedule')).body || {}).rules || [];
ok(rules[0].time === '07:00', 'негодное время заменено на понятное: ' + rules[0].time);
ok(rules[0].action === 'screen-on', 'неизвестное действие заменено: ' + rules[0].action);
ok(JSON.stringify(rules[0].days) === '[3]', 'негодные дни отброшены: ' + JSON.stringify(rules[0].days));
ok(rules[0].value === 100, 'значение приведено в границы: ' + rules[0].value);

const запустить = () => call('/schedule/' + rules[0].id + '/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
  .then(r => (r.body || {}).result || '');

// Правило без планшетов сообщает об этом, а не молчит.
ok(/планшетов по этому условию нет/.test(await запустить()), 'пустой парк: сказано, что делать нечего');

// Планшет, на котором идёт подписание, не трогаем.
const code = (await call('/devices/enroll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"name":"Занятый"}' })).body.code;
const kiosk = await (await browser.newContext()).newPage();
await kiosk.goto(BASE + '/?enroll=' + encodeURIComponent(code));
await kiosk.waitForFunction(() => !!localStorage.getItem('sk_device_token'), { timeout: 12000 });
let deviceId = null;
for (let i = 0; i < 40; i++) {
  const d = (await call('/devices')).body || [];
  const on = d.find(x => x.online); if (on) { deviceId = on.id; break; }
  await kiosk.waitForTimeout(250);
}
// Планшет есть, но управление по локальной сети выключено: об этом должно быть сказано прямо,
// иначе оператор ждёт от расписания действия, которое физически не отправляется.
ok(/выключено/.test(await запустить()), 'при выключенном управлении сказано именно это');

await call('/kiosk-control/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ enabled: true, port: 8080, timeoutSec: 2, autoHeal: false, autoHealAfterMinutes: 5, batteryWarnPercent: 20, storageWarnPercent: 10 }) });

await call('/show-document', { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ target: 'device:' + deviceId, fields: {} }) });
await p.waitForTimeout(400);
ok(/идёт подписание/.test(await запустить()), 'планшет с открытым документом не трогают');

// Возврат рекламы идёт через уже открытое соединение, локальная сеть для него не нужна.
await call('/schedule', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify([Object.assign({}, rules[0], { action: 'return-slides', skipBusy: false })]) });
rules = ((await call('/schedule')).body || {}).rules || [];
const итог = await запустить();
ok(/выполнено на 1/.test(итог), 'возврат рекламы выполняется без локальной сети: ' + итог);
await p.waitForTimeout(600);
const состояние = (await call('/playlist?target=device:' + deviceId)).body;
ok(состояние && состояние.mode === 'slides', 'планшет действительно вернулся к рекламе: ' + (состояние && состояние.mode));

// Итог запуска виден оператору в логе.
const logs = ((await call('/logs?q=Расписание')).body || {}).entries || [];
ok(logs.length >= 1, 'запуски правил записываются в лог: ' + logs.length);

ok(jsErr.length === 0, 'ошибок JavaScript нет: ' + jsErr.join(' | '));
await browser.close();
console.log(fail === 0 ? '\nВСЁ ПРОЙДЕНО' : '\n' + fail + ' ПРОВЕРОК УПАЛО');
process.exit(fail === 0 ? 0 : 1);
