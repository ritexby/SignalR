// Экран подписи и экран сканирования: отдельные шаги, при этом подпись можно поставить и
// блоком внутри обычной страницы.
import { chromium } from 'playwright';
const BASE = 'http://127.0.0.1:5080';
// Путь к браузеру берётся из окружения: на другой машине он другой, а зашитый путь
// превращал набор в неработающий у всех, кроме одной установки. Пусто значит
// «пусть Playwright возьмёт свой», как он и делает по умолчанию.
const EXE = process.env.SK_CHROME || undefined;
let fail = 0;
const ok = (c, m) => { if (c) console.log('PASS', m); else { console.error('FAIL', m); fail++; } };
async function отказатьсяОтЧерновика(page) {
  // Окно появляется не сразу: черновик сравнивается с документом, а тот ещё едет с сервера.
  // Проверка «есть ли окно прямо сейчас» промахивалась, окно всплывало позже и перехватывало
  // нажатия, а набор падал на «кнопка недоступна», ничего не объясняя.
  const btn = page.locator('.modal button', { hasText: 'Отказаться от черновика' });
  try { await btn.waitFor({ state: 'visible', timeout: 2500 }); } catch { return; }
  await btn.click();
  await page.waitForTimeout(200);
}

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const p = await (await browser.newContext({ viewport: { width: 1500, height: 950 } })).newPage();
p.on('pageerror', e => console.log('ОШИБКА СТРАНИЦЫ:', e.message));
await p.goto(BASE + '/admin/');
await p.fill('#password', 'test123'); await p.click('#loginForm button[type=submit]');
await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
const call = (path, opts) => p.evaluate(async ([pa, o]) => {
  const r = await fetch('/api/admin' + pa, Object.assign({ credentials: 'same-origin' }, o || {}));
  let b = null; try { b = await r.json(); } catch {} return { status: r.status, body: b };
}, [path, opts]);

// Документ: обычная страница с подписью-блоком плюс экран подписи и экран сканирования.
await call('/document', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
  title: 'СОГЛАСИЕ', signPrompt: 'Распишитесь', thankYouText: 'Спасибо', idleReturnSec: 0,
  pages: [
    { headingRuns: [{ text: 'Условия' }], blocks: [{ runs: [{ text: 'Текст соглашения.' }], ord: 0 }],
      checkboxes: [{ key: 'ok', label: 'Согласен', required: true, ord: 1 }], groups: [],
      signatures: [{ key: 'vrach', label: 'Подпись врача', required: true, ord: 2 }], scans: [] },
    { kind: 'signature', headingRuns: [{ text: 'Подпись представителя' }], blocks: [],
      checkboxes: [], groups: [], scans: [],
      signatures: [{ key: 'predstavitel', label: 'Распишитесь за представителя', required: true, ord: 0 }] },
    { kind: 'scan', headingRuns: [{ text: 'Штрихкод пробирки' }], blocks: [],
      checkboxes: [], groups: [], signatures: [],
      scans: [{ key: 'probirka', label: 'Поднесите штрихкод', required: true, ord: 0 }] }
  ], signBlocks: [], signBlocksBelow: [] }) });

const сохр = (await call('/document')).body;
ok(сохр.pages.length === 3, 'три страницы: ' + сохр.pages.length);
ok(!сохр.pages[0].kind, 'первая обычная');
ok(сохр.pages[0].signatures.length === 1, 'и на ней подпись блоком: ' + сохр.pages[0].signatures.length);
ok(сохр.pages[1].kind === 'signature' && сохр.pages[1].signatures.length === 1, 'вторая это экран подписи');
ok(сохр.pages[2].kind === 'scan' && сохр.pages[2].scans.length === 1, 'третья это экран сканирования');

// Экран не тащит с собой чужого: чекбоксы и присланные по API пункты туда не попадают.
await call('/document', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
  title: 'СОГЛАСИЕ', signPrompt: 'x', thankYouText: 'x', idleReturnSec: 0,
  pages: [{ kind: 'signature', headingRuns: [{ text: 'Подпись' }], blocks: [], groups: [], scans: [],
    includeDynamic: true, checkboxes: [{ key: 'lишний', label: 'Лишний пункт', required: true, ord: 1 }],
    signatures: [{ key: 'a', label: 'Одна', required: true, ord: 0 }, { key: 'b', label: 'Вторая', required: true, ord: 2 }] }],
  signBlocks: [], signBlocksBelow: [] }) });
const экран = (await call('/document')).body.pages[0];
ok(экран.signatures.length === 1, 'на экране подписи ровно одно поле: ' + экран.signatures.length);
ok((экран.checkboxes || []).length === 0, 'чекбоксов на экране подписи нет');
ok(!экран.includeDynamic, 'и присланные по API пункты туда не дописываются');

// Экран без своего поля перестаёт быть экраном: пустоту клиенту показывать нельзя.
await call('/document', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
  title: 'x', signPrompt: 'x', thankYouText: 'x', idleReturnSec: 0,
  pages: [{ kind: 'signature', headingRuns: [{ text: 'Пусто' }], blocks: [], checkboxes: [], groups: [], signatures: [], scans: [] }],
  signBlocks: [], signBlocksBelow: [] }) });
ok(!((await call('/document')).body.pages[0].kind), 'экран без поля стал обычной страницей');

// Редактор: три вида страницы и разные карточки.
await call('/document', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
  title: 'СОГЛАСИЕ', signPrompt: 'Распишитесь', thankYouText: 'Спасибо', idleReturnSec: 0,
  pages: [
    { headingRuns: [{ text: 'Условия' }], blocks: [{ runs: [{ text: 'Текст.' }], ord: 0 }],
      checkboxes: [{ key: 'ok', label: 'Согласен', required: true, ord: 1 }], groups: [], signatures: [], scans: [] },
    { kind: 'signature', headingRuns: [{ text: 'Подпись представителя' }], blocks: [], checkboxes: [], groups: [], scans: [],
      signatures: [{ key: 'predstavitel', label: 'Распишитесь', required: true, ord: 0 }] }
  ], signBlocks: [], signBlocksBelow: [] }) });
await p.evaluate(() => Object.keys(localStorage).filter(k => k.indexOf('sk_doc_draft') === 0).forEach(k => localStorage.removeItem(k)));
await p.reload(); await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
await p.click('[data-tab="document"]'); await p.waitForTimeout(700);
await отказатьсяОтЧерновика(p);

ok(await p.locator('[data-page-kind="signature"]').count() === 1, 'экран подписи виден в редакторе отдельной карточкой');
ok((await p.locator('.page-card.page-signature .page-name').textContent()).includes('Экран подписи'), 'и назван экраном подписи');
await p.locator('#addPage').click(); await p.waitForTimeout(200);
const виды = await p.locator('.page-kinds button').allTextContents();
ok(виды.length === 3, 'предлагаются три вида страницы: ' + JSON.stringify(виды));
await p.locator('.page-kinds button', { hasText: 'Экран сканирования' }).click();
await p.waitForTimeout(400);
ok(await p.locator('[data-page-kind="scan"]').count() === 1, 'экран сканирования добавлен');

// Полоса вставки: на обычной странице пять видов, на экране только текст.
await p.locator('.page-card:not(.page-signature):not(.page-scan) .insert-chip').first().click();
await p.waitForTimeout(200);
const наСтранице = await p.locator('.page-card:not(.page-signature):not(.page-scan) .insert-bar.open button').allTextContents();
ok(наСтранице.filter(t => /Поле подписи|Сканирование кода/.test(t)).length === 2,
  'на обычной странице подпись и сканирование можно поставить блоком: ' + JSON.stringify(наСтранице));
await p.locator('.page-card.page-signature .insert-chip').first().click();
await p.waitForTimeout(200);
const наЭкране = await p.locator('.page-card.page-signature .insert-bar.open button').allTextContents();
ok(наЭкране.filter(t => /Поле подписи|Сканирование кода|Чекбокс/.test(t)).length === 0,
  'а на экране подписи только текст: ' + JSON.stringify(наЭкране));

await p.click('#saveDocument'); await p.waitForTimeout(800);
const после = (await call('/document')).body;
ok(после.pages.length === 3, 'сохранились три страницы: ' + после.pages.length);
ok(после.pages[1].kind === 'signature' && после.pages[1].signatures[0].key === 'predstavitel',
  'экран подписи сохранился со своим полем: ' + JSON.stringify(после.pages[1].signatures));
ok(после.pages[2].kind === 'scan' && после.pages[2].scans.length === 1, 'и экран сканирования тоже');

// На планшете это отдельные шаги.
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
ok(await kiosk.locator('.screen-sign').count() === 0, 'первый шаг это обычная страница');
await kiosk.evaluate(() => {
  document.querySelectorAll('.checks .check input').forEach(x => { x.checked = true; x.dispatchEvent(new Event('change', { bubbles: true })); });
  document.getElementById('btnNext').click();
});
await kiosk.waitForTimeout(700);
ok(await kiosk.locator('.screen-sign').count() === 1, 'второй шаг это экран подписи');
ok(await kiosk.locator('.screen-sign .page-sign-wrap').count() === 1, 'и на нём поле подписи');
const bh = (await kiosk.locator('.screen-sign .page-sign-wrap').boundingBox()).height;
ok(bh > 250, 'место под подпись занимает экран, а не полоску: ' + Math.round(bh) + 'px');

await browser.close();
console.log(fail === 0 ? '\nВСЁ ПРОЙДЕНО' : '\n' + fail + ' ПРОВЕРОК УПАЛО');
process.exit(fail === 0 ? 0 : 1);
