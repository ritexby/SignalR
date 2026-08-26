// Прожектор условий: оператор задаёт тестовые значения, и невидимое клиенту гаснет на месте.
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
const p = await (await browser.newContext({ viewport: { width: 1400, height: 1200 } })).newPage();
p.on('pageerror', e => { console.error('FAIL ошибка в админке: ' + e.message); fail++; });
await p.goto(BASE + '/admin/');
await p.fill('#password', 'test123');
await p.click('#loginForm button[type=submit]');
await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
await отказатьсяОтЧерновика(p);

await p.evaluate(async () => {
  await fetch('/api/admin/document', { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Проба', signPrompt: 'Подпись', thankYouText: 'Спасибо', idleReturnSec: 0,
      pages: [
        { headingRuns: [{ text: 'Общая' }],
          blocks: [
            { runs: [{ text: 'ВИДЕН ВСЕГДА' }], ord: 0 },
            { runs: [{ text: 'ТОЛЬКО ЖЕНЩИНАМ' }], visibleWhen: { field: 'Пол', op: 'eq', value: 'Ж' }, ord: 1 }
          ],
          checkboxes: [], includeDynamic: false },
        { headingRuns: [{ text: 'Только мужчинам' }],
          blocks: [{ runs: [{ text: 'МУЖСКАЯ СТРАНИЦА' }], ord: 0 }],
          visibleWhen: { field: 'Пол', op: 'eq', value: 'М' },
          checkboxes: [], includeDynamic: false },
        { headingRuns: [{ text: 'Опустеет' }],
          blocks: [{ runs: [{ text: 'ЕДИНСТВЕННЫЙ БЛОК' }], visibleWhen: { field: 'Пол', op: 'eq', value: 'Х' }, ord: 0 }],
          checkboxes: [], includeDynamic: false }
      ] }) });
});
await p.reload();
await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
await отказатьсяОтЧерновика(p);
await p.click('.tab[data-tab="document"]');
await p.waitForSelector('[data-panel="document"]:not(.hidden)', { timeout: 4000 });
await p.waitForTimeout(500);

// ---------- 1. Панель есть и по умолчанию выключена ----------
ok(await p.locator('.spotlight').count() === 1, 'панель прожектора показана над страницами');
ok(!(await p.locator('.spotlight-fields').isVisible()), 'поля значений скрыты, пока прожектор выключен');
ok(await p.locator('.spot-off').count() === 0, 'ничего не погашено при выключенном прожекторе');

// ---------- 2. Включаем ----------
await p.locator('[data-role="spoton"]').check();
await p.waitForTimeout(500);
ok(await p.locator('.spotlight-fields').isVisible(), 'поля значений появились');
const поля = await p.locator('.spotlight-fields .field-sm').allTextContents();
ok(поля.some(t => /Пол/.test(t)), 'тег из условий предложен для задания: ' + JSON.stringify(поля));

// ---------- 3. Задаём Пол = Ж ----------
const поле = p.locator('.spotlight-fields .field-sm', { hasText: 'Пол' }).locator('input, select').first();
await поле.fill('Ж');
await p.waitForTimeout(600);
const состояние = () => p.evaluate(() => {
  const карт = Array.from(document.querySelectorAll('#pagesEditor [data-role="pagecard"]'));
  return карт.map(c => ({
    заголовок: (c.querySelector('[data-role="heading"]') || {}).textContent || '',
    погашена: c.classList.contains('spot-off'),
    пустая: c.classList.contains('spot-empty'),
    // Текст берётся из самого редактора блока: textContent карточки начинается с подписей
    // кнопок переключения вида, и по нему блок не узнать.
    элементы: Array.from(c.querySelectorAll('[data-role="itemlist"] > .page-item'))
      .map(n => {
        const ed = n.querySelector('[data-role="blockbody"], [data-role="cblabel"]');
        return { текст: ((ed || n).textContent || '').replace(/\s+/g, ' ').trim().slice(0, 30), off: n.classList.contains('spot-off') };
      })
  }));
});
let с = await состояние();
ok(с[0] && !с[0].погашена, 'общая страница видна');
ok(с[0].элементы.some(e => /ВИДЕН ВСЕГДА/.test(e.текст) && !e.off), 'безусловный блок не погашен');
ok(с[0].элементы.some(e => /ТОЛЬКО ЖЕНЩИНАМ/.test(e.текст) && !e.off), 'женский блок виден при Пол=Ж');
ok(с[1] && с[1].погашена, 'мужская страница погашена при Пол=Ж');
ok(с[2] && с[2].пустая, 'страница, от которой ничего не осталось, помечена как пустая');

// ---------- 4. Меняем на М ----------
await поле.fill('М');
await p.waitForTimeout(600);
с = await состояние();
ok(с[0].элементы.some(e => /ТОЛЬКО ЖЕНЩИНАМ/.test(e.текст) && e.off), 'женский блок погас при Пол=М');
ok(с[1] && !с[1].погашена, 'мужская страница зажглась');

// ---------- 5. Сброс ----------
await p.locator('.spotlight button', { hasText: 'Сбросить' }).click();
await p.waitForTimeout(600);
с = await состояние();
ok(с[1].погашена, 'после сброса условная страница снова погашена: значений нет');

// ---------- 6. Выключение ----------
await p.locator('[data-role="spoton"]').uncheck();
await p.waitForTimeout(400);
ok(await p.locator('.spot-off').count() === 0, 'выключенный прожектор ничего не гасит');

// ---------- 7. Прожектор ничего не сломал в документе ----------
await p.click('#saveDocument');
await p.waitForTimeout(800);
const док = await p.evaluate(async () => (await fetch('/api/admin/document', { credentials: 'same-origin' })).json());
ok((док.pages || []).length === 3, 'страницы на месте: ' + (док.pages || []).length);
ok(док.pages[1].visibleWhen && док.pages[1].visibleWhen.value === 'М', 'условия не изменились');
const тексты = JSON.stringify(док);
ok(/ВИДЕН ВСЕГДА/.test(тексты) && /ТОЛЬКО ЖЕНЩИНАМ/.test(тексты) && /ЕДИНСТВЕННЫЙ БЛОК/.test(тексты),
  'ни один блок не потерялся: прожектор только смотрит');

await browser.close();
if (fail === 0) console.log('\nВСЁ ПРОЙДЕНО');
process.exit(fail ? 1 : 0);
