// Длинное слово без пробелов: разделитель из звёздочек, длинная ссылка, номер документа.
// Оно не должно раздвигать страницу планшета, иначе она ездит пальцем вбок, а хвост строки со
// знаком препинания уходит за край и пропадает. То же в предпросмотре и в PDF.
import { chromium } from 'playwright';
const BASE = 'http://127.0.0.1:5080';
// Путь к браузеру берётся из окружения: на другой машине он другой, а зашитый путь
// превращал набор в неработающий у всех, кроме одной установки. Пусто значит
// «пусть Playwright возьмёт свой», как он и делает по умолчанию.
const EXE = process.env.SK_CHROME || undefined;
const SP = '' + (process.env.SK_RABOTA || '.') + '';
let fail = 0;
const ok = (c, m) => { if (c) console.log('PASS', m); else { console.error('FAIL', m); fail++; } };

const ЗВЁЗДЫ = '*'.repeat(120) + '?';
const ССЫЛКА = 'https://example-laboratory.by/very/long/path/that/never/breaks/anywhere/at/all/document-12345';

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
  title: 'Согласие', signPrompt: 'Распишитесь', thankYouText: 'Спасибо', idleReturnSec: 0,
  pages: [{ headingRuns: [{ text: 'Страница' }],
    blocks: [{ runs: [{ text: ЗВЁЗДЫ }], ord: 0 }, { runs: [{ text: 'Ссылка: ' + ССЫЛКА }], ord: 1 }],
    checkboxes: [{ key: 'c1', label: 'Согласен ' + ЗВЁЗДЫ, required: true, ord: 2 }], groups: [] }],
  signBlocks: [], signBlocksBelow: [] }) });

// Код активации одноразовый, поэтому планшет заводится один раз, а его токен переиспользуется
// для каждого размера экрана: это тот же планшет, просто повёрнутый или другой модели.
const code = (await call('/devices/enroll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"name":"Планшет"}' })).body.code;
const первый = await browser.newContext();
const первая = await первый.newPage();
await первая.goto(BASE + '/?enroll=' + encodeURIComponent(code));
await первая.waitForFunction(() => !!localStorage.getItem('sk_device_token'), { timeout: 12000 });
const token = await первая.evaluate(() => localStorage.getItem('sk_device_token'));
const id = token.split('.')[0];
await первый.close();

for (const [w, h, имя] of [[800, 1280, 'портрет 800'], [600, 1024, 'узкий 600'], [1280, 800, 'альбом 1280']]) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h } });
  const k = await ctx.newPage();
  await k.goto(BASE + '/');
  await k.evaluate(t => localStorage.setItem('sk_device_token', t), token);
  await k.reload();
  await k.waitForTimeout(1500);
  await call('/show-document', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ target: 'device:' + id, fields: {} }) });
  await k.waitForSelector('.doc-body', { timeout: 8000 });
  await k.waitForTimeout(300);
  const r = await k.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const body = document.querySelector('.doc-body');
    const шире = [];
    document.querySelectorAll('.doc-body *').forEach(el => {
      if (el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0)
        шире.push((el.className || el.tagName).toString().slice(0, 30) + ' ' + el.scrollWidth + '>' + el.clientWidth);
    });
    return { страница: document.documentElement.scrollWidth > vw,
      область: body.scrollWidth > body.clientWidth + 1, шире: шире.slice(0, 3) };
  });
  ok(!r.страница, имя + ': страница не ездит вбок');
  ok(!r.область, имя + ': область текста тоже: ' + JSON.stringify(r.шире));
  // Хвост строки со знаком вопроса должен остаться видимым.
  const видно = await k.evaluate(() => document.querySelector('.doc-body').textContent.indexOf('*?') >= 0);
  ok(видно, имя + ': знак в конце длинной строки на месте');
  await ctx.close();
}

// Предпросмотр в админке.
await admin.reload(); await admin.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
await admin.click('.tab[data-tab="document"]');
await admin.waitForTimeout(600);
await admin.click('#previewDoc');
await admin.waitForSelector('.preview-setup', { timeout: 5000 });
await admin.click('.preview-setup .btn-primary');
await admin.waitForSelector('.preview-wrap', { timeout: 6000 });
const пв = await admin.evaluate(() => {
  const b = document.querySelector('.pv-body');
  return { область: b.scrollWidth > b.clientWidth + 1, окно: document.documentElement.scrollWidth > document.documentElement.clientWidth };
});
ok(!пв.область && !пв.окно, 'в предпросмотре длинное слово тоже переносится: ' + JSON.stringify(пв));
await admin.keyboard.press('Escape');
await admin.waitForTimeout(300);

// PDF: хвост длинного слова не должен уезжать за поле страницы.
const ctx2 = await browser.newContext({ viewport: { width: 800, height: 1280 } });
const k2 = await ctx2.newPage();
const e2 = (await call('/devices/enroll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"name":"Подписной"}' })).body;
await k2.goto(BASE + '/?enroll=' + encodeURIComponent(e2.code));
await k2.waitForFunction(() => !!localStorage.getItem('sk_device_token'), { timeout: 12000 });
let id2 = null;
for (let i = 0; i < 40; i++) {
  const d = (await call('/devices')).body || []; const on = d.find(x => x.online && x.name === 'Подписной');
  if (on) { id2 = on.id; break; }
  await k2.waitForTimeout(250);
}
await call('/show-document', { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ target: 'device:' + id2, fields: {} }) });
await k2.waitForSelector('.check', { timeout: 8000 });
await k2.evaluate(() => { const i = document.querySelector('.checks .check input'); i.checked = true; i.dispatchEvent(new Event('change', { bubbles: true })); });
await k2.waitForTimeout(200);
await k2.evaluate(() => { const b = document.getElementById('btnNext'); if (b && !b.disabled) b.click(); });
await k2.waitForSelector('canvas', { timeout: 8000 });
const box = await k2.locator('.sign-wrap').boundingBox();
await k2.mouse.move(box.x + 30, box.y + box.height / 2);
await k2.mouse.down();
await k2.mouse.move(box.x + box.width - 40, box.y + box.height / 2 - 20, { steps: 10 });
await k2.mouse.up();
await k2.waitForTimeout(300);
await k2.evaluate(() => { const b = document.getElementById('btnSign'); if (b && !b.disabled) b.click(); });
await k2.waitForTimeout(2200);

const sigs = (await call('/signatures')).body || [];
ok(sigs.length === 1, 'подпись сохранена');
const bytes = await admin.evaluate(async (sid) => {
  const res = await fetch('/api/admin/signatures/' + sid + '/pdf', { credentials: 'same-origin' });
  return Array.from(new Uint8Array(await res.arrayBuffer()));
}, sigs[0].id);
const fs = await import('fs');
fs.writeFileSync(SP + '/longword.pdf', Buffer.from(bytes));
const { execSync } = await import('child_process');
const текст = execSync('pdftotext -layout ' + SP + '/longword.pdf -').toString();
const звёздВPdf = (текст.match(/\*/g) || []).length;
ok(звёздВPdf >= 240, 'в PDF все звёздочки на месте, ничего не срезано: ' + звёздВPdf);
ok(текст.indexOf('*?') >= 0 || /\*\s*\?/.test(текст), 'и знак вопроса в конце тоже');
// Длинное слово переносится по символам, поэтому в извлечённом тексте оно разорвано строкой.
// Склеиваем и проверяем, что не потеряно ни одного символа.
const склеено = текст.replace(/[\r\n]/g, '');
ok(склеено.indexOf(ССЫЛКА) >= 0, 'длинная ссылка в PDF целиком, включая хвост');

await browser.close();
console.log(fail === 0 ? '\nВСЁ ПРОЙДЕНО' : '\n' + fail + ' ПРОВЕРОК УПАЛО');
process.exit(fail === 0 ? 0 : 1);
