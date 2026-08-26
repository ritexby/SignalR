// Подпись и сканирование как элементы страницы. Документ может требовать несколько подписей,
// а код с пробирки попадает в запись, но не в подписанный PDF.
import { chromium } from 'playwright';
const BASE = 'http://127.0.0.1:5080';
// Путь к браузеру берётся из окружения: на другой машине он другой, а зашитый путь
// превращал набор в неработающий у всех, кроме одной установки. Пусто значит
// «пусть Playwright возьмёт свой», как он и делает по умолчанию.
const EXE = process.env.SK_CHROME || undefined;
const SP = '' + (process.env.SK_RABOTA || '.') + '';
let fail = 0;
const ok = (c, m) => { if (c) console.log('PASS', m); else { console.error('FAIL', m); fail++; } };

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const admin = await (await browser.newContext()).newPage();
await admin.goto(BASE + '/admin/');
await admin.fill('#password', 'test123'); await admin.click('#loginForm button[type=submit]');
await admin.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
const call = (path, opts) => admin.evaluate(async ([pa, o]) => {
  const r = await fetch('/api/admin' + pa, Object.assign({ credentials: 'same-origin' }, o || {}));
  let b = null; try { b = await r.json(); } catch {} return { status: r.status, body: b };
}, [path, opts]);

await call('/document', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
  title: 'Согласие', signPrompt: 'Итоговая подпись', thankYouText: 'Спасибо', idleReturnSec: 0,
  pages: [{
    headingRuns: [{ text: 'Согласия' }],
    blocks: [{ runs: [{ text: 'АБЗАЦ-ПЕРЕД-ПОДПИСЬЮ' }], ord: 0 }],
    checkboxes: [], groups: [],
    signatures: [{ key: 'patient', label: 'Подпись пациента', required: true, ord: 1 },
                 { key: 'guardian', label: 'Подпись законного представителя', required: false, ord: 3 }],
    scans: [{ key: 'tube', label: 'Отсканируйте штрихкод пробирки', required: true, ord: 2 }]
  }],
  signBlocks: [], signBlocksBelow: [] }) });

// Сервер сохранил новые элементы и расставил сквозные номера.
const doc = (await call('/document')).body;
const page = doc.pages[0];
ok((page.signatures || []).length === 2, 'два поля подписи сохранены');
ok((page.scans || []).length === 1, 'поле сканирования сохранено');
const ords = [page.blocks[0].ord, page.signatures[0].ord, page.scans[0].ord, page.signatures[1].ord];
ok(JSON.stringify(ords) === '[0,1,2,3]', 'порядок сквозной: ' + JSON.stringify(ords));

const code = (await call('/devices/enroll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"name":"Планшет"}' })).body.code;
const kiosk = await (await browser.newContext({ viewport: { width: 800, height: 1400 } })).newPage();
await kiosk.goto(BASE + '/?enroll=' + encodeURIComponent(code));
await kiosk.waitForFunction(() => !!localStorage.getItem('sk_device_token'), { timeout: 12000 });
let id = null;
for (let i = 0; i < 40; i++) {
  const d = (await call('/devices')).body || []; const on = d.find(x => x.online);
  if (on) { id = on.id; break; }
  await kiosk.waitForTimeout(250);
}
await call('/show-document', { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ target: 'device:' + id, fields: {} }) });
await kiosk.waitForSelector('.page-sign', { timeout: 8000 });

ok(await kiosk.locator('.page-sign').count() === 2, 'на планшете два поля подписи');
ok(await kiosk.locator('.page-scan').count() === 1, 'и одно поле сканирования');
const порядок = await kiosk.evaluate(() => Array.from(document.querySelectorAll('.doc-body > div > *'))
  .map(n => (n.className || '').toString().split(' ')[0]));
ok(порядок.indexOf('page-sign') < порядок.indexOf('page-scan'), 'порядок как в документе: ' + JSON.stringify(порядок));

// Пока не расписался и не отсканировал, дальше не пускает и показывает, чего не хватает.
await kiosk.locator('#btnNext').click();
await kiosk.waitForTimeout(500);
ok(await kiosk.locator('.page-sign.miss').count() === 1, 'подсвечено обязательное поле подписи');
ok(await kiosk.locator('.page-scan.miss').count() === 1, 'и поле сканирования');
const подписи = await kiosk.locator('.miss-note').allTextContents();
ok(подписи.some(t => /расписаться/.test(t)) && подписи.some(t => /отсканировать/.test(t)),
  'у каждого своя подпись: ' + JSON.stringify(подписи));
ok(await kiosk.locator('.page-sign').nth(1).evaluate(e => !e.classList.contains('miss')),
  'необязательная подпись не подсвечена');
await kiosk.screenshot({ path: SP + '/v54_pagesign.png', fullPage: false });

// Расписываемся в первом поле.
const box = await kiosk.locator('.page-sign .sign-wrap').first().boundingBox();
await kiosk.mouse.move(box.x + 30, box.y + box.height / 2);
await kiosk.mouse.down();
await kiosk.mouse.move(box.x + box.width - 40, box.y + box.height / 2 - 25, { steps: 12 });
await kiosk.mouse.up();
await kiosk.waitForTimeout(400);
ok(await kiosk.locator('.page-sign.miss').count() === 0, 'подсветка с поля подписи снялась сразу');

// Код подставляем напрямую: камеры в проверке нет, а проверяется путь данных.
await kiosk.evaluate(() => {
  const btn = document.querySelector('.page-scan-btn');
  btn.click();
});
await kiosk.waitForTimeout(600);
await kiosk.evaluate(() => {
  // Имитируем считанный код так же, как это сделала бы камера.
  window.__sk_test_scan('9876543210987', 'EAN_13');
});
await kiosk.waitForTimeout(1400);
ok(await kiosk.locator('.page-scan.scanned').count() === 1, 'код принят полем сканирования');
ok(/9876543210987/.test(await kiosk.locator('.page-scan-value').textContent()), 'и показан клиенту');

// Проходим до подписи и подписываем.
await kiosk.evaluate(() => { const b = document.getElementById('btnNext'); if (b) b.click(); });
await kiosk.waitForSelector('.sign-screen canvas', { timeout: 8000 });
const fbox = await kiosk.locator('.sign-screen .sign-wrap').boundingBox();
await kiosk.mouse.move(fbox.x + 30, fbox.y + fbox.height / 2);
await kiosk.mouse.down();
await kiosk.mouse.move(fbox.x + fbox.width - 40, fbox.y + fbox.height / 2 - 20, { steps: 10 });
await kiosk.mouse.up();
await kiosk.waitForTimeout(300);
await kiosk.evaluate(() => { const b = document.getElementById('btnSign'); if (b) b.click(); });
await kiosk.waitForTimeout(2500);

const sigs = (await call('/signatures')).body || [];
ok(sigs.length === 1, 'запись создана');
const rec = (await call('/signatures/' + sigs[0].id)).body;
ok((rec.signatures || []).length === 1, 'подпись со страницы сохранена: ' + JSON.stringify((rec.signatures || []).map(x => x.key)));
ok(rec.signatures[0].key === 'patient' && /signature-patient\.png/.test(rec.signatures[0].file),
  'у неё своё имя и свой файл: ' + JSON.stringify(rec.signatures[0]));
ok((rec.scans || []).length === 1 && rec.scans[0].code === '9876543210987',
  'код попал в запись: ' + JSON.stringify(rec.scans));

// Картинка подписи со страницы отдаётся отдельно.
const img = await admin.evaluate(async ([sid, file]) => {
  const r = await fetch('/api/admin/signatures/' + sid + '/image/' + file, { credentials: 'same-origin' });
  return { status: r.status, size: (await r.arrayBuffer()).byteLength };
}, [sigs[0].id, rec.signatures[0].file]);
ok(img.status === 200 && img.size > 100, 'картинка подписи со страницы отдаётся: ' + JSON.stringify(img));

// PDF: подпись на своём месте, кода в нём нет.
const bytes = await admin.evaluate(async (sid) => {
  const r = await fetch('/api/admin/signatures/' + sid + '/pdf', { credentials: 'same-origin' });
  return Array.from(new Uint8Array(await r.arrayBuffer()));
}, sigs[0].id);
const fs = await import('fs');
fs.writeFileSync(SP + '/pagesign.pdf', Buffer.from(bytes));
const { execSync } = await import('child_process');
const текст = execSync('pdftotext -layout ' + SP + '/pagesign.pdf -').toString();
ok(/Подпись пациента/.test(текст), 'в PDF есть надпись поля подписи');
ok(текст.indexOf('Подпись пациента') > текст.indexOf('АБЗАЦ-ПЕРЕД-ПОДПИСЬЮ'),
  'и стоит после своего абзаца, а не в конце');
ok(!/9876543210987/.test(текст), 'кода в PDF нет: это служебные данные, а не то, что подписывают');
ok(!/Подпись законного представителя/.test(текст) || /не поставлена/.test(текст),
  'незаполненное поле подписи не выдаётся за поставленную подпись');

await browser.close();
console.log(fail === 0 ? '\nВСЁ ПРОЙДЕНО' : '\n' + fail + ' ПРОВЕРОК УПАЛО');
process.exit(fail === 0 ? 0 : 1);
