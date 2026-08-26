// Оформление текста и новые условия в редакторе: маркер, свой размер, условия по часам сервера,
// колонтитул PDF. Проверяется путь мышью: выделил, нажал, сохранил, вернулось.
import { chromium } from 'playwright';
async function отказатьсяОтЧерновика(page) {
  const btn = page.locator('.modal button', { hasText: 'Отказаться от черновика' });
  try { await btn.waitFor({ state: 'visible', timeout: 2500 }); } catch { return; }
  await btn.click();
  await page.waitForTimeout(200);
}
const BASE = 'http://127.0.0.1:5080';
// Путь к браузеру берётся из окружения: на другой машине он другой, а зашитый путь
// превращал набор в неработающий у всех, кроме одной установки. Пусто значит
// «пусть Playwright возьмёт свой», как он и делает по умолчанию.
const EXE = process.env.SK_CHROME || undefined;
let fail = 0;
const ok = (c, m) => { if (c) console.log('PASS', m); else { console.error('FAIL', m); fail++; } };

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const p = await (await browser.newContext({ viewport: { width: 1400, height: 1100 } })).newPage();
p.on('pageerror', e => { console.error('FAIL ошибка в админке: ' + e.message); fail++; });
await p.goto(BASE + '/admin/');
await p.fill('#password', 'test123');
await p.click('#loginForm button[type=submit]');
await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
await отказатьсяОтЧерновика(p);

const get = () => p.evaluate(async () => (await fetch('/api/admin/document', { credentials: 'same-origin' })).json());
await p.evaluate(async () => {
  await fetch('/api/admin/document', { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Проба', signPrompt: 'Подпись', thankYouText: 'Спасибо', idleReturnSec: 0,
      pages: [{ headingRuns: [{ text: 'Первая' }], blocks: [{ runs: [{ text: 'ВАЖНОЕ слово в тексте' }], ord: 0 }],
        checkboxes: [], includeDynamic: false }] }) });
});
await p.reload();
await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
await отказатьсяОтЧерновика(p);
await p.click('.tab[data-tab="document"]');
await p.waitForSelector('[data-panel="document"]:not(.hidden)', { timeout: 4000 });
await p.waitForTimeout(500);

// ---------- 1. Маркер ----------
const ред = p.locator('[data-role="pagecard"] [data-role="blockbody"]').first();
await ред.click();
// Выделяем слово «ВАЖНОЕ»: ставим выделение через диапазон, как это делает двойное нажатие.
await p.evaluate(() => {
  const ed = document.querySelector('[data-role="pagecard"] [data-role="blockbody"]');
  const узел = ed.firstChild.nodeType === 3 ? ed.firstChild : ed.querySelector('span').firstChild;
  const r = document.createRange();
  r.setStart(узел, 0); r.setEnd(узел, 6);
  const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
});
await p.waitForSelector('[data-role="rtbar"]', { timeout: 4000 });
await p.locator('.rt-swatch-mark').first().click();
await p.waitForTimeout(400);
await p.click('#saveDocument');
await p.waitForTimeout(800);
let док = await get();
let куски = док.pages[0].blocks[0].runs;
const сМаркером = куски.find(r => r.mark);
ok(сМаркером && /ВАЖНОЕ/.test(сМаркером.text), 'выделенное маркером сохранилось: ' + JSON.stringify(куски));
ok(/^#[0-9a-f]{6}$/i.test(сМаркером ? сМаркером.mark : ''), 'цвет маркера записан: ' + (сМаркером || {}).mark);

// ---------- 2. Свой размер ----------
await p.evaluate(() => {
  const ed = document.querySelector('[data-role="pagecard"] [data-role="blockbody"]');
  const узлы = [];
  (function ходить(n) { for (const c of n.childNodes) { if (c.nodeType === 3) узлы.push(c); else ходить(c); } })(ed);
  const хвост = узлы[узлы.length - 1];
  const r = document.createRange();
  r.setStart(хвост, 0); r.setEnd(хвост, Math.min(6, хвост.nodeValue.length));
  const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
});
await p.waitForTimeout(200);
await p.locator('.rt-pt input').fill('22');
await p.locator('.rt-pt input').press('Enter');
await p.evaluate(() => document.querySelector('.rt-pt input').dispatchEvent(new Event('change', { bubbles: true })));
await p.waitForTimeout(400);
await p.click('#saveDocument');
await p.waitForTimeout(800);
док = await get();
куски = док.pages[0].blocks[0].runs;
ok(куски.some(r => r.sizePt === 22), 'свой размер 22 пункта сохранился: ' + JSON.stringify(куски.map(r => ({ t: r.text.slice(0, 8), pt: r.sizePt }))));
ok(куски.some(r => r.mark), 'маркер при этом не потерялся');

// ---------- 3. Условие по дню недели ----------
await p.locator('[data-role="pagecard"] [data-role="blockcond"] .cond-badge').first().click();
await p.waitForTimeout(300);
const строка = p.locator('[data-role="pagecard"] [data-role="blockcond"] [data-role="crow"]').first();
await строка.locator('[data-role="cop"]').selectOption('dow');
await p.waitForTimeout(300);
ok(await строка.locator('[data-role="clocknote"]').count() === 1, 'у условия по дню недели вместо тега стоит пометка «по часам сервера»');
ok(!(await строка.locator('[data-role="cfieldsel"]').isVisible()), 'список тегов при этом скрыт');
await строка.locator('[data-role="cval"]').fill('1,2,3,4,5');
await p.waitForTimeout(300);
await p.click('#saveDocument');
await p.waitForTimeout(800);
док = await get();
const усл = док.pages[0].blocks[0].visibleWhen;
ok(усл && усл.op === 'dow' && усл.value === '1,2,3,4,5', 'условие по дню недели сохранилось: ' + JSON.stringify(усл));
ok(усл && усл.field === '@сегодня', 'поле служебное, а не тег: ' + (усл || {}).field);

// ---------- 4. Свёрнутая строка называет условие словами ----------
await p.waitForTimeout(300);
const текстУсл = await p.locator('[data-role="pagecard"] [data-role="blockcond"] .cond-badge').first().textContent();
ok(/пн/.test(текстУсл) && /пт/.test(текстУсл), 'дни недели названы словами: ' + текстУсл.trim());

// ---------- 5. Колонтитул PDF ----------
await p.locator('button', { hasText: 'PDF' }).first().click();
await p.waitForSelector('.pdfl-footer', { timeout: 8000 });
ok(await p.locator('.pdfl-footer input[type="checkbox"]').count() === 4, 'в окне PDF четыре настройки колонтитула');
await p.locator('[data-role="pdf-pdfPageNumbers"]').check();
await p.locator('[data-role="pdf-pdfFooterBarcode"]').check();
await p.locator('.modal button', { hasText: 'Применить' }).click();
await p.waitForTimeout(500);
await p.click('#saveDocument');
await p.waitForTimeout(800);
док = await get();
ok(док.pdfPageNumbers === true && док.pdfFooterBarcode === true,
  'настройки колонтитула сохранились: ' + JSON.stringify({ н: док.pdfPageNumbers, ш: док.pdfFooterBarcode }));
ok(док.pdfFooterTitle !== true, 'а неотмеченная осталась выключенной');

// ---------- 6. Всё вернулось после перезагрузки ----------
await p.reload();
await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
await отказатьсяОтЧерновика(p);
await p.click('.tab[data-tab="document"]');
await p.waitForSelector('[data-panel="document"]:not(.hidden)', { timeout: 4000 });
await p.waitForTimeout(500);
const разметка = await p.locator('[data-role="pagecard"] [data-role="blockbody"]').first().innerHTML();
ok(/background-color/.test(разметка), 'маркер вернулся в редактор: ' + разметка.slice(0, 120));
ok(/22pt|font-size/.test(разметка), 'свой размер вернулся в редактор');

await browser.close();
if (fail === 0) console.log('\nВСЁ ПРОЙДЕНО');
process.exit(fail ? 1 : 0);
