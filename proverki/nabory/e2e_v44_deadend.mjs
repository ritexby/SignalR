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
await admin.goto(BASE + '/admin/');
await admin.fill('#password', 'test123'); await admin.click('#loginForm button[type=submit]');
await admin.waitForSelector('#app:not(.hidden)', { timeout: 8000 });

async function enrolTablet(name, opts) {
  const enr = await admin.evaluate(async (n) => (await fetch('/api/admin/devices/enroll', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: n, ttlMinutes: 30 }) })).json(), name);
  const tok = await admin.evaluate(async (c) => (await fetch('/api/kiosk/enroll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: c }) })).json(), enr.code);
  const ctx = await browser.newContext(opts || {});
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', e => errs.push(e.message));
  await page.goto(BASE + '/');
  await page.evaluate(t => localStorage.setItem('sk_device_token', t), tok.token);
  await page.reload();
  await page.waitForSelector('#slideshow:not(.hidden)', { timeout: 8000 }).catch(() => {});
  await admin.waitForTimeout(700);
  const id = (await admin.evaluate(async (n) => (await fetch('/api/admin/devices', { credentials: 'same-origin' })).json().then(l => l.filter(d => d.name === n)), name)).slice(-1)[0].id;
  return { page, id, errs };
}
const startScan = (id) => admin.evaluate(async (t) => {
  await fetch('/api/admin/scan/start', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target: t }) });
}, 'device:' + id);

// ---- 1) Camera unavailable must not strand the tablet on the scan screen ----
// This context has NO camera permission, so getUserMedia is refused, exactly like a tablet whose
// owner denied access. Before the fix the tablet stayed on that black screen forever.
const denied = await enrolTablet('NoCam');
await startScan(denied.id);
await denied.page.waitForSelector('#scan:not(.hidden)', { timeout: 6000 });
ok(true, 'tablet opened the scan screen');
const msg = await denied.page.evaluate(() => (document.getElementById('scanMsg') || {}).textContent);
ok(/камер/i.test(msg || ''), 'tablet reports the camera problem: ' + msg);

await denied.page.waitForFunction(() => document.getElementById('scan').classList.contains('hidden'), null, { timeout: 15000 });
const left = await denied.page.evaluate(() => ({
  scanHidden: document.getElementById('scan').classList.contains('hidden'),
  slides: !document.getElementById('slideshow').classList.contains('hidden'),
  doc: !document.getElementById('document').classList.contains('hidden'),
  code: (document.getElementById('scanCode') || {}).textContent,
  video: !!(document.getElementById('scanVideo') || {}).srcObject
}));
ok(left.scanHidden, 'tablet leaves the scan screen by itself when the camera is unavailable');
ok(left.slides || left.doc, 'tablet lands on a usable screen (ads or document)');
ok(!left.code, 'no code text left behind');
ok(!left.video, 'camera stream released');

// ---- 2) The tablet reported the failure, so the operator sees it in the logs ----
await admin.waitForTimeout(500);
const logged = await admin.evaluate(async () => (await fetch('/api/admin/logs?limit=50', { credentials: 'same-origin' })).json());
ok((logged.entries || []).some(e => /камер/i.test(e.message || '')), 'camera failure reached the operator log');

// ---- 3) Scanning while a document is open must restore the document afterwards ----
const doc = {
  title: 'Документ', signPrompt: 'Подпись', thankYouText: 'Спасибо', idleReturnSec: 0,
  pages: [{ headingRuns: [{ text: 'Страница' }], blocks: [{ runs: [{ text: 'Текст документа' }] }], checkboxes: [] }]
};
await admin.evaluate(async (d) => { await fetch('/api/admin/document', { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(d) }); }, doc);
const withCam = await enrolTablet('WithDoc', { permissions: ['camera'] });
await admin.evaluate(async (t) => {
  await fetch('/api/admin/show-document', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target: t, fields: {} }) });
}, 'device:' + withCam.id);
await withCam.page.waitForSelector('#document:not(.hidden)', { timeout: 6000 });
ok(true, 'document shown on the tablet');

await startScan(withCam.id);
await withCam.page.waitForSelector('#scan:not(.hidden)', { timeout: 6000 });
ok(true, 'scan screen opened over the document');
await admin.evaluate(async (t) => {
  await fetch('/api/admin/scan/stop', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target: t }) });
}, 'device:' + withCam.id);
await withCam.page.waitForFunction(() => !document.getElementById('document').classList.contains('hidden'), null, { timeout: 8000 });
const back = await withCam.page.evaluate(() => ({
  doc: !document.getElementById('document').classList.contains('hidden'),
  scanHidden: document.getElementById('scan').classList.contains('hidden'),
  text: (document.getElementById('docBody') || {}).textContent
}));
ok(back.doc && back.scanHidden, 'tablet returned to the document after the scan was cancelled');
ok(/Текст документа/.test(back.text || ''), 'the document content is intact after scanning');

ok(denied.errs.length === 0 && withCam.errs.length === 0,
  'no kiosk JS errors (' + JSON.stringify(denied.errs.concat(withCam.errs)) + ')');

await browser.close();
console.log(fail === 0 ? '\nDEAD-END CHECKS PASSED' : `\n${fail} CHECK(S) FAILED`);
process.exit(fail === 0 ? 0 : 1);
