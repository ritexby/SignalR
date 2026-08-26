import { chromium } from 'playwright';
import fs from 'fs';

const BASE = 'http://127.0.0.1:5080';
// Путь к браузеру берётся из окружения: на другой машине он другой, а зашитый путь
// превращал набор в неработающий у всех, кроме одной установки. Пусто значит
// «пусть Playwright возьмёт свой», как он и делает по умолчанию.
const EXE = process.env.SK_CHROME || undefined;
const PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

let fail = 0;
const ok = (c, m) => { if (c) console.log('PASS', m); else { console.error('FAIL', m); fail++; } };

const browser = await chromium.launch({ executablePath: EXE, headless: true });

const adminCtx = await browser.newContext();
const kioskCtx = await browser.newContext();
const anonCtx = await browser.newContext();

// ---- admin login ----
const admin = await adminCtx.newPage();
await admin.goto(BASE + '/admin/');
await admin.fill('#password', 'test123');
await admin.click('#loginForm button[type=submit]');
await admin.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
ok(true, 'admin logged in');

const aFetch = (path, opts) => admin.evaluate(async ([p, o]) => {
  const r = await fetch('/api/admin' + p, Object.assign({ credentials: 'same-origin' }, o || {}));
  const t = await r.text(); try { return { status: r.status, json: JSON.parse(t) }; } catch { return { status: r.status, text: t }; }
}, [path, opts]);
const aPost = (p, body) => aFetch(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });

// ---- v3: security response headers ----
const hResp = await anonCtx.request.get(BASE + '/admin/');
const H = hResp.headers();
ok((H['content-security-policy'] || '').includes("frame-ancestors 'none'"), 'CSP header present with frame-ancestors none');
ok(H['x-content-type-options'] === 'nosniff', 'X-Content-Type-Options nosniff');
ok(H['x-frame-options'] === 'DENY', 'X-Frame-Options DENY');
ok(H['referrer-policy'] === 'no-referrer', 'Referrer-Policy no-referrer');

// ---- create group + workstation ----
const grp = (await aPost('/groups', { name: 'Ресепшены' })).json;
ok(!!grp.id, 'group created ' + grp.id);
const ws = (await aPost('/workstations', { externalId: 'WS-204', name: 'Ресепшн 1', location: 'Холл' })).json;
ok(!!ws.id, 'workstation created ' + ws.id + ' (WS-204)');

// ---- upload one image ----
const imgs = await admin.evaluate(async (b64) => {
  const bin = atob(b64), arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  const fd = new FormData(); fd.append('files', new Blob([arr], { type: 'image/png' }), 'ad.png');
  const r = await fetch('/api/admin/images', { method: 'POST', credentials: 'same-origin', body: fd });
  return r.json();
}, PX);
// Загрузка отвечает списком принятых и списком отклонённых с причиной: раньше был просто
// массив, и молча пропущенный файл выглядел как успешно загруженный.
const imageId = (imgs.added || [])[0].id;
ok(!!imageId, 'image uploaded');

// ---- create enrollment code bound to workstation + group ----
const enr = (await aPost('/devices/enroll', { name: 'Планшет Ресепшн', workstationId: ws.id, groupIds: [grp.id], ttlMinutes: 30 })).json;
ok(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(enr.code), 'enrollment code ' + enr.code);

// ---- kiosk enrolls via ?enroll= ----
const kiosk = await kioskCtx.newPage();
kiosk.on('pageerror', e => console.error('KIOSK JS ERROR:', e.message));
await kiosk.goto(BASE + '/?enroll=' + enr.code);
await kiosk.waitForSelector('#slideshow:not(.hidden)', { timeout: 8000 }).catch(() => {});
const token = await kiosk.evaluate(() => localStorage.getItem('sk_device_token'));
ok(!!token && token.indexOf('.') > 0, 'kiosk enrolled, token stored');

// ---- v3: no leftover device badge on the tablet page ----
ok(await kiosk.evaluate(() => !document.getElementById('deviceBadge')), 'device badge removed from tablet page');

// ---- device shows up online in admin, with workstation + group ----
let dev = null;
for (let i = 0; i < 40; i++) {
  const list = (await aFetch('/devices')).json || [];
  dev = list.find(d => d.online);
  if (dev) break; await kiosk.waitForTimeout(250);
}
ok(!!dev, 'device online in admin');
ok(dev && dev.workstationName === 'Ресепшн 1', 'device bound to workstation (' + (dev && dev.workstationName) + ')');
ok(dev && dev.workstation && dev.workstation.externalId === 'WS-204' && dev.workstation.location === 'Холл',
  'device carries workstation external ID + description');
ok(dev && dev.groups && dev.groups.indexOf('Ресепшены') >= 0, 'device in group');

// ---- push slides to ALL -> kiosk shows it ----
await aFetch('/playlist', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target: 'all', imageIds: [imageId], intervalSec: 3 }) });
await kiosk.waitForSelector('#slideA[src*="/media/"]', { timeout: 6000 });
ok(true, 'all target: kiosk shows slides');

// ---- show document to the specific DEVICE -> kiosk shows document ----
await aPost('/show-document', { target: 'device:' + dev.id });
await kiosk.waitForSelector('#document:not(.hidden)', { timeout: 6000 });
ok(true, 'device target: kiosk shows document');

// ---- v3 KEY SCENARIO: re-push ads to ALL must NOT interrupt the tablet mid-document ----
await aFetch('/playlist', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target: 'all', imageIds: [imageId], intervalSec: 5 }) });
await kiosk.waitForTimeout(800);
const stillDoc = await kiosk.evaluate(() =>
  !document.getElementById('document').classList.contains('hidden') &&
  document.getElementById('slideshow').classList.contains('hidden'));
ok(stillDoc, 'independent targeting: ads to ALL did not interrupt the signing tablet');

// ---- v4: a document can ONLY ever go to one tablet; group/all are rejected ----
ok((await aPost('/show-document', { target: 'group:' + grp.id })).status === 400, 'document to a GROUP is rejected (single-tablet rule)');
ok((await aPost('/show-document', { target: 'all' })).status === 400, 'document to ALL is rejected (single-tablet rule)');
await aPost('/show-document', { target: 'device:' + dev.id });
await kiosk.waitForSelector('#document:not(.hidden)', { timeout: 6000 });
ok(true, 'document to a single device still works');

// ---- drive signing ----
let signed = false;
for (let step = 0; step < 12; step++) {
  if (await kiosk.$('#btnSign')) {
    const box = await kiosk.locator('#document canvas').boundingBox();
    await kiosk.mouse.move(box.x + 30, box.y + 40); await kiosk.mouse.down();
    await kiosk.mouse.move(box.x + 130, box.y + 90, { steps: 6 });
    await kiosk.mouse.move(box.x + 210, box.y + 50, { steps: 6 }); await kiosk.mouse.up();
    await kiosk.waitForSelector('#btnSign:not([disabled])', { timeout: 3000 });
    await kiosk.click('#btnSign'); signed = true; break;
  } else if (await kiosk.$('#btnNext')) {
    for (const b of await kiosk.$$('#document .check input')) if (!(await b.isChecked())) await b.click();
    await kiosk.waitForSelector('#btnNext:not([disabled])', { timeout: 3000 });
    await kiosk.click('#btnNext'); await kiosk.waitForTimeout(120);
  } else break;
}
ok(signed, 'reached signature and signed');
await kiosk.waitForSelector('#document .thankyou', { timeout: 6000 });
ok(true, 'thank-you shown');

// ---- signature recorded with workstation ----
await admin.waitForTimeout(400);
const sigs = (await aFetch('/signatures')).json || [];
ok(sigs.length >= 1 && sigs[0].workstationName === 'Ресепшн 1', 'signature recorded with workstation');

// ---- PDF generated for the signature (real canvas PNG) ----
const sigId = sigs[0].id;
const pdfResp = await adminCtx.request.get(BASE + '/api/admin/signatures/' + sigId + '/pdf');
const pdfBuf = await pdfResp.body();
fs.writeFileSync('' + (process.env.SK_RABOTA || '.') + '/e2e_out.pdf', pdfBuf);
ok(pdfResp.status() === 200 && pdfBuf.slice(0, 4).toString('latin1') === '%PDF' && pdfBuf.length > 2000,
  'signature PDF generated (' + pdfBuf.length + ' bytes)');

// ---- identify ----
await aPost('/devices/' + dev.id + '/identify', {});
await kiosk.waitForSelector('#identifyOverlay:not(.hidden)', { timeout: 4000 });
const idCode = await kiosk.textContent('#identifyCode');
ok(idCode && idCode.length >= 3, 'identify overlay shown with code ' + idCode);

// ---- security: anonymous cannot reach the hub ----
const anonNeg = await anonCtx.request.post(BASE + '/hub/kiosk/negotiate?negotiateVersion=1');
ok(anonNeg.status() === 401, 'anonymous hub negotiate rejected (401), got ' + anonNeg.status());
const devNeg = await anonCtx.request.post(BASE + '/hub/kiosk/negotiate?negotiateVersion=1', { headers: { Authorization: 'Bearer ' + token } });
ok(devNeg.status() === 200, 'device-token hub negotiate accepted (200), got ' + devNeg.status());

// ---- fresh kiosk with no token -> enrollment screen ----
const kiosk2 = await (await browser.newContext()).newPage();
await kiosk2.goto(BASE + '/');
await kiosk2.waitForSelector('#enroll:not(.hidden)', { timeout: 5000 }).catch(() => {});
ok(await kiosk2.evaluate(() => !document.getElementById('enroll').classList.contains('hidden')), 'fresh kiosk shows enrollment screen');

// ---- external API by key ----
const key = (await aPost('/apikeys', { label: 'ERP' })).json.key;
ok(!!key, 'api key created');
const extDevices = await anonCtx.request.get(BASE + '/api/ext/devices', { headers: { 'X-Api-Key': key } });
const extJson = await extDevices.json();
ok(extDevices.status() === 200 && extJson.some(d => d.workstation && d.workstation.externalId === 'WS-204'), 'external API returns device with workstation WS-204');
const extNoKey = await anonCtx.request.get(BASE + '/api/ext/devices');
ok(extNoKey.status() === 401, 'external API without key rejected (401)');

// ---- revoke -> token no longer authenticates ----
await aPost('/devices/' + dev.id + '/revoke', {});
await admin.waitForTimeout(200);
const revNeg = await anonCtx.request.post(BASE + '/hub/kiosk/negotiate?negotiateVersion=1', { headers: { Authorization: 'Bearer ' + token } });
ok(revNeg.status() === 401, 'revoked device token rejected (401), got ' + revNeg.status());
const reuse = await anonCtx.request.post(BASE + '/api/kiosk/enroll', { headers: { 'Content-Type': 'application/json' }, data: JSON.stringify({ code: enr.code }) });
ok(reuse.status() === 400, 'used enrollment code cannot be reused (400), got ' + reuse.status());

// ---- v3: rate limit on admin login (policy = 10/min per IP) ----
let got429 = false;
for (let i = 0; i < 15; i++) {
  const r = await anonCtx.request.post(BASE + '/api/admin/login', { headers: { 'Content-Type': 'application/json' }, data: JSON.stringify({ password: 'wrong' }) });
  if (r.status() === 429) { got429 = true; break; }
}
ok(got429, 'admin login rate-limited (429) after burst');

await browser.close();
console.log(fail === 0 ? '\nALL v3 E2E CHECKS PASSED' : `\n${fail} v3 CHECK(S) FAILED`);
process.exit(fail === 0 ? 0 : 1);
