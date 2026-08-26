import { chromium } from 'playwright';
const BASE = 'http://127.0.0.1:5080';
// Путь к браузеру берётся из окружения: на другой машине он другой, а зашитый путь
// превращал набор в неработающий у всех, кроме одной установки. Пусто значит
// «пусть Playwright возьмёт свой», как он и делает по умолчанию.
const EXE = process.env.SK_CHROME || undefined;
const OUT = '' + (process.env.SK_RABOTA || '.') + '/audit/';

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const adminCtx = await browser.newContext({ viewport: { width: 1280, height: 1100 } });
const admin = await adminCtx.newPage();
await admin.goto(BASE + '/admin/');
await admin.fill('#password', 'test123');
await admin.click('#loginForm button[type=submit]');
await admin.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
const aFetch = (path, opts) => admin.evaluate(async ([p, o]) => {
  const r = await fetch('/api/admin' + p, Object.assign({ credentials: 'same-origin' }, o || {}));
  const t = await r.text(); try { return JSON.parse(t); } catch { return t; }
}, [path, opts]);
const aPost = (p, b) => aFetch(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) });
const aPut = (p, b) => aFetch(p, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) });

const ws = await aPost('/workstations', { externalId: 'WS-204', name: 'Ресепшн 1', location: 'Главный холл' });
const enr = await aPost('/devices/enroll', { name: 'Планшет Ресепшн', workstationId: ws.id, ttlMinutes: 30 });
const tok = await admin.evaluate(async (code) => (await fetch('/api/kiosk/enroll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) })).json(), enr.code);
const doc = {
  title: 'Согласие на обработку персональных данных', signPrompt: 'Пожалуйста, поставьте подпись', thankYouText: 'Спасибо! Ваша подпись принята.', idleReturnSec: 180,
  pages: [{
    heading: 'Данные подписанта',
    body: 'Я, {{ФИО}}, дата рождения {{ДР}},\nзарегистрирован(а) по адресу: {{Адрес регистрации}}.\n\nПодтверждаю согласие на обработку персональных данных.',
    checkboxes: [{ label: 'Подтверждаю корректность моих данных', required: true, checked: false }], includeDynamic: true
  }]
};
await aPut('/document', doc);
const key = (await aPost('/apikeys', { label: 'ERP' })).key;

// document editor screenshot (placeholders detected)
await admin.click('.tab[data-tab="document"]');
await admin.waitForSelector('[data-panel="document"]:not(.hidden)', { timeout: 4000 });
await admin.waitForTimeout(400);
await admin.screenshot({ path: OUT + 'admin_doc_editor.png' });

// connect kiosk + show document via ext with fields
const kioskCtx = await browser.newContext({ viewport: { width: 900, height: 1350 } });
const kiosk = await kioskCtx.newPage();
await kiosk.goto(BASE + '/');
await kiosk.evaluate(t => localStorage.setItem('sk_device_token', t), tok.token);
await kiosk.reload();
await kiosk.waitForSelector('#slideshow:not(.hidden)', { timeout: 8000 }).catch(() => {});
await admin.waitForTimeout(1000);
const anon = await browser.newContext();
await anon.request.post(BASE + '/api/ext/show-document', { headers: { 'X-Api-Key': key, 'Content-Type': 'application/json' }, data: JSON.stringify({
  workstationExternalId: 'WS-204',
  fields: { 'ФИО': 'Иванов Иван Иванович', 'ДР': '01.01.1990', 'Адрес регистрации': 'г. Минск, ул. Ленина, д. 1, кв. 5' },
  checkboxes: [{ label: 'Согласен получать информационную рассылку', checked: false, required: false }]
}) });
await kiosk.waitForSelector('#document:not(.hidden)', { timeout: 6000 });
await kiosk.waitForTimeout(500);
await kiosk.screenshot({ path: OUT + 'kiosk_resolved_doc.png' });

// sign, then show admin signature modal with fields
for (let step = 0; step < 12; step++) {
  if (await kiosk.$('#btnSign')) {
    const box = await kiosk.locator('#document canvas').boundingBox();
    await kiosk.mouse.move(box.x + 60, box.y + 50); await kiosk.mouse.down();
    await kiosk.mouse.move(box.x + 200, box.y + 120, { steps: 8 });
    await kiosk.mouse.move(box.x + 320, box.y + 60, { steps: 8 }); await kiosk.mouse.up();
    await kiosk.waitForSelector('#btnSign:not([disabled])', { timeout: 3000 });
    await kiosk.click('#btnSign'); break;
  } else if (await kiosk.$('#btnNext')) {
    for (const b of await kiosk.$$('#document .check input')) if (!(await b.isChecked())) await b.click();
    await kiosk.waitForSelector('#btnNext:not([disabled])', { timeout: 3000 });
    await kiosk.click('#btnNext'); await kiosk.waitForTimeout(120);
  } else break;
}
await admin.waitForTimeout(700);
await admin.click('.tab[data-tab="signatures"]');
await admin.waitForTimeout(500);
if (await admin.$('#signaturesList .sig-item')) {
  await admin.click('#signaturesList .sig-item');
  await admin.waitForSelector('#modal:not(.hidden)', { timeout: 4000 });
  await admin.waitForTimeout(300);
  await admin.screenshot({ path: OUT + 'admin_sig_with_fields.png' });
}
await browser.close();
console.log('done');
