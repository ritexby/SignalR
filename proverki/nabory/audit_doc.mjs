// Разбор конструктора документа: каждая кнопка, каждый поток, крайние случаи.
import { chromium } from 'playwright';
const BASE = 'http://127.0.0.1:5080';
// Путь к браузеру берётся из окружения: на другой машине он другой, а зашитый путь
// превращал набор в неработающий у всех, кроме одной установки. Пусто значит
// «пусть Playwright возьмёт свой», как он и делает по умолчанию.
const EXE = process.env.SK_CHROME || undefined;
const найдено = [];
const баг = (что) => { найдено.push(что); console.log('FAIL ' + что); };
const норм = (что) => console.log('в порядке: ' + что);

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const p = await (await browser.newContext({ viewport: { width: 1500, height: 950 } })).newPage();
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
  const b = p.locator('.modal button', { hasText: 'Отказаться от черновика' });
  if (await b.count()) { await b.click(); await p.waitForTimeout(200); }
};

await p.click('[data-tab="document"]'); await p.waitForTimeout(700);
await бросить();

// 1. Все кнопки панели на месте и подписаны.
const кнопки = await p.evaluate(() => Array.from(document.querySelectorAll('[data-panel="document"] .toolbar button'))
  .map(b => ({ id: b.id, текст: b.textContent.trim(), подсказка: b.getAttribute('title') || '', выкл: b.disabled })));
норм('кнопок в панели: ' + кнопки.length + ' — ' + кнопки.map(k => k.текст).join(', '));
const безПодсказки = кнопки.filter(k => !k.подсказка && k.id !== 'saveDocument');
if (безПодсказки.length) баг('кнопки без подсказки: ' + безПодсказки.map(k => k.текст || k.id).join(', '));
else норм('у каждой кнопки есть подсказка');

// 2. Пустой документ: что скажет «Проверить».
await call('/document', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
  title: '', signPrompt: '', idleReturnSec: 0,
  pages: [{ headingRuns: [], blocks: [], checkboxes: [], groups: [], signatures: [], scans: [] }],
  signBlocks: [], signBlocksBelow: [] }) });
await p.evaluate(() => Object.keys(localStorage).filter(k => k.indexOf('sk_doc_draft') === 0).forEach(k => localStorage.removeItem(k)));
await p.reload(); await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
await p.click('[data-tab="document"]'); await p.waitForTimeout(700); await бросить();
await p.click('#checkDoc'); await p.waitForTimeout(600);
const проверкаПустого = (await p.locator('.modal').textContent().catch(() => '')) || '';
if (!/заголов|пуст|нет/i.test(проверкаПустого))
  баг('пустой документ проходит проверку без замечаний: ' + проверкаПустого.slice(0, 100));
else норм('пустой документ отмечен проверкой: ' + проверкаПустого.replace(/\s+/g, ' ').slice(0, 110));
await p.locator('.modal button').last().click().catch(() => {});
await p.waitForTimeout(300);

// 3. Отправка пустого документа на планшет: что увидит клиент.
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
const отпр = await call('/show-document', { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ target: 'device:' + id, fields: {} }) });
await kiosk.waitForTimeout(1200);
const пустойНаПланшете = await kiosk.evaluate(() => document.body.textContent.replace(/\s+/g, ' ').trim().slice(0, 120));
норм('пустой документ на планшете: «' + пустойНаПланшете + '», ответ ' + отпр.status);

// 4. Страница со скрывающим условием, которая единственная: клиенту нечего показать.
await call('/document', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
  title: 'ДОГОВОР', signPrompt: 'Распишитесь', thankYouText: 'Спасибо', idleReturnSec: 0,
  pages: [{ headingRuns: [{ text: 'Только для женщин' }], blocks: [{ runs: [{ text: 'Текст.' }], ord: 0 }],
    checkboxes: [], groups: [], signatures: [], scans: [],
    visibleWhen: { field: 'Пол', op: 'eq', value: 'F' } }],
  signBlocks: [], signBlocksBelow: [] }) });
await call('/show-document', { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ target: 'device:' + id, fields: { 'Пол': 'M' } }) });
await kiosk.waitForTimeout(1200);
const всёСкрыто = await kiosk.evaluate(() => ({
  текст: document.body.textContent.replace(/\s+/g, ' ').trim().slice(0, 140),
  подпись: !!document.querySelector('.sign-screen'),
  далее: !!document.getElementById('btnNext')
}));
if (!всёСкрыто.подпись && !всёСкрыто.далее)
  баг('все страницы скрыты условием, и клиент попадает в тупик: ' + всёСкрыто.текст);
else норм('когда все страницы скрыты, клиент сразу на экране подписи: ' + всёСкрыто.текст.slice(0, 80));

// 5. Обязательный чекбокс внутри блока, скрытого условием: можно ли пройти дальше.
await call('/document', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
  title: 'ДОГОВОР', signPrompt: 'Распишитесь', thankYouText: 'Спасибо', idleReturnSec: 0,
  pages: [{ headingRuns: [{ text: 'Условия' }], blocks: [], groups: [], signatures: [], scans: [],
    checkboxes: [
      { key: 'vidno', label: 'Видимый пункт', required: true, ord: 0 },
      { key: 'skryt', label: 'Скрытый обязательный', required: true, ord: 1,
        visibleWhen: { field: 'vidno', op: 'eq', value: 'true' } }] }],
  signBlocks: [], signBlocksBelow: [] }) });
await call('/show-document', { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ target: 'device:' + id, fields: {} }) });
await kiosk.waitForSelector('.check', { timeout: 8000 });
const доОтметки = await kiosk.evaluate(() => document.querySelectorAll('.checks .check').length);
await kiosk.evaluate(() => {
  const n = Array.from(document.querySelectorAll('.checks .check')).find(x => x.textContent.includes('Видимый'));
  const i = n.querySelector('input'); i.checked = true; i.dispatchEvent(new Event('change', { bubbles: true }));
});
await kiosk.waitForTimeout(600);
const послеОтметки = await kiosk.evaluate(() => document.querySelectorAll('.checks .check').length);
норм('скрытый пункт появляется по отметке: было ' + доОтметки + ', стало ' + послеОтметки);

// 6. Дубли имён: два чекбокса с одним именем.
await call('/document', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
  title: 'ДОГОВОР', signPrompt: 'x', thankYouText: 'x', idleReturnSec: 0,
  pages: [{ headingRuns: [{ text: 'Условия' }], blocks: [], groups: [], signatures: [], scans: [],
    checkboxes: [{ key: 'odno', label: 'Первый', required: true, ord: 0 },
                 { key: 'odno', label: 'Второй', required: true, ord: 1 }] }],
  signBlocks: [], signBlocksBelow: [] }) });
await p.evaluate(() => Object.keys(localStorage).filter(k => k.indexOf('sk_doc_draft') === 0).forEach(k => localStorage.removeItem(k)));
await p.reload(); await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
await p.click('[data-tab="document"]'); await p.waitForTimeout(700); await бросить();
await p.click('#checkDoc'); await p.waitForTimeout(600);
const проДубли = (await p.locator('.modal').textContent().catch(() => '')) || '';
if (!/уже занято|дубл|повтор/i.test(проДубли))
  баг('два пункта с одним именем для API не отмечены проверкой: внешняя система задаст оба разом, а оператор об этом не знает');
else норм('дубли имён отмечены проверкой');
await p.locator('.modal button').last().click().catch(() => {});
await p.waitForTimeout(300);

// 6б. Имя поля подписи совпадает с именем чекбокса.
await call('/document', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
  title: 'ДОГОВОР', signPrompt: 'x', thankYouText: 'x', idleReturnSec: 0,
  pages: [{ headingRuns: [{ text: 'Условия' }], blocks: [], groups: [], scans: [],
    checkboxes: [{ key: 'soglasie', label: 'Согласен', required: true, ord: 0 }],
    signatures: [{ key: 'soglasie', label: 'Подпись', required: true, ord: 1 }] }],
  signBlocks: [], signBlocksBelow: [] }) });
await p.evaluate(() => Object.keys(localStorage).filter(k => k.indexOf('sk_doc_draft') === 0).forEach(k => localStorage.removeItem(k)));
await p.reload(); await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
await p.click('[data-tab="document"]'); await p.waitForTimeout(700); await бросить();
await p.click('#checkDoc'); await p.waitForTimeout(600);
const проПодпись = (await p.locator('.modal').textContent().catch(() => '')) || '';
if (!/уже занято/i.test(проПодпись))
  баг('имя поля подписи совпадает с именем чекбокса, а проверка молчит: по API одно имя означает две разные вещи');
else норм('совпадение имени подписи и чекбокса отмечено');
await p.locator('.modal button').last().click().catch(() => {});
await p.waitForTimeout(300);

// 7. Условие ссылается на чекбокс, которого больше нет.
await call('/document', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
  title: 'ДОГОВОР', signPrompt: 'x', thankYouText: 'x', idleReturnSec: 0,
  pages: [{ headingRuns: [{ text: 'Условия' }], groups: [], signatures: [], scans: [], checkboxes: [],
    blocks: [{ runs: [{ text: 'Зависимый абзац.' }], ord: 0,
      visibleWhen: { field: 'udalennyi', op: 'eq', value: 'true' } }] }],
  signBlocks: [], signBlocksBelow: [] }) });
await p.evaluate(() => Object.keys(localStorage).filter(k => k.indexOf('sk_doc_draft') === 0).forEach(k => localStorage.removeItem(k)));
await p.reload(); await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
await p.click('[data-tab="document"]'); await p.waitForTimeout(700); await бросить();
await p.click('#checkDoc'); await p.waitForTimeout(600);
const проСироту = (await p.locator('.modal').textContent().catch(() => '')) || '';
if (!/нет ни среди|не найден|такого имени/i.test(проСироту))
  баг('условие ссылается на несуществующее имя, а проверка молчит: блок не покажется никогда');
else норм('ссылка на несуществующее имя отмечена: ' + проСироту.replace(/\s+/g, ' ').slice(0, 100));
await p.locator('.modal button').last().click().catch(() => {});

if (ошибкиJS.length) баг('ошибки JavaScript: ' + JSON.stringify(ошибкиJS.slice(0, 3)));
else норм('ошибок JavaScript нет');

await browser.close();
console.log('\nИТОГО НАЙДЕНО: ' + найдено.length);
найдено.forEach((x, i) => console.log((i + 1) + '. ' + x));
if (найдено.length === 0) console.log('\nВСЁ ПРОЙДЕНО');
process.exit(найдено.length === 0 ? 0 : 1);
