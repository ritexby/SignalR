import { chromium } from 'playwright';
import { readFileSync, readdirSync } from 'fs';
const BASE = 'http://127.0.0.1:5080';
// Путь к браузеру берётся из окружения: на другой машине он другой, а зашитый путь
// превращал набор в неработающий у всех, кроме одной установки. Пусто значит
// «пусть Playwright возьмёт свой», как он и делает по умолчанию.
const EXE = process.env.SK_CHROME || undefined;
const SIGDIR = '' + (process.env.SK_RABOTA || '.') + '/data_v3/signatures';
let fail = 0;
const ok = (c, m) => { if (c) console.log('PASS', m); else { console.error('FAIL', m); fail++; } };

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const admin = await (await browser.newContext()).newPage();
admin.on('pageerror', e => console.error('ADMIN JS ERROR:', e.message));
await admin.goto(BASE + '/admin/');
await admin.fill('#password', 'test123');
await admin.click('#loginForm button[type=submit]');
await admin.waitForSelector('#app:not(.hidden)', { timeout: 8000 });

const ws = await admin.evaluate(async () => (await fetch('/api/admin/workstations', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ externalId: 'WS-COND', name: 'Cond', location: '' }) })).json());
const enr = await admin.evaluate(async (wsId) => (await fetch('/api/admin/devices/enroll', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Планшет', workstationId: wsId, ttlMinutes: 30 }) })).json(), ws.id);
const tok = await admin.evaluate(async (code) => (await fetch('/api/kiosk/enroll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) })).json(), enr.code);
const key = await admin.evaluate(async () => (await (await fetch('/api/admin/apikeys', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label: 'k' }) })).json()).key);

// Rich document with conditions
const doc = {
  title: 'Согласие {{ФИО}}', signPrompt: 'Подпись', thankYouText: 'Спасибо', idleReturnSec: 0,
  pages: [
    {
      headingRuns: [{ text: 'Согласие ' }, { text: 'оформление', italic: true, color: '#dc2626', size: 'l' }],
      blocks: [
        { runs: [{ text: 'ФИО: ' }, { text: '{{ФИО}}', bold: true }] },
        { runs: [{ text: 'Блок только для женщин' }], visibleWhen: { field: 'Пол', op: 'eq', value: 'F' } },
        { runs: [{ text: 'Блок только для мужчин' }], visibleWhen: { field: 'Пол', op: 'eq', value: 'M' } }
      ],
      checkboxes: [{ label: 'Согласен', required: true, checked: false }], includeDynamic: false
    },
    {
      headingRuns: [{ text: 'Трансграничная передача' }],
      blocks: [{ runs: [{ text: 'Согласие на трансграничную передачу' }] }],
      visibleWhen: { field: 'cross-border', op: 'eq', value: 'true' }
    }
  ]
};
const putStatus = await admin.evaluate(async (d) => (await fetch('/api/admin/document', { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(d) })).status, doc);
ok(putStatus === 200, 'rich document with conditions saved');

// connect kiosk
const kioskCtx = await browser.newContext({ viewport: { width: 900, height: 1400 } });
const kiosk = await kioskCtx.newPage();
kiosk.on('pageerror', e => console.error('KIOSK JS ERROR:', e.message));
await kiosk.goto(BASE + '/');
await kiosk.evaluate(t => localStorage.setItem('sk_device_token', t), tok.token);
await kiosk.reload();
await kiosk.waitForSelector('#slideshow:not(.hidden)', { timeout: 8000 }).catch(() => {});
await admin.waitForTimeout(800);

// show document to a FEMALE signer, cross-border = нет
const anon = await browser.newContext();
const resp = await anon.request.post(BASE + '/api/ext/show-document', { headers: { 'X-Api-Key': key, 'Content-Type': 'application/json' }, data: JSON.stringify({ workstationExternalId: 'WS-COND', fields: { 'ФИО': 'Иванова Анна', 'Пол': 'F', 'cross-border': 'false' } }) });
ok(resp.status() === 200, 'ext show-document ok');
await kiosk.waitForSelector('#document:not(.hidden)', { timeout: 6000 });
await kiosk.waitForTimeout(400);

const bodyText = await kiosk.textContent('#document');
ok(bodyText.includes('Иванова Анна'), 'ФИО substituted');
ok(bodyText.includes('Блок только для женщин'), 'F-block shown for Пол=F');
ok(bodyText.indexOf('Блок только для мужчин') < 0, 'M-block hidden for Пол=F');
ok(bodyText.indexOf('Трансграничная передача') < 0, 'cross-border page hidden when cross-border=false');
ok(bodyText.indexOf('{{') < 0, 'no raw placeholders left');

// rich styling on the tablet
const styled = await kiosk.evaluate(() => {
  const spans = Array.from(document.querySelectorAll('#document h2 span'));
  const it = spans.find(s => s.textContent.trim() === 'оформление');
  const cs = it ? getComputedStyle(it) : null;
  const fio = Array.from(document.querySelectorAll('#document .doc-text span')).find(s => s.textContent.trim() === 'Иванова Анна');
  const fcs = fio ? getComputedStyle(fio) : null;
  return { color: cs && cs.color, style: cs && cs.fontStyle, size: cs && cs.fontSize, fioWeight: fcs && fcs.fontWeight };
});
ok(styled.color === 'rgb(220, 38, 38)', 'heading run is red: ' + styled.color);
ok(styled.style === 'italic', 'heading run is italic');
ok(parseInt(styled.fioWeight, 10) >= 700, 'substituted ФИО is bold: ' + styled.fioWeight);

// drive signing
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

// PDF generated + resolved document persisted with conditions applied
const sigs = await admin.evaluate(async () => (await fetch('/api/admin/signatures', { credentials: 'same-origin' })).json());
const pdf = await admin.request.get(BASE + '/api/admin/signatures/' + sigs[0].id + '/pdf');
ok(pdf.status() === 200 && (await pdf.body()).slice(0, 4).toString('latin1') === '%PDF', 'PDF generated');

// read the stored resolved document.json for this signature
const dir = readdirSync(SIGDIR).sort().reverse()[0];
const stored = JSON.parse(readFileSync(SIGDIR + '/' + dir + '/document.json', 'utf8'));
const allText = JSON.stringify(stored);
ok(stored.pages.length === 1, 'resolved doc has 1 page (cross-border page removed): ' + stored.pages.length);
ok(allText.includes('Иванова Анна'), 'resolved doc has substituted ФИО');
ok(allText.includes('Блок только для женщин'), 'resolved doc keeps F-block');
ok(allText.indexOf('Блок только для мужчин') < 0, 'resolved doc dropped M-block');

await browser.close();
console.log(fail === 0 ? '\nV4.2 CONDITIONS + RICH E2E PASSED' : `\n${fail} CHECK(S) FAILED`);
process.exit(fail === 0 ? 0 : 1);
