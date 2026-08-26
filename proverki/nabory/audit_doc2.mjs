// Конструктор документа, второй заход: перетаскивание, оглавление, черновик, импорт, тупики.
import { chromium } from 'playwright';
import fs from 'fs';
const BASE = 'http://127.0.0.1:5080';
// Путь к браузеру берётся из окружения: на другой машине он другой, а зашитый путь
// превращал набор в неработающий у всех, кроме одной установки. Пусто значит
// «пусть Playwright возьмёт свой», как он и делает по умолчанию.
const EXE = process.env.SK_CHROME || undefined;
const SP = '' + (process.env.SK_RABOTA || '.') + '';
const найдено = [];
const баг = (что) => { найдено.push(что); console.log('FAIL ' + что); };
const норм = (что) => console.log('в порядке: ' + что);

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const ctx = await browser.newContext({ viewport: { width: 1500, height: 1000 }, acceptDownloads: true });
const p = await ctx.newPage();
const ошибкиJS = [];
p.on('pageerror', e => ошибкиJS.push(String(e.message).slice(0, 140)));
await p.goto(BASE + '/admin/');
await p.fill('#password', 'test123'); await p.click('#loginForm button[type=submit]');
await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
const call = (path, opts) => p.evaluate(async ([pa, o]) => {
  const r = await fetch('/api/admin' + pa, Object.assign({ credentials: 'same-origin' }, o || {}));
  let b = null; try { b = await r.json(); } catch {} return { status: r.status, body: b };
}, [path, opts]);
const бросить = async () => {
  // Окно появляется не сразу: черновик сравнивается с документом, а тот ещё едет с сервера.
  const b = p.locator('.modal button', { hasText: 'Отказаться от черновика' });
  try { await b.waitFor({ state: 'visible', timeout: 2500 }); } catch { return; }
  await b.click();
  await p.waitForTimeout(200);
};
const открыть = async () => {
  await p.evaluate(() => Object.keys(localStorage).filter(k => k.indexOf('sk_doc_draft') === 0).forEach(k => localStorage.removeItem(k)));
  await p.reload(); await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
  await p.click('[data-tab="document"]'); await p.waitForTimeout(700); await бросить();
};

const три = {
  title: 'ДОГОВОР', signPrompt: 'Распишитесь', thankYouText: 'Спасибо', idleReturnSec: 0,
  pages: [1, 2, 3].map(n => ({ headingRuns: [{ text: 'Раздел ' + n }],
    blocks: [{ runs: [{ text: 'Текст раздела ' + n + '.' }], ord: 0 }],
    checkboxes: [{ key: 'c' + n, label: 'Пункт ' + n, required: true, ord: 1 }],
    groups: [], signatures: [], scans: [] })),
  signBlocks: [], signBlocksBelow: [] };
await call('/document', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(три) });
await открыть();

// 1. Оглавление: клик ведёт на ту страницу, на которую нажали.
const пункты = await p.locator('.toc-item').allTextContents();
норм('в оглавлении пунктов: ' + пункты.length + ' — ' + пункты.map(t => t.trim().slice(0, 18)).join(' | '));
await p.locator('.toc-item').nth(2).click();
await p.waitForTimeout(600);
const кудаПопали = await p.evaluate(() => {
  const cards = document.querySelectorAll('#pagesEditor [data-role="pagecard"]');
  let ближ = -1, best = 1e9;
  cards.forEach((c, i) => { const t = Math.abs(c.getBoundingClientRect().top - 120); if (t < best) { best = t; ближ = i; } });
  return ближ;
});
if (кудаПопали !== 2) баг('нажатие на третью страницу в оглавлении приводит к странице ' + (кудаПопали + 1));
else норм('оглавление ведёт на нужную страницу');

// 2. Удаление последней страницы: документ без страниц.
for (let i = 0; i < 3; i++) {
  p.once('dialog', d => d.accept());
  await p.locator('#pagesEditor [data-role="pagecard"] button', { hasText: 'Удалить' }).first().click();
  await p.waitForTimeout(400);
}
const безСтраниц = await p.evaluate(() => ({
  карточек: document.querySelectorAll('#pagesEditor [data-role="pagecard"]').length,
  подсказка: (document.getElementById('pagesEditor').textContent || '').trim().slice(0, 90)
}));
if (безСтраниц.карточек === 0 && !безСтраниц.подсказка)
  баг('когда все страницы удалены, редактор показывает пустоту без единого слова: непонятно, сломалось или так и надо');
else норм('документ без страниц: ' + JSON.stringify(безСтраниц));

// 3. Отправка документа без страниц на планшет.
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
await p.click('#saveDocument'); await p.waitForTimeout(700);
const сохранёнПустой = (await call('/document')).body;
норм('документ без страниц сохранён, страниц в нём: ' + (сохранёнПустой.pages || []).length);
await p.click('#showDocument'); await p.waitForTimeout(700);
const замечания = await p.locator('.modal:not(.hidden)').count();
if (замечания) {
  const текстЗамечаний = await p.locator('.modal').textContent();
  норм('перед отправкой пустого документа показаны замечания: ' + текстЗамечаний.replace(/\s+/g, ' ').slice(0, 90));
  const дальше = p.locator('.modal button', { hasText: /Всё равно|Отправить|Продолж/ });
  if (await дальше.count()) await дальше.first().click();
  else await p.locator('.modal button').first().click();
  await p.waitForTimeout(1500);
}
const проПустой = await p.evaluate(() => (document.querySelector('.toast') || {}).textContent || '');
const наПустом = await kiosk.evaluate(() => document.body.textContent.replace(/\s+/g, ' ').trim().slice(0, 100));
if (!/ни одной страницы|показывать нечего/i.test(проПустой))
  баг('документ без страниц отправляется молча: на планшете ничего не меняется, а оператор думает, что отправка сработала. Ответ: «' + проПустой + '»');
else норм('отправка пустого документа объяснена: «' + проПустой.slice(0, 90) + '»');
норм('на планшете при этом осталось: «' + наПустом.slice(0, 70) + '»');

// 4. Черновик: правка, уход со вкладки, возврат.
await call('/document', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(три) });
await открыть();
await p.locator('[data-role="cblabel"]').first().click();
await p.keyboard.press('Control+A');
await p.keyboard.type('Правка, которую нельзя терять');
await p.waitForTimeout(400);
const пометка = await p.evaluate(() => !document.getElementById('docDirty').classList.contains('hidden'));
if (!пометка) баг('правка не помечается как несохранённая: пометка «есть несохранённые изменения» не появилась');
else норм('правка помечена как несохранённая');
await p.click('[data-tab="slides"]'); await p.waitForTimeout(500);
await p.click('[data-tab="document"]'); await p.waitForTimeout(600);
const послеВозврата = await p.locator('[data-role="cblabel"]').first().textContent();
if (!послеВозврата.includes('нельзя терять'))
  баг('правка потерялась при переходе на другую вкладку и обратно: стало «' + послеВозврата.slice(0, 40) + '»');
else норм('правка пережила переход по вкладкам');

// 5. Черновик после перезагрузки страницы.
await p.reload(); await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
await p.waitForTimeout(1500);
const предложили = await p.locator('.modal:not(.hidden)', { hasText: 'черновик' }).count();
if (!предложили) баг('после перезагрузки несохранённая правка пропала без предложения восстановить черновик');
else норм('после перезагрузки предложено восстановить черновик');
await бросить();

// 6. Импорт битого файла.
const битый = SP + '/broken-import.json';
fs.writeFileSync(битый, '{ "kind": "не тот", "document": null }');
p.once('dialog', d => d.accept());
await p.locator('#importDocFile').setInputFiles(битый);
await p.waitForTimeout(1200);
const проИмпорт = await p.evaluate(() => (document.querySelector('.toast') || {}).textContent || '');
if (!проИмпорт || /ошибка сервера/i.test(проИмпорт))
  баг('импорт чужого файла не объясняет причину: «' + проИмпорт + '»');
else норм('импорт чужого файла объяснён: «' + проИмпорт.slice(0, 90) + '»');

const мусор = SP + '/broken2.json';
fs.writeFileSync(мусор, 'это вообще не json');
p.once('dialog', d => d.accept());
await p.locator('#importDocFile').setInputFiles(мусор);
await p.waitForTimeout(1200);
const проМусор = await p.evaluate(() => (document.querySelector('.toast') || {}).textContent || '');
if (!проМусор) баг('импорт файла, который не json, не говорит ничего');
else норм('импорт не-json объяснён: «' + проМусор.slice(0, 80) + '»');

// 7. Окно PDF, когда полей подписи нет вовсе.
await call('/document', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
  title: 'БЕЗ ПОДПИСЕЙ', signPrompt: 'x', thankYouText: 'x', idleReturnSec: 0,
  pages: [{ headingRuns: [{ text: 'Условия' }], blocks: [{ runs: [{ text: 'Текст.' }], ord: 0 }],
    checkboxes: [], groups: [], signatures: [], scans: [] }],
  signBlocks: [], signBlocksBelow: [] }) });
await открыть();
await p.click('#pdfLayout'); await p.waitForSelector('.pdfl', { timeout: 10000 });
await p.waitForTimeout(800);
const пдфБезПодписей = await p.evaluate(() => ({
  поля: document.querySelectorAll('.pdfl-field').length,
  текст: (document.querySelector('.pdfl-side') || {}).textContent || ''
}));
норм('окно PDF без полей подписи: полей ' + пдфБезПодписей.поля + ', подпись «' + пдфБезПодписей.текст.replace(/\s+/g, ' ').slice(0, 70) + '»');
await p.locator('.pdfl button', { hasText: 'Отмена' }).click();
await p.waitForTimeout(300);

if (ошибкиJS.length) баг('ошибки JavaScript: ' + JSON.stringify(ошибкиJS.slice(0, 3)));
else норм('ошибок JavaScript нет');

await browser.close();
console.log('\nИТОГО НАЙДЕНО: ' + найдено.length);
найдено.forEach((x, i) => console.log((i + 1) + '. ' + x));
if (найдено.length === 0) console.log('\nВСЁ ПРОЙДЕНО');
process.exit(найдено.length === 0 ? 0 : 1);
