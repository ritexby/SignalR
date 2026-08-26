// Two dead ends that cost a real deployment a day of confusion:
//   1. Commands that live only in the SignalR connection (scan, identify) reported success for a
//      tablet that was not connected, so nothing happened and nothing said why.
//   2. A tablet whose WebView had not reloaded since an older deploy kept running the old page.
//      It renders checkboxes but no text (the text moved into structured blocks in v4.2) and
//      ignores anything added since, with no way for the operator to see it.
import { chromium } from 'playwright';

const BASE = 'http://127.0.0.1:5080';
// Путь к браузеру берётся из окружения: на другой машине он другой, а зашитый путь
// превращал набор в неработающий у всех, кроме одной установки. Пусто значит
// «пусть Playwright возьмёт свой», как он и делает по умолчанию.
const EXE = process.env.SK_CHROME || undefined;
let fail = 0;
const ok = (c, m) => { if (c) console.log('PASS', m); else { console.error('FAIL', m); fail++; } };

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
const p = await ctx.newPage();
const jsErr = []; p.on('pageerror', e => jsErr.push(e.message));
p.on('dialog', d => d.accept());

await p.goto(BASE + '/admin/');
await p.fill('#password', 'test123'); await p.click('#loginForm button[type=submit]');
await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });

const call = (path, opts) => p.evaluate(async ([pa, o]) => {
  const r = await fetch('/api/admin' + pa, Object.assign({ credentials: 'same-origin' }, o || {}));
  let body = null; try { body = await r.json(); } catch { body = null; }
  return { status: r.status, body };
}, [path, opts]);
const post = (path, obj) => call(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj || {}) });

// ---------- A tablet that has never connected ----------
const enr = await post('/devices/enroll', { name: 'Планшет вне сети', ttlMinutes: 30 });
const dev = await p.evaluate(async (c) => {
  const r = await fetch('/api/kiosk/enroll', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: c, name: 'Планшет вне сети' }) });
  return r.json();
}, enr.body.code);
const offlineId = dev.deviceId;
ok(!!offlineId, 'a tablet exists that has never connected');

let r = await post('/scan/start', { target: 'device:' + offlineId });
ok(r.status === 409, 'scanning on a tablet that is not connected is refused, not silently accepted');
ok(/не на связи/.test((r.body || {}).error || ''), 'the refusal says the tablet is off air: ' + (r.body || {}).error);
ok(/Планшет вне сети/.test((r.body || {}).error || ''), 'the refusal names the tablet');

r = await post('/devices/' + offlineId + '/identify', {});
ok(r.status === 409, 'identify on a tablet that is not connected is refused');
ok(/не на связи/.test((r.body || {}).error || ''), 'the identify refusal explains why');

// ---------- The same commands on a tablet that is connected ----------
const enr2 = await post('/devices/enroll', { name: 'Планшет на связи', ttlMinutes: 30 });
const tabletCtx = await browser.newContext({ viewport: { width: 900, height: 1400 } });
const tablet = await tabletCtx.newPage();
await tablet.goto(BASE + '/?enroll=' + enr2.body.code);
await tablet.waitForSelector('#slideshow:not(.hidden)', { timeout: 10000 }).catch(() => {});
await p.waitForTimeout(1500);

const devices = (await call('/devices')).body;
const live = devices.find(d => d.name === 'Планшет на связи');
ok(live && live.online === true, 'the tablet is connected');

r = await post('/scan/start', { target: 'device:' + live.id });
ok(r.status === 200, 'scanning a connected tablet still works');
await tablet.waitForSelector('#scan:not(.hidden)', { timeout: 6000 }).catch(() => {});
ok(await tablet.evaluate(() => !document.getElementById('scan').classList.contains('hidden')),
  'the scan screen really opens on the tablet');
await post('/scan/stop', { target: 'device:' + live.id });

r = await post('/devices/' + live.id + '/identify', {});
ok(r.status === 200 && !!r.body.code, 'identify on a connected tablet still returns a number');

// ---------- The page build the tablet reports ----------
// Версия берётся из самого kiosk.js, а не вбита в тест: иначе каждый выпуск ломает проверку.
const версияПланшета = (await (await fetch('http://127.0.0.1:5080/kiosk.js')).text()).match(/APP_VERSION = "([^"]+)"/)[1];
ok(live.appVersion === версияПланшета, 'a connected tablet reports which build of the page it runs: ' + live.appVersion);
ok(devices.find(d => d.id === offlineId).appVersion == null, 'an offline tablet reports no build');

await p.click('.tab[data-tab="devices"]');
await p.waitForSelector('[data-panel="devices"]:not(.hidden)', { timeout: 4000 });
await p.waitForTimeout(600);
const warned = await p.evaluate(() => {
  const items = Array.from(document.querySelectorAll('.dev-item'));
  const card = items.find(i => i.textContent.indexOf('Планшет на связи') >= 0);
  return card ? /старая версия страницы|Версия страницы на планшете/.test(card.textContent) : null;
});
ok(warned === false, 'a tablet on the current page is not accused of running an old one');

// ---------- A tablet still running the page from before the handshake ----------
// This is the case that cost the real deployment a day: the WebView keeps the page it loaded
// months ago, renders checkboxes but no text, and ignores every command added since. It connects
// exactly like the old page did, by calling RegisterKiosk with no version at all.
const enr3 = await post('/devices/enroll', { name: 'Планшет со старой страницей', ttlMinutes: 30 });
const old = await p.evaluate(async (c) => {
  const r = await fetch('/api/kiosk/enroll', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: c, name: 'Планшет со старой страницей' }) });
  return r.json();
}, enr3.body.code);

// A separate browser context: the admin page carries the admin cookie, and the server prefers it
// over the device token, so the connection would not be a device connection at all.
const oldCtx = await browser.newContext();
const oldPage = await oldCtx.newPage();
await oldPage.goto(BASE + '/');                 // loads the SignalR client, no token so it idles
await oldPage.evaluate(async (token) => {
  const conn = new signalR.HubConnectionBuilder()
    .withUrl('/hub/kiosk', { accessTokenFactory: () => token })
    .build();
  await conn.start();
  // Exactly what the old page does: register and never report a version. This must keep working:
  // a tablet on an older page has to stay usable, it just cannot be told apart without the report.
  await conn.invoke('RegisterKiosk');
  window.__oldTablet = conn;                    // hold it open so the tablet stays connected
}, old.token);
await p.waitForTimeout(1200);

const afterOld = (await call('/devices')).body;
const oldDev = afterOld.find(d => d.id === old.deviceId);
ok(oldDev.online === true, 'the old page connects and works, it is not broken');
ok(oldDev.appVersion == null, 'a tablet on the old page reports no build');

await p.click('.tab[data-tab="signatures"]');
await p.click('.tab[data-tab="devices"]');
await p.waitForTimeout(800);
const oldWarned = await p.evaluate(() => {
  const items = Array.from(document.querySelectorAll('.dev-item'));
  const card = items.find(i => i.textContent.indexOf('Планшет со старой страницей') >= 0);
  return card ? card.textContent : null;
});
ok(oldWarned !== null, 'the old tablet has a card');
ok(/старая версия страницы/.test(oldWarned || ''), 'the card warns that the page on the tablet is old');
ok(/Обновить страницу/.test(oldWarned || ''), 'the card says what to do about it');

ok(jsErr.length === 0, 'no JavaScript errors in the admin panel: ' + jsErr.join(' | '));

await browser.close();
console.log(fail === 0 ? '\nALL PASS' : '\n' + fail + ' FAILED');
process.exit(fail === 0 ? 0 : 1);
