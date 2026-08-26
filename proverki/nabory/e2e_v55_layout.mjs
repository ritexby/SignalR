// Раскладка PDF: сервер сообщает, где именно окажется каждая строка. Считает это тот же
// генератор, который потом соберёт файл, поэтому макет в админке совпадает с PDF, а не похож.
import { chromium } from 'playwright';
const BASE = 'http://127.0.0.1:5080';
// Путь к браузеру берётся из окружения: на другой машине он другой, а зашитый путь
// превращал набор в неработающий у всех, кроме одной установки. Пусто значит
// «пусть Playwright возьмёт свой», как он и делает по умолчанию.
const EXE = process.env.SK_CHROME || undefined;
let fail = 0;
const ok = (c, m) => { if (c) console.log('PASS', m); else { console.error('FAIL', m); fail++; } };

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const p = await (await browser.newContext()).newPage();
await p.goto(BASE + '/admin/');
await p.fill('#password', 'test123'); await p.click('#loginForm button[type=submit]');
await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
const call = (path, opts) => p.evaluate(async ([pa, o]) => {
  const r = await fetch('/api/admin' + pa, Object.assign({ credentials: 'same-origin' }, o || {}));
  let b = null; try { b = await r.json(); } catch {} return { status: r.status, body: b };
}, [path, opts]);

const абз = 'Настоящим подтверждаю, что ознакомлен с порядком оказания услуг и с условиями обработки моих персональных данных в соответствии с законодательством.';
await call('/document', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
  title: 'ИНФОРМАЦИОННОЕ СОГЛАШЕНИЕ', signPrompt: 'Распишитесь', thankYouText: 'Спасибо', idleReturnSec: 0,
  pages: [1, 2, 3].map(n => ({
    headingRuns: [{ text: n + '. Раздел документа', bold: true }],
    blocks: [{ runs: [{ text: абз }], ord: 0 }, { runs: [{ text: абз + ' ' + абз }], ord: 1 }],
    checkboxes: [{ key: 'c' + n, label: 'Пункт ' + n, required: true, ord: 2 }],
    groups: [],
    signatures: n === 2 ? [{ key: 'guardian', label: 'Подпись представителя', required: false, ord: 3 }] : [],
    scans: []
  })),
  signBlocks: [], signBlocksBelow: [] }) });

const r = await call('/document/pdf-layout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
ok(r.status === 200, 'раскладка отдаётся: ' + r.status);
const L = r.body;
ok(Math.round(L.pageWidth) === 595 && Math.round(L.pageHeight) === 842, 'лист A4 в точках: ' + Math.round(L.pageWidth) + '×' + Math.round(L.pageHeight));
ok(L.pageCount >= 1, 'страниц: ' + L.pageCount);
ok((L.items || []).length > 20, 'элементов раскладки: ' + (L.items || []).length);

const тексты = L.items.filter(i => i.kind === 'text');
ok(тексты.some(i => /ИНФОРМАЦИОННОЕ СОГЛАШЕНИЕ/.test(i.text)), 'заголовок документа в раскладке');
const строки = {};
for (const i of тексты) { const k = i.page + ':' + Math.round(i.y); строки[k] = (строки[k] || '') + (строки[k] ? ' ' : '') + i.text; }
const всеСтроки = Object.values(строки);
ok(всеСтроки.some(t => /Раздел документа/.test(t)), 'заголовки разделов тоже');
const первый = тексты[0];
ok(первый.page === 0 && первый.y >= 49 && первый.y <= 51, 'первая строка на первой странице у верхнего поля: y=' + Math.round(первый.y));
ok(тексты.every(i => i.x >= 49 && i.x + i.w <= 546), 'ничего не вылезает за поля листа');
ok(тексты.every(i => i.y >= 0 && i.y + i.h <= L.pageHeight), 'и за высоту тоже');

// Место под подписи: и под итоговую, и под ту, что внутри страницы.
const подписи = L.items.filter(i => i.kind === 'sign');
ok(подписи.length === 2, 'в раскладке два места под подпись: ' + подписи.length);
ok(подписи.some(i => i.text === 'guardian'), 'подпись внутри страницы названа своим именем');
ok(подписи.some(i => i.text === ''), 'и есть место под итоговую подпись');

// Поля подписи перечислены отдельно: их и расставляет оператор.
ok((L.fields || []).length === 2, 'поля подписи перечислены: ' + JSON.stringify((L.fields || []).map(f => f.key)));
ok(L.fields[0].key === '', 'первым идёт итоговая подпись');

// Главное: раскладка должна совпадать с настоящим PDF по числу страниц и по тексту.
// Подписываем документ и сравниваем.
const code = (await call('/devices/enroll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"name":"Планшет"}' })).body.code;
const kiosk = await (await browser.newContext({ viewport: { width: 800, height: 1200 } })).newPage();
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
await kiosk.waitForSelector('.check', { timeout: 8000 });
for (let i = 0; i < 8; i++) {
  if (await kiosk.locator('.sign-screen canvas').count()) break;
  // Подписать поле внутри страницы, если оно на текущем экране.
  const pw = await kiosk.locator('.page-sign-wrap').count();
  if (pw) {
    const b = await kiosk.locator('.page-sign-wrap').first().boundingBox();
    if (b) {
      await kiosk.mouse.move(b.x + 25, b.y + b.height / 2);
      await kiosk.mouse.down();
      await kiosk.mouse.move(b.x + b.width - 30, b.y + b.height / 2 - 15, { steps: 8 });
      await kiosk.mouse.up();
      await kiosk.waitForTimeout(200);
    }
  }
  await kiosk.evaluate(() => {
    document.querySelectorAll('.checks .check input').forEach(x => {
      if (!x.checked) { x.checked = true; x.dispatchEvent(new Event('change', { bubbles: true })); }
    });
    const b = document.getElementById('btnNext'); if (b) b.click();
  });
  await kiosk.waitForTimeout(500);
}
await kiosk.waitForSelector('.sign-screen canvas', { timeout: 8000 });
const box = await kiosk.locator('.sign-screen .sign-wrap').boundingBox();
await kiosk.mouse.move(box.x + 30, box.y + box.height / 2);
await kiosk.mouse.down();
await kiosk.mouse.move(box.x + box.width - 40, box.y + box.height / 2 - 20, { steps: 10 });
await kiosk.mouse.up();
await kiosk.waitForTimeout(300);
await kiosk.evaluate(() => { const b = document.getElementById('btnSign'); if (b) b.click(); });
await kiosk.waitForTimeout(2500);

const sigs = (await call('/signatures')).body || [];
ok(sigs.length === 1, 'документ подписан');
const bytes = await p.evaluate(async (sid) => {
  const res = await fetch('/api/admin/signatures/' + sid + '/pdf', { credentials: 'same-origin' });
  return Array.from(new Uint8Array(await res.arrayBuffer()));
}, sigs[0].id);
const fs = await import('fs');
const SP = '' + (process.env.SK_RABOTA || '.') + '';
fs.writeFileSync(SP + '/layout.pdf', Buffer.from(bytes));
const { execSync } = await import('child_process');
const текстPdf = execSync('pdftotext -layout ' + SP + '/layout.pdf -').toString();
// pdftotext ставит перевод страницы и после последней, поэтому пустой хвост не считаем.
const страницPdf = текстPdf.split('\f').filter(p => p.trim().length > 0).length;
ok(страницPdf === L.pageCount, 'число страниц в раскладке совпало с PDF: макет ' + L.pageCount + ', PDF ' + страницPdf);

// Каждая строка раскладки должна найтись в тексте PDF.
// В макете отметки ещё не проставлены, в подписанном PDF уже стоят: сравниваем без маркера.
const безМетки = t => t.replace(/\[[X ]?\s*\]/g, '[]').replace(/\s+/g, ' ').trim();
const склеено = безМетки(текстPdf);
const пропало = всеСтроки.filter(t => t.trim().length > 3 && склеено.indexOf(безМетки(t)) < 0);
ok(пропало.length === 0, 'весь текст раскладки есть в PDF, не найдено: ' + JSON.stringify(пропало.slice(0, 3)));

// Подпись внутри страницы в раскладке и в PDF должна занимать одну и ту же высоту, иначе
// координаты, снятые с макета, на готовом документе съедут.
const подписьРаскладка = подписи.find(i => i.text === 'guardian');
ok(подписьРаскладка.h === 100 && подписьРаскладка.w === 280, 'место подписи 280×100: ' + подписьРаскладка.w + '×' + подписьРаскладка.h);

await browser.close();
console.log(fail === 0 ? '\nВСЁ ПРОЙДЕНО' : '\n' + fail + ' ПРОВЕРОК УПАЛО');
process.exit(fail === 0 ? 0 : 1);
