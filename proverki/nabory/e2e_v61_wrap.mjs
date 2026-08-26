// Обтекание картинки текстом: на планшете, в предпросмотре и в PDF.
import { chromium } from 'playwright';
const BASE = 'http://127.0.0.1:5080';
// Путь к браузеру берётся из окружения: на другой машине он другой, а зашитый путь
// превращал набор в неработающий у всех, кроме одной установки. Пусто значит
// «пусть Playwright возьмёт свой», как он и делает по умолчанию.
const EXE = process.env.SK_CHROME || undefined;
let fail = 0;
const ok = (c, m) => { if (c) console.log('PASS', m); else { console.error('FAIL', m); fail++; } };

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const p = await (await browser.newContext({ viewport: { width: 1500, height: 950 } })).newPage();
p.on('pageerror', e => console.log('ОШИБКА АДМИНКИ:', e.message));
await p.goto(BASE + '/admin/');
await p.fill('#password', 'test123'); await p.click('#loginForm button[type=submit]');
await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
const call = (path, opts) => p.evaluate(async ([pa, o]) => {
  const r = await fetch('/api/admin' + pa, Object.assign({ credentials: 'same-origin' }, o || {}));
  let b = null; try { b = await r.json(); } catch {} return { status: r.status, body: b };
}, [path, opts]);

// Картинка заметного размера, чтобы обтекание было видно.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAGQAAABkCAIAAAD/gAIDAAAAoklEQVR42u3QMQ0AAAgDsMlBE+qQigU+niZV0NQ0R1EgS5YsWbJkKZAlS5YsWbIUyJIlS5YsWQpkyZIlS5YsBbJkyZIlS5YCWbJkyZIlS4EsWbJkyZKlQJYsWbJkyVIgS5YsWbJkKZAlS5YsWbIUyJIlS5YsWQpkyZIlS5YsBbJkyZIlS5YCWbJkyZIlS4EsWbJkyZKlQJYsWbJkyVIgS9a3BSPhQrX2bcxgAAAAAElFTkSuQmCC';
const залито = await p.evaluate(async (b64) => {
  const bin = atob(b64), arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  const fd = new FormData();
  fd.append('files', new Blob([arr], { type: 'image/png' }), 'pechat.png');
  const r = await fetch('/api/admin/images', { method: 'POST', credentials: 'same-origin', body: fd });
  // Ответ загрузки: список принятых и список отклонённых с причиной. Раньше был просто массив,
  // и молча пропущенный файл выглядел как успешно загруженный.
  const ответ = await r.json();
  return (ответ.added || ответ)[0];
}, PNG);
ok(!!залито && !!залито.url, 'картинка загружена: ' + (залито && залито.url));

const абз = 'Настоящим подтверждаю, что ознакомлен с порядком оказания услуг и с условиями обработки моих персональных данных в соответствии с законодательством. Настоящим подтверждаю, что ознакомлен с порядком оказания услуг.';
const документ = (wrap, gap) => ({
  title: 'ДОГОВОР', signPrompt: 'x', thankYouText: 'x', idleReturnSec: 0,
  pages: [{ headingRuns: [{ text: 'Условия' }], checkboxes: [], groups: [], signatures: [], scans: [],
    blocks: [
      { imageUrl: залито.url, imageWidth: 40, ord: 0, wrap: wrap, wrapGap: gap },
      { runs: [{ text: абз }], ord: 1 },
      { runs: [{ text: абз }], ord: 2 },
      { runs: [{ text: абз + ' ' + абз }], ord: 3 }] }],
  signBlocks: [], signBlocksBelow: [] });

// Сохранение и очистка.
await call('/document', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(документ('left', 14)) });
const сохр = (await call('/document')).body.pages[0].blocks[0];
ok(сохр.wrap === 'left' && сохр.wrapGap === 14, 'обтекание сохранено: ' + JSON.stringify({ wrap: сохр.wrap, gap: сохр.wrapGap }));
await call('/document', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(JSON.parse(JSON.stringify(документ('вбок', 14))) ) });
ok(!((await call('/document')).body.pages[0].blocks[0].wrap), 'неизвестная сторона обтекания не сохраняется');
const широкая = документ('left', 14); широкая.pages[0].blocks[0].imageWidth = 100;
await call('/document', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(широкая) });
ok(((await call('/document')).body.pages[0].blocks[0].imageWidth) === 70, 'картинка во всю ширину обтекать не может: ширина ужата');

// PDF: строки рядом с картинкой должны быть короче, и картинка стоит сбоку, а не над текстом.
const раскладка = async (wrap) => {
  await call('/document', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(документ(wrap, 14)) });
  const r = await call('/document/pdf-layout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  return r.body;
};
const строки = (L) => {
  const m = {};
  L.items.filter(i => i.kind === 'text')
    .forEach(i => { const k = i.page + ':' + Math.round(i.y); (m[k] = m[k] || []).push(i); });
  return Object.values(m).map(ws => { ws.sort((a, b) => a.x - b.x);
    return { y: ws[0].y, left: ws[0].x, right: ws[ws.length - 1].x + ws[ws.length - 1].w }; })
    .sort((a, b) => a.y - b.y);
};

const без = await раскладка('');
const слева = await раскладка('left');
const справа = await раскладка('right');
const картинкаБез = без.items.find(i => i.kind === 'image');
const картинкаСлева = слева.items.find(i => i.kind === 'image');
const картинкаСправа = справа.items.find(i => i.kind === 'image');
ok(!!картинкаБез && !!картинкаСлева, 'картинка есть в раскладке');

console.log('картинка слева: y=' + Math.round(картинкаСлева.y) + ' h=' + Math.round(картинкаСлева.h) +
  ' низ=' + Math.round(картинкаСлева.y + картинкаСлева.h));
const послеКартинки = (L, карт) => строки(L).filter(l => l.y >= карт.y - 1);
const первыйБез = послеКартинки(без, картинкаБез)[0];
const первыйСлева = послеКартинки(слева, картинкаСлева)[0];
const первыйСправа = послеКартинки(справа, картинкаСправа)[0];
ok(первыйБез.y > картинкаБез.y + картинкаБез.h - 1, 'без обтекания текст идёт ПОД картинкой');
ok(первыйСлева.y < картинкаСлева.y + картинкаСлева.h, 'при обтекании текст идёт РЯДОМ с картинкой');
ok(первыйСлева.left > картинкаСлева.x + картинкаСлева.w - 0.5,
  'и начинается правее картинки: строка от ' + Math.round(первыйСлева.left) + ', картинка до ' + Math.round(картинкаСлева.x + картинкаСлева.w));
ok(Math.abs((первыйСлева.left - (картинкаСлева.x + картинкаСлева.w)) - 14) < 1.5,
  'отступ от картинки соблюдён: ' + Math.round(первыйСлева.left - (картинкаСлева.x + картинкаСлева.w)) + ' точек');

ok(Math.abs(картинкаСправа.x + картинкаСправа.w - 545) < 1, 'при обтекании справа картинка прижата к правому полю: ' + Math.round(картинкаСправа.x + картинкаСправа.w));
ok(Math.abs(первыйСправа.left - 50) < 0.5, 'а текст начинается от левого поля');
ok(первыйСправа.right < картинкаСправа.x - 10, 'и кончается левее картинки: ' + Math.round(первыйСправа.right) + ' против ' + Math.round(картинкаСправа.x));

// Ниже картинки строки снова во всю ширину.
const низ = картинкаСлева.y + картинкаСлева.h;
const узкие = строки(слева).filter(l => l.y >= картинкаСлева.y && l.y < низ);
// Строка считается «ниже картинки», только если она начинается заведомо под ней: строка,
// верх которой ещё внутри картинки, по-прежнему обтекает её и сдвинута по праву.
const широкие = строки(слева).filter(l => l.y > низ + 6);
ok(узкие.length >= 2, 'рядом с картинкой несколько строк: ' + узкие.length);
ok(широкие.length >= 1, 'и ниже неё текст продолжается: ' + широкие.length);
console.log('строки ниже картинки: ' + JSON.stringify(широкие.slice(0, 3).map(l => ({ y: Math.round(l.y), left: Math.round(l.left) }))));
ok(широкие.every(l => Math.abs(l.left - 50) < 0.5), 'ниже картинки строки снова от левого поля');

// Планшет: картинка обтекается по-настоящему.
await call('/document', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(документ('left', 14)) });
const code = (await call('/devices/enroll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"name":"Планшет"}' })).body.code;
const kiosk = await (await browser.newContext({ viewport: { width: 900, height: 1400 } })).newPage();
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
await kiosk.waitForSelector('.doc-image', { timeout: 8000 });
const наПланшете = await kiosk.evaluate(() => {
  const fig = document.querySelector('.doc-image');
  const txt = document.querySelector('.doc-text');
  const f = fig.getBoundingClientRect();
  // У блока с обтеканием сдвигается не он сам, а строки внутри него: меряем первую строку,
  // а не рамку блока, иначе обтекания «не видно» там, где оно есть.
  const r = document.createRange();
  r.selectNodeContents(txt);
  const первая = r.getClientRects()[0];
  return { плавает: getComputedStyle(fig).cssFloat, рядом: первая.top < f.bottom - 5,
    правее: первая.left > f.right - 2, отступ: Math.round(первая.left - f.right) };
});
ok(наПланшете.плавает === 'left', 'на планшете картинка плавает слева: ' + наПланшете.плавает);
ok(наПланшете.рядом, 'текст идёт рядом с ней, а не под ней');
ok(наПланшете.правее, 'и первая строка начинается правее картинки, с отступом ' + наПланшете.отступ + ' точек');

await browser.close();
console.log(fail === 0 ? '\nВСЁ ПРОЙДЕНО' : '\n' + fail + ' ПРОВЕРОК УПАЛО');
process.exit(fail === 0 ? 0 : 1);
