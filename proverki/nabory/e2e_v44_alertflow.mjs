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
const jsErr = []; admin.on('pageerror', e => jsErr.push(e.message));
await admin.goto(BASE + '/admin/');
await admin.fill('#password', 'test123'); await admin.click('#loginForm button[type=submit]');
await admin.waitForSelector('#app:not(.hidden)', { timeout: 8000 });

const api = (path, opts) => admin.evaluate(async ([p, o]) => {
  const r = await fetch('/api/admin' + p, Object.assign({ credentials: 'same-origin' }, o || {}));
  const t = await r.text(); try { return JSON.parse(t); } catch { return t; }
}, [path, opts]);
const put = (p, body) => api(p, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

// Alert as soon as a tablet is off air for 1 minute, and on 2 errors in 1 minute.
await put('/alerts/settings', { enabled: true, offlineMinutes: 1, errorCount: 2, errorWindowMinutes: 1 });

// A tablet connects, then disappears.
const enr = await api('/devices/enroll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Пропавший', ttlMinutes: 30 }) });
const tok = await admin.evaluate(async (c) => (await fetch('/api/kiosk/enroll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: c }) })).json(), enr.code);
const kioskCtx = await browser.newContext();
const kiosk = await kioskCtx.newPage();
await kiosk.goto(BASE + '/');
await kiosk.evaluate(t => localStorage.setItem('sk_device_token', t), tok.token);
await kiosk.reload();
await kiosk.waitForSelector('#slideshow:not(.hidden)', { timeout: 8000 }).catch(() => {});
await admin.waitForTimeout(800);

// It goes off air. The monitor should raise an alert once it has been away longer than a minute.
await kiosk.close(); await kioskCtx.close();
console.log('tablet disconnected, waiting for the offline alert (monitor runs every 30 s)...');

let offlineAlert = null;
for (let i = 0; i < 30; i++) {          // up to ~2.5 minutes
  await admin.waitForTimeout(5000);
  const data = await api('/alerts');
  offlineAlert = (data.alerts || []).find(a => a.kind === 'offline');
  if (offlineAlert) break;
}
ok(!!offlineAlert, 'offline alert raised for a tablet that went off air');
if (offlineAlert) {
  ok(/Пропавший/.test(offlineAlert.title || ''), 'alert names the tablet: ' + offlineAlert.title);
  ok(offlineAlert.severity === 'error', 'offline alert is an error');
  ok(!!offlineAlert.detail, 'alert explains how long it has been away: ' + offlineAlert.detail);
}

// The tablet comes back: the alert must clear itself.
const kiosk2Ctx = await browser.newContext();
const kiosk2 = await kiosk2Ctx.newPage();
await kiosk2.goto(BASE + '/');
await kiosk2.evaluate(t => localStorage.setItem('sk_device_token', t), tok.token);
await kiosk2.reload();
await kiosk2.waitForSelector('#slideshow:not(.hidden)', { timeout: 8000 }).catch(() => {});
console.log('tablet reconnected, waiting for the alert to clear...');

let cleared = false;
for (let i = 0; i < 20; i++) {
  await admin.waitForTimeout(5000);
  const data = await api('/alerts');
  if (!(data.alerts || []).some(a => a.kind === 'offline')) { cleared = true; break; }
}
ok(cleared, 'offline alert cleared itself once the tablet came back');

ok(jsErr.length === 0, 'no admin JS errors (' + JSON.stringify(jsErr) + ')');
await browser.close();
console.log(fail === 0 ? '\nALERT FLOW PASSED' : `\n${fail} CHECK(S) FAILED`);
process.exit(fail === 0 ? 0 : 1);
