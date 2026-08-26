import { chromium } from 'playwright';
const BASE = 'http://127.0.0.1:5080';
// Путь к браузеру берётся из окружения: на другой машине он другой, а зашитый путь
// превращал набор в неработающий у всех, кроме одной установки. Пусто значит
// «пусть Playwright возьмёт свой», как он и делает по умолчанию.
const EXE = process.env.SK_CHROME || undefined;
const OUT = '' + (process.env.SK_RABOTA || '.') + '/audit/';
const PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
import fs from 'fs';
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const admin = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const ap = await admin.newPage();
await ap.goto(BASE + '/admin/');
await ap.fill('#password', 'test123');
await ap.click('#loginForm button[type=submit]');
await ap.waitForSelector('#app:not(.hidden)', { timeout: 8000 });

const aFetch = (path, opts) => ap.evaluate(async ([p, o]) => {
  const r = await fetch('/api/admin' + p, Object.assign({ credentials: 'same-origin' }, o || {}));
  const t = await r.text(); try { return JSON.parse(t); } catch { return t; }
}, [path, opts]);
const aPost = (p, body) => aFetch(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });

// seed data
const grp = await aPost('/groups', { name: 'Ресепшены' });
const grp2 = await aPost('/groups', { name: 'Кассы 1 этаж' });
const ws = await aPost('/workstations', { externalId: 'WS-204', name: 'Ресепшн 1', location: 'Главный холл, 1 этаж' });
await aPost('/workstations', { externalId: 'WS-101', name: 'Касса 1', location: 'Торговый зал' });
await ap.evaluate(async (b64) => {
  const bin = atob(b64), arr = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  const fd = new FormData(); fd.append('files', new Blob([arr], { type: 'image/png' }), 'reklama.png');
  await fetch('/api/admin/images', { method: 'POST', credentials: 'same-origin', body: fd });
}, PX);

// enroll 3 devices: redeem all (creates devices), connect only 1 -> 1 online, 2 offline
async function enroll(name, wsId, groupIds) {
  const e = await aPost('/devices/enroll', { name, workstationId: wsId, groupIds, ttlMinutes: 60 });
  const r = await ap.evaluate(async (code) => {
    const res = await fetch('/api/kiosk/enroll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
    return res.json();
  }, e.code);
  return r.token;
}
const tokOnline = await enroll('Ресепшн 1 планшет', ws.id, [grp.id]);
await enroll('Касса 1 планшет', null, [grp2.id]);
await enroll('Резерв (без места)', null, []);

// connect one kiosk so it is online
const kioskCtx = await browser.newContext({ viewport: { width: 900, height: 1400 } });
const kiosk = await kioskCtx.newPage();
await kiosk.goto(BASE + '/');
await kiosk.evaluate((t) => localStorage.setItem('sk_device_token', t), tokOnline);
await kiosk.reload();
await kiosk.waitForSelector('#slideshow:not(.hidden)', { timeout: 8000 }).catch(() => {});
await ap.waitForTimeout(1500);

// push slides to all so the online kiosk shows an ad
const imgs = await aFetch('/images');
await aFetch('/playlist', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target: 'all', imageIds: imgs.map(i => i.id), intervalSec: 5 }) });

const WIDTHS = [1440, 1280, 1024, 768];
const TABS = ['slides', 'document', 'signatures', 'devices', 'groups', 'workstations', 'apikeys', 'apidocs'];

async function shootTab(tab, width) {
  await ap.setViewportSize({ width, height: 1000 });
  await ap.click('.tab[data-tab="' + tab + '"]');
  await ap.waitForSelector('[data-panel="' + tab + '"]:not(.hidden)', { timeout: 4000 });
  await ap.waitForTimeout(250);
  await ap.screenshot({ path: OUT + `admin_${tab}_${width}.png`, fullPage: false });
}

// full matrix for the two reported-problem tabs, plus key widths for the rest
for (const w of WIDTHS) { await shootTab('document', w); await shootTab('devices', w); }
for (const t of ['slides', 'signatures', 'groups', 'workstations', 'apikeys', 'apidocs']) {
  await shootTab(t, 1280); await shootTab(t, 768);
}

// signature detail modal (drive one signature first)
await aPost('/show-document', { target: 'all' });
await kiosk.waitForSelector('#document:not(.hidden)', { timeout: 6000 }).catch(() => {});
for (let step = 0; step < 12; step++) {
  if (await kiosk.$('#btnSign')) {
    const box = await kiosk.locator('#document canvas').boundingBox();
    await kiosk.mouse.move(box.x + 40, box.y + 40); await kiosk.mouse.down();
    await kiosk.mouse.move(box.x + 160, box.y + 90, { steps: 6 });
    await kiosk.mouse.move(box.x + 240, box.y + 50, { steps: 6 }); await kiosk.mouse.up();
    await kiosk.waitForSelector('#btnSign:not([disabled])', { timeout: 3000 });
    await kiosk.screenshot({ path: OUT + 'kiosk_document_900.png' });
    await kiosk.click('#btnSign'); break;
  } else if (await kiosk.$('#btnNext')) {
    for (const b of await kiosk.$$('#document .check input')) if (!(await b.isChecked())) await b.click();
    await kiosk.waitForSelector('#btnNext:not([disabled])', { timeout: 3000 });
    await kiosk.click('#btnNext'); await kiosk.waitForTimeout(120);
  } else break;
}
await kiosk.waitForTimeout(400);
await kiosk.screenshot({ path: OUT + 'kiosk_thankyou_900.png' });

// admin signature modal
await ap.setViewportSize({ width: 1280, height: 1000 });
await ap.click('.tab[data-tab="signatures"]');
await ap.waitForTimeout(600);
if (await ap.$('#signaturesList .sig-item')) {
  await ap.click('#signaturesList .sig-item');
  await ap.waitForSelector('#modal:not(.hidden)', { timeout: 4000 });
  await ap.waitForTimeout(300);
  await ap.screenshot({ path: OUT + 'admin_signature_modal.png' });
  await ap.click('#modalClose');
}

// device add modal (enroll code)
await ap.click('.tab[data-tab="devices"]');
await ap.waitForTimeout(300);
await ap.click('#addDevice');
await ap.waitForSelector('#modal:not(.hidden)', { timeout: 4000 });
await ap.waitForTimeout(200);
await ap.screenshot({ path: OUT + 'admin_adddevice_modal.png' });
await ap.click('#modalClose');

// kiosk enroll screen (fresh context)
const freshCtx = await browser.newContext({ viewport: { width: 900, height: 1400 } });
const fresh = await freshCtx.newPage();
await fresh.goto(BASE + '/');
await fresh.waitForSelector('#enroll:not(.hidden)', { timeout: 5000 }).catch(() => {});
await fresh.screenshot({ path: OUT + 'kiosk_enroll_900.png' });

// login screen
const loginCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const lp = await loginCtx.newPage();
await lp.goto(BASE + '/admin/');
await lp.waitForSelector('#login:not(.hidden)', { timeout: 4000 }).catch(() => {});
await lp.screenshot({ path: OUT + 'admin_login.png' });

await browser.close();
console.log('audit screenshots done ->', OUT);
