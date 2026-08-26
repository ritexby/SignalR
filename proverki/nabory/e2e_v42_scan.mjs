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
admin.on('pageerror', e => console.error('ADMIN JS ERROR:', e.message));
await admin.goto(BASE + '/admin/');
await admin.fill('#password', 'test123'); await admin.click('#loginForm button[type=submit]');
await admin.waitForSelector('#app:not(.hidden)', { timeout: 8000 });

const ws = await admin.evaluate(async () => (await fetch('/api/admin/workstations', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ externalId: 'WS-SCAN', name: 'Scan', location: '' }) })).json());
const enr = await admin.evaluate(async (wsId) => (await fetch('/api/admin/devices/enroll', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Сканер', workstationId: wsId, ttlMinutes: 30 }) })).json(), ws.id);
const tok = await admin.evaluate(async (code) => (await fetch('/api/kiosk/enroll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) })).json(), enr.code);
const key = await admin.evaluate(async () => (await (await fetch('/api/admin/apikeys', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label: 'k' }) })).json()).key);

// kiosk with a FAKE camera so getUserMedia succeeds headlessly
const kioskCtx = await browser.newContext({ permissions: ['camera'] });
const kiosk = await kioskCtx.newPage();
const kioskErr = [];
kiosk.on('pageerror', e => kioskErr.push(e.message));
await kiosk.goto(BASE + '/');
await kiosk.evaluate(t => localStorage.setItem('sk_device_token', t), tok.token);
await kiosk.reload();
await kiosk.waitForSelector('#slideshow:not(.hidden)', { timeout: 8000 }).catch(() => {});
await admin.waitForTimeout(800);

const devId = (await admin.evaluate(async () => (await fetch('/api/admin/devices', { credentials: 'same-origin' })).json())).find(d => d.name === 'Сканер').id;

// ---- 1) admin starts scanning: the tablet must show the scan screen ----
const startResp = await admin.evaluate(async (t) => {
  const r = await fetch('/api/admin/scan/start', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target: t }) });
  return { status: r.status, body: await r.json() };
}, 'device:' + devId);
ok(startResp.status === 200, 'admin scan/start accepted');
await kiosk.waitForSelector('#scan:not(.hidden)', { timeout: 6000 });
ok(true, 'tablet opened the scan screen');
const scanUi = await kiosk.evaluate(() => ({
  title: (document.querySelector('.scan-title') || {}).textContent,
  hasVideo: !!document.getElementById('scanVideo'),
  hasWindow: !!document.querySelector('.scan-window')
}));
ok(/код к камере/i.test(scanUi.title || ''), 'scan screen shows the prompt: ' + scanUi.title);
ok(scanUi.hasVideo && scanUi.hasWindow, 'scan screen has the camera window');

// ---- 2) simulate a decoded code (the decode itself is zxing's job) ----
const submit = await kiosk.evaluate(async () => {
  const r = await fetch('/api/scan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + localStorage.getItem('sk_device_token') },
    body: JSON.stringify({ code: '4601234567890', format: 'EAN_13' })
  });
  return { status: r.status, body: await r.json() };
});
ok(submit.status === 200, 'tablet submitted the scanned code');

// ---- 3) the code is stored and visible in the admin ----
await admin.waitForTimeout(300);
const scans = await admin.evaluate(async () => (await fetch('/api/admin/scans', { credentials: 'same-origin' })).json());
ok(scans.length >= 1 && scans[0].code === '4601234567890', 'code stored: ' + JSON.stringify(scans[0] && { c: scans[0].code, f: scans[0].format, d: scans[0].deviceName }));
ok(scans[0].format === 'EAN_13' && scans[0].deviceName === 'Сканер' && scans[0].workstationName === 'Scan', 'scan carries format, device and workstation');

// admin scan page renders it
await admin.click('.tab[data-tab="scan"]');
await admin.waitForTimeout(400);
const listed = await admin.evaluate(() => document.querySelectorAll('#scansList .sig-item').length);
ok(listed >= 1, 'admin scan page lists the code (' + listed + ')');

// ---- 4) external API: request a scan and WAIT for the code ----
const anon = await browser.newContext();
const pending = anon.request.post(BASE + '/api/ext/scan-request', {
  headers: { 'X-Api-Key': key, 'Content-Type': 'application/json' },
  data: JSON.stringify({ workstationExternalId: 'WS-SCAN', timeoutSec: 20 }), timeout: 30000
});
await kiosk.waitForSelector('#scan:not(.hidden)', { timeout: 6000 });
await kiosk.waitForTimeout(300);
await kiosk.evaluate(async () => {
  await fetch('/api/scan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + localStorage.getItem('sk_device_token') },
    body: JSON.stringify({ code: 'QR-PAYLOAD-42', format: 'QR_CODE' })
  });
});
const apiResp = await pending;
const apiJson = await apiResp.json();
ok(apiResp.status() === 200 && apiJson.code === 'QR-PAYLOAD-42' && apiJson.format === 'QR_CODE',
  'ext scan-request returned the scanned code synchronously: ' + JSON.stringify(apiJson));

// ---- 5) timeout path returns 408 and closes the camera ----
const t0 = Date.now();
const late = await anon.request.post(BASE + '/api/ext/scan-request', {
  headers: { 'X-Api-Key': key, 'Content-Type': 'application/json' },
  data: JSON.stringify({ deviceId: devId, timeoutSec: 5 }), timeout: 20000
});
ok(late.status() === 408, 'ext scan-request times out with 408 (' + late.status() + ', ' + Math.round((Date.now() - t0) / 1000) + 's)');
await kiosk.waitForFunction(() => document.getElementById('scan').classList.contains('hidden'), null, { timeout: 6000 });
const camReleased = await kiosk.evaluate(() => {
  const v = document.getElementById('scanVideo');
  return { hidden: document.getElementById('scan').classList.contains('hidden'), srcObject: !!(v && v.srcObject) };
});
ok(camReleased.hidden, 'tablet left the scan screen after the timeout');
ok(!camReleased.srcObject, 'camera stream released after the timeout');

// ---- 6) ext scans list ----
const extScans = await anon.request.get(BASE + '/api/ext/scans?limit=5', { headers: { 'X-Api-Key': key } });
const extList = await extScans.json();
ok(extScans.status() === 200 && extList.length >= 2, 'ext /scans returns recent codes (' + extList.length + ')');

ok(kioskErr.length === 0, 'no kiosk JS errors (' + JSON.stringify(kioskErr) + ')');

await browser.close();
console.log(fail === 0 ? '\nV4.2 SCAN E2E PASSED' : `\n${fail} CHECK(S) FAILED`);
process.exit(fail === 0 ? 0 : 1);
