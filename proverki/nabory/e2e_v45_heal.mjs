// v4.5 fleet health and auto-heal.
// Two tablets answer their own API but never talk to the service. One has been away just over the
// threshold (must be revived gently, by restarting the app), the other for far longer (must be
// rebooted). Battery and free space are read from the tablet and must raise operator alerts.
//
// The clock is moved by rewriting devices.json between two runs of the service, so the test is
// seconds long instead of minutes: the monitor polls health on its first pass after startup.
import fs from 'node:fs';
import { execSync, spawn } from 'node:child_process';

const SP = '' + (process.env.SK_RABOTA || '.') + '';
const BASE = 'http://127.0.0.1:5080';
const TABLET_IP = process.env.TABLET_IP || '192.0.2.2';
const TABLET_PORT = 8099;
const CALLS = SP + '/mock_calls.json';
const DATA = SP + '/data_v3';

let fail = 0;
const ok = (c, m) => { if (c) console.log('PASS', m); else { console.error('FAIL', m); fail++; } };
const calls = () => { try { return JSON.parse(fs.readFileSync(CALLS, 'utf8')); } catch { return []; } };
const sleep = (ms) => new Promise(res => setTimeout(res, ms));

let cookie = '';
async function api(path, opts = {}) {
  const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
  if (cookie) headers.Cookie = cookie;
  const r = await fetch(BASE + path, Object.assign({}, opts, { headers, redirect: 'manual' }));
  const set = r.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  let body = null; try { body = await r.json(); } catch { /* no body */ }
  return { status: r.status, body };
}
async function login() { cookie = ''; await api('/api/admin/login', { method: 'POST', body: JSON.stringify({ password: 'test123' }) }); }
async function waitUp() {
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(BASE + '/healthz'); if (r.ok) return true; } catch { /* not yet */ }
    await sleep(500);
  }
  throw new Error('service did not start');
}
function startService(logName) {
  const out = fs.openSync(SP + '/' + logName, 'w');
  const child = spawn('dotnet', ['/home/user/SignalR/src/SignatureKiosk/bin/Release/net10.0/SignatureKiosk.dll'], {
    env: Object.assign({}, process.env, {
      AdminPassword: 'test123', DataDir: DATA,
      ASPNETCORE_URLS: 'http://127.0.0.1:5080', ASPNETCORE_ENVIRONMENT: 'Production'
    }),
    stdio: ['ignore', out, out], detached: true
  });
  child.unref();
  return child;
}
function stopService() {
  try { execSync('pkill -f "SignatureKiosk.dll"'); } catch { /* not running */ }
  // pkill возвращается раньше, чем процесс действительно умрёт, а он в этот момент ещё пишет
  // в папку данных: без ожидания её удаление падает с ENOTEMPTY.
  for (let i = 0; i < 50; i++) {
    try { execSync('pgrep -f "SignatureKiosk.dll" > /dev/null'); } catch { return; }
    execSync('sleep 0.2');
  }
}

// ---------- Prepare: two tablets, control on, healing after 1 minute ----------
stopService();
fs.rmSync(DATA, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });
await fetch('http://' + TABLET_IP + ':' + TABLET_PORT + '/__reset');

startService('app_v45_heal_a.log');
await waitUp();
await login();

let r = await api('/api/admin/kiosk-control/settings', {
  method: 'PUT',
  body: JSON.stringify({
    enabled: true, port: TABLET_PORT, apiKey: 'secret-key', timeoutSec: 4,
    autoHeal: true, autoHealAfterMinutes: 1, batteryWarnPercent: 20, storageWarnPercent: 10
  })
});
ok(r.status === 200 && r.body.autoHeal === true, 'auto-heal switched on');

const ids = {};
for (const [key, name] of [['soft', 'Планшет завис ненадолго'], ['hard', 'Планшет завис давно']]) {
  const enr = await api('/api/admin/devices/enroll', { method: 'POST', body: JSON.stringify({ name, ttlMinutes: 30 }) });
  const dev = await api('/api/kiosk/enroll', { method: 'POST', body: JSON.stringify({ code: enr.body.code, name }) });
  ids[key] = dev.body.deviceId;
  await api('/api/admin/devices/' + ids[key] + '/control-address', { method: 'PUT', body: JSON.stringify({ ip: TABLET_IP, port: null }) });
}
ok(!!ids.soft && !!ids.hard, 'two tablets enrolled and addressed');

// ---------- Move their last contact into the past ----------
stopService();
await sleep(1500);
const devices = JSON.parse(fs.readFileSync(DATA + '/devices.json', 'utf8'));
const ago = (min) => new Date(Date.now() - min * 60000).toISOString();
for (const d of devices) {
  if (d.id === ids.soft) { d.lastSeenUtc = ago(2); }         // just over the 1 minute threshold
  if (d.id === ids.hard) { d.lastSeenUtc = ago(60); }        // far past 3x the threshold
}
fs.writeFileSync(DATA + '/devices.json', JSON.stringify(devices, null, 2));

await fetch('http://' + TABLET_IP + ':' + TABLET_PORT + '/__reset');
startService('app_v45_heal_b.log');
await waitUp();
await login();

// The monitor polls health on its first pass; give it room for the round trips.
await sleep(8000);

// A restart must never be mistaken for a stuck fleet. No tablet has had time to reconnect yet,
// so healing has to stay off its hands, even though every tablet looks away and answers its API.
ok(calls().filter(c => c.path === '/api/status').length === 2, 'health polled once per tablet');
ok(calls().filter(c => c.path === '/api/restart-ui').length === 0, 'nothing is restarted during the grace after a restart');
ok(calls().filter(c => c.path === '/api/reboot').length === 0, 'nothing is rebooted during the grace after a restart');

// ---------- Alerts the operator sees ----------
let alerts = (await api('/api/admin/alerts')).body.alerts || [];
let kinds = alerts.map(a => a.kind);
ok(kinds.includes('battery'), 'a low battery raises an alert: ' + kinds.join(','));
ok(kinds.includes('storage'), 'low free space raises an alert');
ok(!kinds.includes('stuck'), 'no tablet is called stuck during the grace');

const battery = alerts.find(a => a.kind === 'battery');
ok(/17%/.test(battery.title), 'the battery alert shows the reading: ' + battery.title);
ok(/Проверьте кабель/.test(battery.detail), 'the tablet said it is not charging, so the advice says so');

// ---------- Past the grace: the stuck tablets are revived ----------
// The grace is 2 minutes and health is polled every 5, so the next pass does the work.
console.log('waiting for the first pass after the startup grace (about 5 minutes)...');
for (var waited = 0; waited < 400 && calls().filter(c => c.path === '/api/restart-ui').length < 2; waited += 5)
  await sleep(5000);

ok(calls().filter(c => c.path === '/api/restart-ui').length === 2, 'both stuck tablets get their app restarted');
ok(calls().filter(c => c.path === '/api/reboot').length === 0, 'the gentle fix is tried before any reboot');

alerts = (await api('/api/admin/alerts')).body.alerts || [];
kinds = alerts.map(a => a.kind);
ok(kinds.filter(k => k === 'stuck').length === 2, 'both stuck tablets raise an alert: ' + kinds.join(','));
const stuck = alerts.find(a => a.kind === 'stuck');
ok(/завис/.test(stuck.title), 'the stuck alert is in plain Russian: ' + stuck.title);
ok(stuck.deviceId === ids.soft || stuck.deviceId === ids.hard, 'the stuck alert names the tablet');

// The healing action is written to the log the operator can read.
const logs = (await api('/api/admin/logs?limit=200')).body;
const entries = (logs.entries || logs || []);
const healLines = entries.filter(e => /Автолечение/.test(e.message || ''));
ok(healLines.length === 2, 'both healing actions are in the log (' + healLines.length + ')');
ok(healLines.every(e => e.level !== 'error'), 'a failed heal is not logged as an error, so it cannot feed the error alert');

// ---------- One attempt per interval ----------
const beforeSecond = calls().length;
await sleep(31000);
ok(calls().length === beforeSecond, 'health is not polled again within the 5 minute interval');

// ---------- Turning alerting off silences the tablet alerts too ----------
await api('/api/admin/alerts/settings', {
  method: 'PUT',
  body: JSON.stringify({ enabled: false, offlineMinutes: 10, errorCount: 5, errorWindowMinutes: 10 })
});
await sleep(32000);
const quiet = ((await api('/api/admin/alerts')).body.alerts || []).map(a => a.kind);
ok(!quiet.includes('battery') && !quiet.includes('storage') && !quiet.includes('stuck'),
  'tablet alerts obey the alerting switch as well: ' + quiet.join(','));
await api('/api/admin/alerts/settings', {
  method: 'PUT',
  body: JSON.stringify({ enabled: true, offlineMinutes: 10, errorCount: 5, errorWindowMinutes: 10 })
});

// ---------- Switching control off clears what it raised ----------
await api('/api/admin/kiosk-control/settings', {
  method: 'PUT',
  body: JSON.stringify({
    enabled: false, port: TABLET_PORT, apiKey: 'secret-key', timeoutSec: 4,
    autoHeal: false, autoHealAfterMinutes: 1, batteryWarnPercent: 20, storageWarnPercent: 10
  })
});
await sleep(32000);
const after = ((await api('/api/admin/alerts')).body.alerts || []).map(a => a.kind);
ok(!after.includes('battery') && !after.includes('storage') && !after.includes('stuck'),
  'health alerts disappear when control is switched off: ' + after.join(','));

stopService();
console.log(fail === 0 ? '\nALL PASS' : '\n' + fail + ' FAILED');
process.exit(fail === 0 ? 0 : 1);
