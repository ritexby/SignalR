// PDF после подписания: отметки и группы должны стоять там же, где их видел клиент, потому что
// пункт относится к абзацу над ним. Раньше все галочки собирались в конец документа.
import { chromium } from 'playwright';
const BASE = 'http://127.0.0.1:5080';
// Путь к браузеру берётся из окружения: на другой машине он другой, а зашитый путь
// превращал набор в неработающий у всех, кроме одной установки. Пусто значит
// «пусть Playwright возьмёт свой», как он и делает по умолчанию.
const EXE = process.env.SK_CHROME || undefined;
const SP = '' + (process.env.SK_RABOTA || '.') + '';
const PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
let fail = 0;
const ok = (c, m) => { if (c) console.log('PASS', m); else { console.error('FAIL', m); fail++; } };

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const ctx = await browser.newContext();
const admin = await ctx.newPage();
await admin.goto(BASE + '/admin/');
await admin.fill('#password', 'test123'); await admin.click('#loginForm button[type=submit]');
await admin.waitForSelector('#app:not(.hidden)', { timeout: 8000 });

const call = (path, opts) => admin.evaluate(async ([pa, o]) => {
  const r = await fetch('/api/admin' + pa, Object.assign({ credentials: 'same-origin' }, o || {}));
  let body = null; try { body = await r.json(); } catch { body = null; }
  return { status: r.status, body };
}, [path, opts]);
const put = (path, obj) => call(path, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });
const post = (path, obj) => call(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });

// Документ: текст, пункт, текст, пункт, выбор одного варианта - именно в таком порядке.
await put('/document', {
  title: 'Согласие', signPrompt: 'Распишитесь', thankYouText: 'Спасибо', idleReturnSec: 0,
  pages: [{
    headingRuns: [{ text: 'Единственная страница' }],
    blocks: [{ runs: [{ text: 'АБЗАЦ-ПЕРВЫЙ' }], ord: 0 }, { runs: [{ text: 'АБЗАЦ-ВТОРОЙ' }], ord: 2 }],
    checkboxes: [{ key: 'c1', label: 'ПУНКТ-ПОД-ПЕРВЫМ', required: true, ord: 1 },
                 { key: 'c2', label: 'ПУНКТ-ПОД-ВТОРЫМ', required: true, ord: 3 }],
    groups: [{ key: 'g1', title: 'ВЫБОР-В-КОНЦЕ', required: false, ord: 4,
      options: [{ key: 'yes', label: 'Разрешаю' }, { key: 'no', label: 'Запрещаю' }] }]
  }],
  signBlocks: [], signBlocksBelow: []
});

// Привязываем планшет и открываем киоск.
const code = (await post('/devices/enroll', { name: 'PDF-планшет' })).body.code;
const kiosk = await (await browser.newContext()).newPage();
await kiosk.goto(BASE + '/?enroll=' + encodeURIComponent(code));
await kiosk.waitForFunction(() => !!localStorage.getItem('sk_device_token'), { timeout: 12000 });
let deviceId = null;
for (let i = 0; i < 40; i++) {
  const d = (await call('/devices')).body || [];
  const on = d.find(x => x.online);
  if (on) { deviceId = on.id; break; }
  await kiosk.waitForTimeout(250);
}
ok(!!deviceId, 'планшет на связи: ' + deviceId);

await post('/show-document', { target: 'device:' + deviceId, fields: {} });
await kiosk.waitForSelector('.check', { timeout: 8000 });

// Порядок на экране планшета.
const onScreen = await kiosk.evaluate(() => Array.from(document.querySelectorAll('.doc-body > div > *'))
  .map(n => (n.className || '') + '|' + n.textContent.trim().slice(0, 30)));
ok(/АБЗАЦ-ПЕРВЫЙ/.test(onScreen[1] || '') && /ПУНКТ-ПОД-ПЕРВЫМ/.test(onScreen[2] || '') &&
   /АБЗАЦ-ВТОРОЙ/.test(onScreen[3] || '') && /ПУНКТ-ПОД-ВТОРЫМ/.test(onScreen[4] || ''),
  'на планшете пункт стоит под своим абзацем: ' + JSON.stringify(onScreen));

// Отмечаем оба пункта и выбираем вариант.
await kiosk.evaluate(() => {
  document.querySelectorAll('.checks .check input').forEach((i, n) => { if (n < 3) { i.checked = true; i.dispatchEvent(new Event('change', { bubbles: true })); } });
});
await kiosk.waitForTimeout(300);
await kiosk.click('.footer button.primary, #docNext, .doc-footer button:last-child');
await kiosk.waitForSelector('canvas', { timeout: 8000 });
// Рисуем подпись мышью.
const box = await kiosk.locator('.sign-wrap').boundingBox();
await kiosk.mouse.move(box.x + 30, box.y + box.height / 2);
await kiosk.mouse.down();
await kiosk.mouse.move(box.x + box.width - 40, box.y + box.height / 2 - 20, { steps: 12 });
await kiosk.mouse.up();
await kiosk.waitForTimeout(300);
await kiosk.click('.doc-footer button:last-child, #docNext');
await kiosk.waitForTimeout(2500);

const sigs = (await call('/signatures')).body || [];
ok(sigs.length === 1, 'подпись сохранена: ' + sigs.length);
const id = sigs[0] && sigs[0].id;

// Читаем PDF как текст: PDFsharp пишет содержимое потоками, поэтому проверяем через сервер.
const text = await admin.evaluate(async (sid) => {
  const r = await fetch('/api/admin/signatures/' + sid + '/pdf', { credentials: 'same-origin' });
  const buf = new Uint8Array(await r.arrayBuffer());
  return { status: r.status, size: buf.length };
}, id);
ok(text.status === 200 && text.size > 1000, 'PDF отдаётся и не пустой: ' + JSON.stringify(text));

// Порядок проверяем по самой записи и по документу подписи: PDF строится из них.
const rec = (await call('/signatures/' + id)).body;
ok(JSON.stringify((rec.items || []).map(i => i.label)) === JSON.stringify(['ПУНКТ-ПОД-ПЕРВЫМ', 'ПУНКТ-ПОД-ВТОРЫМ']),
  'отметки в записи идут в порядке экрана: ' + JSON.stringify((rec.items || []).map(i => i.label)));
ok((rec.groups || []).length === 1 && rec.groups[0].key === 'g1', 'выбор варианта записан');

// Сохраняем PDF на диск, чтобы проверить его текст сторонним средством.
const bytes = await admin.evaluate(async (sid) => {
  const r = await fetch('/api/admin/signatures/' + sid + '/pdf', { credentials: 'same-origin' });
  return Array.from(new Uint8Array(await r.arrayBuffer()));
}, id);
const fs = await import('fs');
fs.writeFileSync(SP + '/out.pdf', Buffer.from(bytes));

// Главное: текст PDF идёт в том же порядке, что и экран планшета.
const { execSync } = await import('child_process');
const pdfText = execSync('pdftotext -layout ' + SP + '/out.pdf -').toString();
const at = (needle) => pdfText.indexOf(needle);
ok(at('АБЗАЦ-ПЕРВЫЙ') >= 0 && at('ПУНКТ-ПОД-ПЕРВЫМ') > at('АБЗАЦ-ПЕРВЫЙ') &&
   at('АБЗАЦ-ВТОРОЙ') > at('ПУНКТ-ПОД-ПЕРВЫМ') && at('ПУНКТ-ПОД-ВТОРЫМ') > at('АБЗАЦ-ВТОРОЙ') &&
   at('ВЫБОР-В-КОНЦЕ') > at('ПУНКТ-ПОД-ВТОРЫМ'),
  'в PDF отметки стоят под своими абзацами, а не собраны в конец');
ok(/\[X\]\s*ПУНКТ-ПОД-ПЕРВЫМ/.test(pdfText) && /\[X\]\s*ПУНКТ-ПОД-ВТОРЫМ/.test(pdfText),
  'отмеченные пункты помечены в PDF как отмеченные');
ok(/\[X\]\s*Разрешаю/.test(pdfText) && /\[ \]\s*Запрещаю/.test(pdfText),
  'в группе виден и выбранный, и невыбранный вариант');
ok(pdfText.indexOf('Отмеченные пункты') < 0, 'отдельного списка в конце больше нет: он был бы повтором');
ok((pdfText.match(/ПУНКТ-ПОД-ПЕРВЫМ/g) || []).length === 1, 'пункт напечатан ровно один раз');

await browser.close();
console.log(fail === 0 ? '\nВСЁ ПРОЙДЕНО' : '\n' + fail + ' ПРОВЕРОК УПАЛО');
process.exit(fail === 0 ? 0 : 1);
