import { chromium } from 'playwright';
const BASE = 'http://127.0.0.1:5080';
// Путь к браузеру берётся из окружения: на другой машине он другой, а зашитый путь
// превращал набор в неработающий у всех, кроме одной установки. Пусто значит
// «пусть Playwright возьмёт свой», как он и делает по умолчанию.
const EXE = process.env.SK_CHROME || undefined;
let fail = 0;
const ok = (c, m) => { if (c) console.log('PASS', m); else { console.error('FAIL', m); fail++; } };
const browser = await chromium.launch({ executablePath: EXE, headless: true });

const adminCtx = await browser.newContext();
const admin = await adminCtx.newPage();
await admin.goto(BASE + '/admin/');
await admin.fill('#password', 'test123');
await admin.click('#loginForm button[type=submit]');
await admin.waitForSelector('#app:not(.hidden)', { timeout: 8000 });

const enr = await admin.evaluate(async () => (await fetch('/api/admin/devices/enroll', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'IP-тест', ttlMinutes: 30 }) })).json());
const tok = await admin.evaluate(async (code) => (await fetch('/api/kiosk/enroll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) })).json(), enr.code);

const devs = () => admin.evaluate(async () => (await fetch('/api/admin/devices', { credentials: 'same-origin' })).json());

// connect a kiosk
const kioskCtx = await browser.newContext();
const kiosk = await kioskCtx.newPage();
await kiosk.goto(BASE + '/');
await kiosk.evaluate(t => localStorage.setItem('sk_device_token', t), tok.token);
await kiosk.reload();
await kiosk.waitForSelector('#slideshow:not(.hidden)', { timeout: 8000 }).catch(() => {});
await admin.waitForTimeout(1200);

let d = (await devs()).find(x => x.name === 'IP-тест');
console.log('ONLINE snapshot:', JSON.stringify({ online: d.online, lastIp: d.lastIp, lastSeenUtc: d.lastSeenUtc }));
ok(d.online === true, 'планшет онлайн после подключения');
ok(!!d.lastIp, 'у онлайн-планшета есть текущий IP: ' + d.lastIp);

// disconnect the kiosk -> should go offline, lastSeenUtc stamps the disconnect moment
const beforeClose = Date.now();
await kiosk.close();
await kioskCtx.close();
// poll until offline (server detects clean close quickly)
let offline = null;
for (let i = 0; i < 20; i++) {
  await admin.waitForTimeout(500);
  offline = (await devs()).find(x => x.name === 'IP-тест');
  if (offline && offline.online === false) break;
}
console.log('OFFLINE snapshot:', JSON.stringify({ online: offline.online, lastIp: offline.lastIp, lastSeenUtc: offline.lastSeenUtc }));
ok(offline.online === false, 'планшет офлайн после отключения');
const seenMs = new Date(offline.lastSeenUtc).getTime();
ok(seenMs >= beforeClose - 3000, 'время последней связи зафиксировано в момент отключения (свежее)');
ok(!!offline.lastIp, 'у офлайн-планшета сохранён последний IP: ' + offline.lastIp);

await browser.close();
console.log(fail === 0 ? '\nIP/ONLINE LOGIC OK' : `\n${fail} CHECK(S) FAILED`);
process.exit(fail === 0 ? 0 : 1);
