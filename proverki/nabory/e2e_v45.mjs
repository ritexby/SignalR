// v4.5: tablet control through the FreeKiosk API on the tablet.
// Talks to a mock tablet (mock_freekiosk.mjs) and asserts the whole path: settings, address
// validation, every command button, health parsing, screenshot bytes and the failure paths.
import { chromium } from 'playwright';
import fs from 'node:fs';

const BASE = 'http://127.0.0.1:5080';
// Путь к браузеру берётся из окружения: на другой машине он другой, а зашитый путь
// превращал набор в неработающий у всех, кроме одной установки. Пусто значит
// «пусть Playwright возьмёт свой», как он и делает по умолчанию.
const EXE = process.env.SK_CHROME || undefined;
const TABLET_IP = process.env.TABLET_IP || '192.0.2.2';
const TABLET_PORT = 8099;
const CALLS = '' + (process.env.SK_RABOTA || '.') + '/mock_calls.json';

let fail = 0;
const ok = (c, m) => { if (c) console.log('PASS', m); else { console.error('FAIL', m); fail++; } };
const calls = () => { try { return JSON.parse(fs.readFileSync(CALLS, 'utf8')); } catch { return []; } };
const lastCall = (path) => calls().filter(c => c.path === path).pop();

await fetch('http://' + TABLET_IP + ':' + TABLET_PORT + '/__reset');

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
const p = await ctx.newPage();
const jsErr = []; p.on('pageerror', e => jsErr.push(e.message));
p.on('dialog', d => d.accept());

await p.goto(BASE + '/admin/');
await p.fill('#password', 'test123'); await p.click('#loginForm button[type=submit]');
await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });

// Версия берётся из самой админки, а не вбита в тест: иначе каждый выпуск ломает проверку.
{
  const наСтранице = await p.evaluate(() => (document.querySelector('.version') || {}).textContent);
  const вКоде = (await (await fetch(BASE + '/admin/admin.js')).text()).match(/APP_VERSION = "([^"]+)"/)[1];
  ok(наСтранице === 'v' + вКоде, 'version badge matches APP_VERSION: ' + наСтранице);
}

const call = (path, opts) => p.evaluate(async ([pa, o]) => {
  const r = await fetch('/api/admin' + pa, Object.assign({ credentials: 'same-origin' }, o || {}));
  let body = null; try { body = await r.json(); } catch { body = null; }
  return { status: r.status, body };
}, [path, opts]);
const put = (path, obj) => call(path, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });
const post = (path, obj) => call(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj || {}) });

// ---------- A tablet to control ----------
const enroll = await post('/devices/enroll', { name: 'Планшет управления', ttlMinutes: 30 });
const code = enroll.body.code;
const dev = await p.evaluate(async (c) => {
  const r = await fetch('/api/kiosk/enroll', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: c, name: 'Планшет управления' }) });
  return r.json();
}, code);
const devId = dev.deviceId;
ok(!!devId, 'tablet enrolled for control tests');

// ---------- Settings ----------
let s = (await call('/kiosk-control/settings')).body;
ok(s.enabled === false, 'control is off until the operator turns it on');
ok(s.port === 8080, 'default FreeKiosk port is 8080');

// While control is off, no command may leave the server.
let r = await post('/devices/' + devId + '/kiosk/reload', {});
ok(r.status === 502, 'command refused while control is off');
ok(calls().length === 0, 'nothing was sent to the tablet while control is off');

r = await put('/kiosk-control/settings', {
  enabled: true, port: TABLET_PORT, apiKey: 'secret-key', timeoutSec: 4,
  autoHeal: false, autoHealAfterMinutes: 15, batteryWarnPercent: 20, storageWarnPercent: 10
});
ok(r.status === 200 && r.body.enabled === true && r.body.port === TABLET_PORT, 'settings saved');
ok(r.body.timeoutSec === 4, 'timeout saved under timeoutSec');
ok(r.body.apiKeySet === true && r.body.apiKey === undefined, 'the API key is stored but never sent back');

// Out-of-range values are clamped, never stored raw.
r = await put('/kiosk-control/settings', {
  enabled: true, port: 999999, apiKey: 'secret-key', timeoutSec: 9999,
  autoHeal: false, autoHealAfterMinutes: 99999, batteryWarnPercent: 300, storageWarnPercent: -5
});
ok(r.body.port === 8080 && r.body.timeoutSec === 30 && r.body.autoHealAfterMinutes === 1440
  && r.body.batteryWarnPercent === 90 && r.body.storageWarnPercent === 0, 'settings are clamped');

// A blank key must keep the stored one, never wipe it: the form does not echo the key back.
r = await put('/kiosk-control/settings', {
  enabled: true, port: TABLET_PORT, apiKey: '', timeoutSec: 4,
  autoHeal: false, autoHealAfterMinutes: 15, batteryWarnPercent: 20, storageWarnPercent: 10
});
ok(r.body.apiKeySet === true, 'saving with a blank key keeps the stored key');

await put('/kiosk-control/settings', {
  enabled: true, port: TABLET_PORT, apiKey: 'secret-key', timeoutSec: 4,
  autoHeal: false, autoHealAfterMinutes: 15, batteryWarnPercent: 20, storageWarnPercent: 10
});

await put('/kiosk-control/settings', {
  enabled: true, port: TABLET_PORT, apiKey: 'secret-key', clearApiKey: true, timeoutSec: 4,
  autoHeal: false, autoHealAfterMinutes: 15, batteryWarnPercent: 20, storageWarnPercent: 10
});
await put('/kiosk-control/settings', {
  enabled: true, port: TABLET_PORT, apiKey: 'secret-key', timeoutSec: 4,
  autoHeal: false, autoHealAfterMinutes: 15, batteryWarnPercent: 20, storageWarnPercent: 10
});

// ---------- Control address ----------
r = await put('/devices/' + devId + '/control-address', { ip: 'evil.example.com', port: null });
ok(r.status === 400, 'a host name is refused as a control address');
r = await put('/devices/' + devId + '/control-address', { ip: '127.0.0.1', port: null });
ok(r.status === 400, 'loopback is refused as a control address');
r = await put('/devices/' + devId + '/control-address', { ip: '192.168.1.50:8080/x', port: null });
ok(r.status === 400, 'an address with a path is refused');
r = await put('/devices/' + devId + '/control-address', { ip: TABLET_IP, port: null });
ok(r.status === 200, 'a plain IP is accepted');

// ---------- Commands ----------
const commands = [
  ['reload', '/api/reload'],
  ['clear-cache', '/api/clearCache'],
  ['restart-app', '/api/restart-ui'],
  ['reboot', '/api/reboot'],
  ['screen-on', '/api/screen/on'],
  ['screen-off', '/api/screen/off'],
  ['beep', '/api/audio/beep'],
  ['wake', '/api/wake']
];
for (const [cmd, path] of commands) {
  const res = await post('/devices/' + devId + '/kiosk/' + cmd, {});
  const c = lastCall(path);
  ok(res.status === 200 && !!c, 'command ' + cmd + ' reached the tablet at ' + path);
}
ok(lastCall('/api/reload').key === 'secret-key', 'the API key is sent as X-Api-Key');

// A key carrying a newline must never become a second header on the wire.
r = await put('/kiosk-control/settings', {
  enabled: true, port: TABLET_PORT, apiKey: 'secret-key\r\nX-Injected: yes', timeoutSec: 4,
  autoHeal: false, autoHealAfterMinutes: 15, batteryWarnPercent: 20, storageWarnPercent: 10
});
ok(r.body.apiKeySet === true, 'a key with control characters is accepted after cleaning');
await post('/devices/' + devId + '/kiosk/reload', {});
ok(!/[\r\n]/.test(lastCall('/api/reload').key || ''), 'no control characters reach the tablet header');
await put('/kiosk-control/settings', {
  enabled: true, port: TABLET_PORT, apiKey: 'secret-key', clearApiKey: true, timeoutSec: 4,
  autoHeal: false, autoHealAfterMinutes: 15, batteryWarnPercent: 20, storageWarnPercent: 10
});
await put('/kiosk-control/settings', {
  enabled: true, port: TABLET_PORT, apiKey: 'secret-key', timeoutSec: 4,
  autoHeal: false, autoHealAfterMinutes: 15, batteryWarnPercent: 20, storageWarnPercent: 10
});

r = await post('/devices/' + devId + '/kiosk/format-sd-card', {});
ok(r.status === 400, 'an unknown command is refused, never forwarded');
ok(!calls().some(c => c.path.includes('format')), 'nothing resembling the unknown command was sent');

r = await post('/devices/' + devId + '/kiosk/../../api/reboot', {});
ok(r.status === 404 || r.status === 400, 'a path traversal in the command is not routed to the tablet');

// ---------- Brightness, volume, speech ----------
r = await post('/devices/' + devId + '/kiosk/brightness', { value: 45 });
ok(r.status === 200 && JSON.parse(lastCall('/api/brightness').body).brightness === 45, 'brightness sent');
r = await post('/devices/' + devId + '/kiosk/brightness', { value: 5000 });
ok(JSON.parse(lastCall('/api/brightness').body).brightness === 100, 'brightness clamped to 100');
r = await post('/devices/' + devId + '/kiosk/volume', { value: 30 });
ok(r.status === 200 && JSON.parse(lastCall('/api/volume').body).volume === 30, 'volume sent');
r = await post('/devices/' + devId + '/kiosk/say', { text: 'Подпишите документ' });
ok(r.status === 200 && JSON.parse(lastCall('/api/tts').body).text === 'Подпишите документ', 'speech sent');
r = await post('/devices/' + devId + '/kiosk/say', { text: '' });
ok(r.status === 400, 'empty speech text refused');
r = await post('/devices/' + devId + '/kiosk/say', { text: 'x'.repeat(501) });
ok(r.status === 400, 'over-long speech text refused');
r = await post('/devices/' + devId + '/kiosk/toast', { text: 'Здравствуйте' });
ok(r.status === 200 && lastCall('/api/toast'), 'toast sent');

// ---------- Health ----------
const h = (await call('/devices/' + devId + '/kiosk/health')).body;
ok(h.reachable === true, 'tablet reports reachable');
ok(h.batteryPercent === 17, 'battery read from a nested object');
ok(h.charging === false, 'charging read from a nested object');
ok(h.wifiSignalPercent === 71 && h.wifiSsid === 'office', 'wifi read');
ok(h.storageFreePercent === 9, 'free storage derived from raw sizes');
ok(h.memoryFreePercent === 42, 'memory percent read from its own container, not storage');
ok(h.deviceOwner === true, 'device owner reported');
ok(h.appVersion === '1.9.3' && h.androidVersion === '13' && h.model === 'Lenovo Tab M10', 'model and versions read');

// ---------- Screenshot ----------
const shot = await p.evaluate(async (id) => {
  const r = await fetch('/api/admin/devices/' + id + '/kiosk/screenshot', { credentials: 'same-origin' });
  const b = await r.blob();
  return { status: r.status, type: r.headers.get('content-type'), size: b.size };
}, devId);
ok(shot.status === 200 && shot.size > 0, 'screenshot bytes returned');
ok((shot.type || '').startsWith('image/'), 'screenshot served as an image, never as html');

// ---------- A tablet that does not answer ----------
await put('/devices/' + devId + '/control-address', { ip: '192.0.2.99', port: 9 });
const bad = (await call('/devices/' + devId + '/kiosk/health')).body;
ok(bad.reachable === false && !!bad.error, 'an unreachable tablet reports an error, not a crash');
r = await post('/devices/' + devId + '/kiosk/reload', {});
ok(r.status === 502 && !!r.body.error, 'a command to an unreachable tablet returns a clear error');
const badShot = await p.evaluate(async (id) => {
  const r = await fetch('/api/admin/devices/' + id + '/kiosk/screenshot', { credentials: 'same-origin' });
  return r.status;
}, devId);
ok(badShot === 502, 'a screenshot from an unreachable tablet fails cleanly');
await put('/devices/' + devId + '/control-address', { ip: TABLET_IP, port: null });

// A tablet nobody has ever addressed must not fall over either.
const e2 = await post('/devices/enroll', { name: 'Без адреса', ttlMinutes: 30 });
const dev2 = await p.evaluate(async (c) => {
  const r = await fetch('/api/kiosk/enroll', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: c, name: 'Без адреса' }) });
  return r.json();
}, e2.body.code);
const h2 = (await call('/devices/' + dev2.deviceId + '/kiosk/health')).body;
ok(h2.reachable === false, 'a tablet with no known address is simply unreachable');

r = await post('/devices/dev-missing/kiosk/reload', {});
ok(r.status === 404, 'a command for an unknown tablet is 404');

// ---------- The operator's screen ----------
await p.click('.tab[data-tab="devices"]');
await p.waitForSelector('[data-panel="devices"]:not(.hidden)', { timeout: 4000 });
ok(await p.isVisible('#kcEnabled'), 'control settings are on the tablets tab');
ok(await p.inputValue('#kcPort') === String(TABLET_PORT), 'the saved port is shown');
ok(await p.inputValue('#kcTimeout') === '4', 'the saved timeout is shown');
ok(await p.inputValue('#kcApiKey') === '', 'the key field is empty, the key is never echoed back');
ok(/сохранён/.test(await p.getAttribute('#kcApiKey', 'placeholder')), 'the form says a key is stored');

await p.waitForSelector('.dev-item', { timeout: 4000 });
const ctlBtn = p.locator('.dev-item', { hasText: 'Планшет управления' }).locator('button', { hasText: 'Управление' });
ok(await ctlBtn.count() === 1, 'every tablet card has a control button');
await ctlBtn.first().click();
await p.waitForSelector('.ctl-wrap', { timeout: 4000 });
await p.waitForFunction(() => {
  const h = document.querySelector('.ctl-health');
  return h && h.textContent && h.textContent.indexOf('Опрашиваю') === -1;
}, null, { timeout: 8000 });
const healthText = await p.textContent('.ctl-health');
ok(/Lenovo Tab M10/.test(healthText) && /17%/.test(healthText), 'the modal shows live health from the tablet');
ok(/Device Owner: включ/.test(healthText), 'the modal shows the Device Owner state');

const before = calls().filter(c => c.path === '/api/reload').length;
await p.locator('.ctl-grid button', { hasText: 'Обновить страницу' }).click();
await p.waitForFunction(() => /выполнено/.test(document.querySelector('.ctl-wrap .sig-meta').textContent), null, { timeout: 6000 });
ok(calls().filter(c => c.path === '/api/reload').length === before + 1, 'the control button really sends the command');

await p.locator('.ctl-shot button').click();
await p.waitForSelector('.ctl-shot-img[src^="blob:"]', { timeout: 8000 });
ok(true, 'the screenshot is shown in the modal');

// Closing the modal must release the screenshot blob, not leak it.
await p.click('#modalClose');
const leaked = await p.evaluate(() => document.querySelectorAll('#modalContent img[data-url]').length);
ok(leaked === 0, 'the screenshot blob is released when the modal closes');

// ---------- Turning control off stops everything ----------
await put('/kiosk-control/settings', {
  enabled: false, port: TABLET_PORT, apiKey: 'secret-key', timeoutSec: 4,
  autoHeal: false, autoHealAfterMinutes: 15, batteryWarnPercent: 20, storageWarnPercent: 10
});
const n = calls().length;
r = await post('/devices/' + devId + '/kiosk/reload', {});
ok(r.status === 502 && calls().length === n, 'no traffic to tablets once control is switched off');

// ---------- Signing is untouched by any of this ----------
const st = await call('/devices');
ok(st.status === 200, 'the tablet list still works with control off');

ok(jsErr.length === 0, 'no JavaScript errors in the admin panel: ' + jsErr.join(' | '));

await browser.close();
console.log(fail === 0 ? '\nALL PASS' : '\n' + fail + ' FAILED');
process.exit(fail === 0 ? 0 : 1);
