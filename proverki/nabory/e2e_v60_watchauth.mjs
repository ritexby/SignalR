// Ссылка наблюдения в руках постороннего: он не должен увидеть ни планшета, ни данных клиента.
import { chromium } from 'playwright';
const BASE = 'http://127.0.0.1:5080';
// Путь к браузеру берётся из окружения: на другой машине он другой, а зашитый путь
// превращал набор в неработающий у всех, кроме одной установки. Пусто значит
// «пусть Playwright возьмёт свой», как он и делает по умолчанию.
const EXE = process.env.SK_CHROME || undefined;
let fail = 0;
const ok = (c, m) => { if (c) console.log('PASS', m); else { console.error('FAIL', m); fail++; } };

const browser = await chromium.launch({ executablePath: EXE, headless: true });

// Оператор готовит планшет и документ с личными данными клиента.
const admin = await (await browser.newContext()).newPage();
await admin.goto(BASE + '/admin/');
await admin.fill('#password', 'test123'); await admin.click('#loginForm button[type=submit]');
await admin.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
const call = (path, opts) => admin.evaluate(async ([pa, o]) => {
  const r = await fetch('/api/admin' + pa, Object.assign({ credentials: 'same-origin' }, o || {}));
  let b = null; try { b = await r.json(); } catch {} return { status: r.status, body: b };
}, [path, opts]);

const ЛИЧНОЕ = 'Иванова Анна Петровна';
await call('/document', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
  title: 'СОГЛАСИЕ', signPrompt: 'x', thankYouText: 'x', idleReturnSec: 0,
  pages: [{ headingRuns: [{ text: 'Условия' }], blocks: [{ runs: [{ text: 'Подписант: {{ФИО}}' }], ord: 0 }],
    checkboxes: [{ key: 'ok', label: 'Согласен', required: true, ord: 1 }], groups: [], signatures: [], scans: [] }],
  signBlocks: [], signBlocksBelow: [] }) });
const ws = (await call('/workstations', { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: 'Ресепшн', externalId: 'WS-204', location: 'Холл' }) })).body;
const code = (await call('/devices/enroll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"name":"Планшет"}' })).body.code;
const kiosk = await (await browser.newContext({ viewport: { width: 800, height: 1200 } })).newPage();
await kiosk.goto(BASE + '/?enroll=' + encodeURIComponent(code));
await kiosk.waitForFunction(() => !!localStorage.getItem('sk_device_token'), { timeout: 12000 });
let id = null;
for (let i = 0; i < 40; i++) {
  const d = (await call('/devices')).body || []; const on = d.find(x => x.online);
  if (on) { id = on.id; break; }
  await kiosk.waitForTimeout(250);
}
await admin.evaluate(async ([devId, wsId]) => {
  await fetch('/api/admin/devices/' + devId, { method: 'PUT', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Планшет', workstationId: wsId }) });
}, [id, ws.id]);
await call('/show-document', { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ target: 'device:' + id, fields: { 'ФИО': ЛИЧНОЕ } }) });
await kiosk.waitForSelector('.check', { timeout: 8000 });
ok((await kiosk.textContent('body')).includes(ЛИЧНОЕ), 'на планшете идёт подписание с личными данными');

// Посторонний: свой браузер, никаких кук, та же ссылка.
const чужой = await (await browser.newContext()).newPage();
чужой.on('pageerror', () => { /* нас интересует только то, что видно */ });
await чужой.goto(BASE + '/admin/#watch=WS-204');
await чужой.waitForTimeout(4000);
const видно = await чужой.evaluate(() => ({
  окноНаблюдения: document.querySelectorAll('.watch-screen').length,
  формаВхода: document.querySelectorAll('#loginForm').length,
  приложениеСкрыто: !!document.querySelector('#app.hidden'),
  весьТекст: document.body.textContent.replace(/\s+/g, ' ').slice(0, 300)
}));
ok(видно.окноНаблюдения === 0, 'окно наблюдения не открылось');
ok(видно.формаВхода === 1, 'вместо него показан вход');
ok(!видно.весьТекст.includes(ЛИЧНОЕ), 'личных данных клиента на экране нет');
ok(!видно.весьТекст.includes('WS-204') && !видно.весьТекст.includes('Ресепшн') && !видно.весьТекст.includes('Холл'),
  'ни кода рабочего места, ни его названия на экране нет');
ok(!видно.весьТекст.includes('Согласен') && !видно.весьТекст.includes('Подписант'),
  'и содержимого документа тоже нет');

// И напрямую по адресам: без входа сервер не отдаёт ничего.
const напрямую = await чужой.evaluate(async ([devId]) => {
  const out = {};
  for (const [имя, путь] of [['экран', '/api/admin/devices/' + devId + '/screen'],
                             ['планшеты', '/api/admin/devices'],
                             ['документ', '/api/admin/document']]) {
    const r = await fetch(путь, { credentials: 'same-origin' });
    out[имя] = r.status;
  }
  return out;
}, [id]);
ok(напрямую.экран === 401 || напрямую.экран === 403, 'экран планшета по адресу не отдаётся: ' + напрямую.экран);
ok(напрямую.планшеты === 401 || напрямую.планшеты === 403, 'список планшетов тоже: ' + напрямую.планшеты);
ok(напрямую.документ === 401 || напрямую.документ === 403, 'и документ: ' + напрямую.документ);

// Хаб: подключиться без входа нельзя, а если бы удалось, метод наблюдения отказывает.
const хаб = await чужой.evaluate(async () => {
  if (!window.signalR) return { нетБиблиотеки: true };
  const c = new signalR.HubConnectionBuilder().withUrl('/hub/kiosk').configureLogging(signalR.LogLevel.None).build();
  try { await c.start(); } catch (e) { return { подключился: false, ошибка: String(e && e.message || e).slice(0, 120) }; }
  try { await c.invoke('WatchDevice', 'dev-любой'); return { подключился: true, наблюдение: 'разрешено' }; }
  catch (e) { return { подключился: true, наблюдение: String(e && e.message || e).slice(0, 120) }; }
});
ok(хаб.подключился === false || /admin only|unknown device/.test(хаб.наблюдение || ''),
  'к наблюдению без входа не пускают: ' + JSON.stringify(хаб));

// А оператор с входом ту же ссылку открывает и всё видит.
await admin.goto(BASE + '/admin/#watch=WS-204');
await admin.waitForSelector('.watch-screen', { timeout: 15000 });
await admin.waitForTimeout(1200);
ok((await admin.locator('.watch-screen').textContent()).includes(ЛИЧНОЕ), 'а вошедший оператор по той же ссылке видит подписание');

await browser.close();
console.log(fail === 0 ? '\nВСЁ ПРОЙДЕНО' : '\n' + fail + ' ПРОВЕРОК УПАЛО');
process.exit(fail === 0 ? 0 : 1);
