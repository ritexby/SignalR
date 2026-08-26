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
admin.on('pageerror', e => console.error('ADMIN JS ERROR:', e.message));
await admin.goto(BASE + '/admin/');
await admin.fill('#password', 'test123');
await admin.click('#loginForm button[type=submit]');
await admin.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
ok(true, 'admin logged in');

const aFetch = (path, opts) => admin.evaluate(async ([p, o]) => {
  const r = await fetch('/api/admin' + p, Object.assign({ credentials: 'same-origin' }, o || {}));
  const t = await r.text(); try { return JSON.parse(t); } catch { return t; }
}, [path, opts]);
const aPost = (p, body) => aFetch(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
const aPut = (p, body) => aFetch(p, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });

// workstation + enrollment bound to it
const ws = await aPost('/workstations', { externalId: 'WS-204', name: 'Ресепшн 1', location: 'Холл' });
const enr = await aPost('/devices/enroll', { name: 'Планшет', workstationId: ws.id, ttlMinutes: 30 });
const tok = await admin.evaluate(async (code) =>
  (await fetch('/api/kiosk/enroll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) })).json(), enr.code);

// template with placeholders + dynamic anchor; idle off for the signing part
const doc = {
  title: 'Согласие {{ФИО}}', signPrompt: 'Поставьте подпись', thankYouText: 'Спасибо', idleReturnSec: 0,
  pages: [{
    heading: 'Ваши данные', body: 'ФИО: {{ФИО}}\nАдрес регистрации: {{Адрес регистрации}}',
    checkboxes: [{ label: 'Подтверждаю корректность данных', required: true, checked: false }], includeDynamic: true
  }]
};
await aPut('/document', doc);
// Список используемых тегов приходит вместе с предпросмотром: отдельного маршрута нет,
// он был мёртвым (ни один клиент его не вызывал).
ok(((await aPost('/document/preview', { fields: {} })).placeholders || []).join(',').includes('ФИО'),
  'предпросмотр перечисляет используемые теги, среди них ФИО');
const key = (await aPost('/apikeys', { label: 'ERP' })).key;

// connect kiosk (assigned to WS-204)
const kioskCtx = await browser.newContext({ viewport: { width: 900, height: 1400 } });
const kiosk = await kioskCtx.newPage();
kiosk.on('pageerror', e => console.error('KIOSK JS ERROR:', e.message));
await kiosk.goto(BASE + '/');
await kiosk.evaluate(t => localStorage.setItem('sk_device_token', t), tok.token);
await kiosk.reload();
await kiosk.waitForSelector('#slideshow:not(.hidden)', { timeout: 8000 }).catch(() => {});
await admin.waitForTimeout(1200);

const anon = await browser.newContext();
const extPost = (path, body) => anon.request.post(BASE + path, { headers: { 'X-Api-Key': key, 'Content-Type': 'application/json' }, data: JSON.stringify(body) });

// ---- ext show-document with fields + a dynamic checkbox ----
const showResp = await extPost('/api/ext/show-document', {
  workstationExternalId: 'WS-204',
  fields: { 'ФИО': 'Иванов Иван Иванович', 'Адрес регистрации': 'г. Минск, ул. Ленина 1' },
  checkboxes: [{ label: 'Согласен на рассылку', checked: false, required: false }]
});
const showJson = await showResp.json();
ok(showResp.status() === 200 && showJson.ok, 'ext show-document ok (by workstationExternalId)');
await kiosk.waitForSelector('#document:not(.hidden)', { timeout: 6000 });
await kiosk.waitForTimeout(400);
const bodyText = await kiosk.textContent('#document');
ok(bodyText.includes('Иванов Иван Иванович'), 'ФИО substituted on the tablet');
ok(bodyText.includes('г. Минск, ул. Ленина 1'), 'Адрес substituted');
ok(bodyText.indexOf('{{') < 0, 'no raw {{placeholders}} left on the tablet');
ok(bodyText.includes('Согласен на рассылку'), 'dynamic checkbox injected from API');
ok((await kiosk.textContent('#docTitle')).includes('Иванов'), 'title placeholder substituted');

// ---- drive signing ----
let signed = false;
for (let step = 0; step < 12; step++) {
  if (await kiosk.$('#btnSign')) {
    const box = await kiosk.locator('#document canvas').boundingBox();
    await kiosk.mouse.move(box.x + 40, box.y + 40); await kiosk.mouse.down();
    await kiosk.mouse.move(box.x + 160, box.y + 90, { steps: 6 });
    await kiosk.mouse.move(box.x + 240, box.y + 50, { steps: 6 }); await kiosk.mouse.up();
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
await admin.waitForTimeout(400);

// ---- record + PDF carry the signer data ----
const sigs = await aFetch('/signatures');
const sig = await aFetch('/signatures/' + sigs[0].id);
ok(sig.fields && sig.fields['ФИО'] === 'Иванов Иван Иванович', 'signature record stores signer fields');
ok((sig.items || []).some(i => i.label === 'Согласен на рассылку'), 'dynamic checkbox captured in the record');
const pdf = await adminCtx.request.get(BASE + '/api/admin/signatures/' + sigs[0].id + '/pdf');
ok(pdf.status() === 200 && (await pdf.body()).slice(0, 4).toString('latin1') === '%PDF', 'PDF generated');

// ---- PRIVACY 1: reconnect right after signing shows ads, not the signed document ----
const kiosk2 = await kioskCtx.newPage();
await kiosk2.goto(BASE + '/');
await kiosk2.waitForTimeout(1200);
ok(await kiosk2.evaluate(() => document.getElementById('document').classList.contains('hidden')),
  'PRIVACY: reconnect after signing shows ads (signer data not redisplayed)');
await kiosk2.close();

// ---- PRIVACY 2: re-show without fields carries no stale data ----
const dev = (await aFetch('/devices'))[0];
await extPost('/api/ext/show-document', { deviceId: dev.id });
await kiosk.waitForSelector('#document:not(.hidden)', { timeout: 6000 });
await kiosk.waitForTimeout(400);
const body2 = await kiosk.textContent('#document');
ok(body2.indexOf('Иванов') < 0, 'PRIVACY: no stale signer data on a fresh show without fields');

// ---- ext return-slides clears + returns to ads ----
await extPost('/api/ext/return-slides', { deviceId: dev.id });
await kiosk.waitForSelector('#slideshow:not(.hidden)', { timeout: 6000 });
ok(true, 'ext return-slides returns the tablet to ads');

// ---- idle timeout: short idle, no interaction -> back to ads ----
await aPut('/document', Object.assign({}, doc, { idleReturnSec: 2 }));
await extPost('/api/ext/show-document', { deviceId: dev.id, fields: { 'ФИО': 'Тест Тестов', 'Адрес регистрации': 'X' } });
await kiosk.waitForSelector('#document:not(.hidden)', { timeout: 6000 });
await kiosk.waitForTimeout(3600); // idle 2s + margin, no interaction
ok(await kiosk.evaluate(() => !document.getElementById('slideshow').classList.contains('hidden')),
  'idle timeout returned the tablet to ads');

await browser.close();
console.log(fail === 0 ? '\nTEMPLATE + PRIVACY E2E PASSED' : `\n${fail} TEMPLATE CHECK(S) FAILED`);
process.exit(fail === 0 ? 0 : 1);
