import { chromium } from 'playwright';
import { readFileSync } from 'fs';
const BASE = 'http://127.0.0.1:5080';
// Путь к браузеру берётся из окружения: на другой машине он другой, а зашитый путь
// превращал набор в неработающий у всех, кроме одной установки. Пусто значит
// «пусть Playwright возьмёт свой», как он и делает по умолчанию.
const EXE = process.env.SK_CHROME || undefined;
const SP = '' + (process.env.SK_RABOTA || '.') + '';
// A real 24-bit screenshot PNG (PDFsharp-decodable), unlike a 1-bit test pixel.
const IMG_BYTES = readFileSync(SP + '/shot_dev_edit.png');
let fail = 0;
const ok = (c, m) => { if (c) console.log('PASS', m); else { console.error('FAIL', m); fail++; } };

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const admin = await (await browser.newContext()).newPage();
admin.on('pageerror', e => console.error('ADMIN JS ERROR:', e.message));
await admin.goto(BASE + '/admin/');
await admin.fill('#password', 'test123'); await admin.click('#loginForm button[type=submit]');
await admin.waitForSelector('#app:not(.hidden)', { timeout: 8000 });

const ws = await admin.evaluate(async () => (await fetch('/api/admin/workstations', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ externalId: 'WS-MEDIA', name: 'Media', location: '' }) })).json());
const enr = await admin.evaluate(async (wsId) => (await fetch('/api/admin/devices/enroll', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Планшет', workstationId: wsId, ttlMinutes: 30 }) })).json(), ws.id);
const tok = await admin.evaluate(async (code) => (await fetch('/api/kiosk/enroll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) })).json(), enr.code);
const key = await admin.evaluate(async () => (await (await fetch('/api/admin/apikeys', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label: 'k' }) })).json()).key);

// upload an image
const up = await admin.request.post(BASE + '/api/admin/images', { multipart: { file: { name: 'seal.png', mimeType: 'image/png', buffer: IMG_BYTES } } });
ok(up.status() === 200, 'image uploaded');
const upJson = await up.json();
// Ответ загрузки: список принятых и список отклонённых с причиной. Прежние виды ответа
// разобраны тоже, чтобы набор не зависел от того, на какой сборке он запущен.
const принято = upJson.added || (Array.isArray(upJson) ? upJson : [upJson]);
const mediaUrl = (принято[0] || {}).url;
console.log('media url:', mediaUrl);
ok(/^\/media\/[^/]+$/.test(mediaUrl || ''), 'upload returned a valid media url: ' + mediaUrl);

// document: a page with an image block + a text block; sign page with text + image
const doc = {
  title: 'Договор', signPrompt: 'Подпись', thankYouText: 'Спасибо', idleReturnSec: 0,
  pages: [{
    headingRuns: [{ text: 'Страница с картинкой' }],
    blocks: [
      { runs: [{ text: 'Текстовый блок' }] },
      { imageUrl: mediaUrl, imageWidth: 60 }
    ], checkboxes: []
  }],
  signBlocks: [
    { runs: [{ text: 'Реквизиты компании', bold: true }] },
    { imageUrl: mediaUrl, imageWidth: 40 }
  ]
};
const putStatus = await admin.evaluate(async (d) => (await fetch('/api/admin/document', { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(d) })).status, doc);
ok(putStatus === 200, 'document with image block + sign blocks saved');

// verify sanitize kept the image url + width
const savedDoc = await admin.evaluate(async () => (await fetch('/api/admin/document', { credentials: 'same-origin' })).json());
const imgBlock = savedDoc.pages[0].blocks.find(b => b.imageUrl);
ok(imgBlock && imgBlock.imageUrl === mediaUrl && imgBlock.imageWidth === 60, 'image block persisted with width: ' + JSON.stringify(imgBlock && { u: imgBlock.imageUrl, w: imgBlock.imageWidth }));
ok((savedDoc.signBlocks || []).some(b => b.imageUrl === mediaUrl), 'sign blocks persisted with image');

// connect kiosk
const kioskCtx = await browser.newContext({ viewport: { width: 900, height: 1400 } });
const kiosk = await kioskCtx.newPage();
kiosk.on('pageerror', e => console.error('KIOSK JS ERROR:', e.message));
await kiosk.goto(BASE + '/');
await kiosk.evaluate(t => localStorage.setItem('sk_device_token', t), tok.token);
await kiosk.reload();
await kiosk.waitForSelector('#slideshow:not(.hidden)', { timeout: 8000 }).catch(() => {});
await admin.waitForTimeout(800);

const anon = await browser.newContext();
const resp = await anon.request.post(BASE + '/api/ext/show-document', { headers: { 'X-Api-Key': key, 'Content-Type': 'application/json' }, data: JSON.stringify({ workstationExternalId: 'WS-MEDIA', fields: {} }) });
ok(resp.status() === 200, 'ext show-document ok');
await kiosk.waitForSelector('#document:not(.hidden)', { timeout: 6000 });
await kiosk.waitForTimeout(400);

// page image present
await kiosk.waitForTimeout(300);
const pageImg = await kiosk.evaluate(() => {
  const im = document.querySelector('#document .doc-image img');
  return im ? { src: im.getAttribute('src'), width: im.style.width, loaded: im.complete && im.naturalWidth > 0 } : null;
});
ok(pageImg && /^\/media\/[^/]+$/.test(pageImg.src), 'page renders the image block: ' + JSON.stringify(pageImg));
ok(pageImg && pageImg.width === '60%', 'page image width honoured (60%)');
ok(pageImg && pageImg.loaded, 'page image actually loads (naturalWidth>0)');

// navigate to signature screen, verify sign-custom content
let signed = false;
for (let step = 0; step < 10; step++) {
  if (await kiosk.$('#btnSign')) {
    const sc = await kiosk.evaluate(() => {
      const c = document.querySelector('#document .sign-custom');
      if (!c) return null;
      return { text: c.textContent, hasImg: !!c.querySelector('img') };
    });
    ok(sc && sc.text.includes('Реквизиты компании'), 'sign page shows custom text');
    ok(sc && sc.hasImg, 'sign page shows custom image');
    const box = await kiosk.locator('#document canvas').boundingBox();
    await kiosk.mouse.move(box.x + 40, box.y + 40); await kiosk.mouse.down();
    await kiosk.mouse.move(box.x + 180, box.y + 80, { steps: 6 }); await kiosk.mouse.up();
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

const sigs = await admin.evaluate(async () => (await fetch('/api/admin/signatures', { credentials: 'same-origin' })).json());
const pdf = await admin.request.get(BASE + '/api/admin/signatures/' + sigs[0].id + '/pdf');
const pdfBody = await pdf.body();
ok(pdf.status() === 200 && pdfBody.slice(0, 4).toString('latin1') === '%PDF', 'PDF generated with images');
ok(pdfBody.length > 45000, 'PDF embeds the image (grew to ' + pdfBody.length + ' bytes)');

await browser.close();
console.log(fail === 0 ? '\nV4.2 MEDIA + SIGN-PAGE E2E PASSED' : `\n${fail} CHECK(S) FAILED`);
process.exit(fail === 0 ? 0 : 1);
