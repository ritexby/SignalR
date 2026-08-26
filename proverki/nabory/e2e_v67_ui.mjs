// Редактор: новые элементы добавляются мышью, сохраняются и возвращаются на своих местах.
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
      pages: [{ headingRuns: [{ text: 'Первая' }], blocks: [{ runs: [{ text: 'текст' }], ord: 0 }],
        checkboxes: [{ key: 'da', label: 'Да', required: false, ord: 1 }, { key: 'net', label: 'Нет', required: false, ord: 2 }],
        includeDynamic: false }] }) });
});
await p.reload();
await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
await отказатьсяОтЧерновика(p);
await p.click('.tab[data-tab="document"]');
await p.waitForSelector('[data-panel="document"]:not(.hidden)', { timeout: 4000 });
await p.waitForTimeout(500);

// ---------- 1. Поле ввода ----------
await p.locator('[data-role="pagecard"] .insert-chip').last().click();
await p.waitForTimeout(200);
await p.locator('.insert-bar button', { hasText: 'Поле ввода' }).first().click();
await p.waitForTimeout(200);
ok(await p.locator('[data-role="pagecard"] [data-role="inputrow"]').count() === 1, 'поле ввода добавлено');
await p.locator('[data-role="inplabel"]').fill('Телефон');
await p.locator('[data-role="inptype"]').selectOption('phone');
await p.locator('[data-role="inpreq"]').check();
await p.waitForTimeout(300);

// ---------- 2. Таблица ----------
await p.locator('[data-role="pagecard"] .insert-chip').last().click();
await p.waitForTimeout(200);
await p.locator('.insert-bar button', { hasText: 'Таблица' }).first().click();
await p.waitForTimeout(300);
ok(await p.locator('[data-role="pagecard"] [data-role="blocktable"]').count() === 1, 'таблица добавлена');
const ячейки = p.locator('[data-role="pagecard"] [data-role="blocktable"] .table-cell');
ok(await ячейки.count() === 4, 'таблица начинается с четырёх ячеек: ' + await ячейки.count());
await ячейки.nth(0).fill('Услуга');
await ячейки.nth(1).fill('Цена');
await ячейки.nth(2).fill('Приём');
await ячейки.nth(3).fill('2000');
await p.locator('[data-role="pagecard"] [data-role="blocktable"] button', { hasText: 'Строка' }).click();
await p.waitForTimeout(300);
ok(await p.locator('[data-role="pagecard"] [data-role="blocktable"] .table-cell').count() === 6, 'кнопка «Строка» добавила строку');

// ---------- 3. Черта ----------
await p.locator('[data-role="pagecard"] .insert-chip').last().click();
await p.waitForTimeout(200);
await p.locator('.insert-bar button', { hasText: 'Горизонтальная черта' }).first().click();
await p.waitForTimeout(200);
ok(await p.locator('[data-role="pagecard"] [data-special="divider"]').count() === 1, 'горизонтальная черта добавлена');

// ---------- 4. Правило взаимоисключения ----------
await p.locator('button', { hasText: 'Взаимоисключающие' }).first().click();
await p.waitForSelector('.modal:not(.hidden)', { timeout: 4000 });
const пункты = p.locator('.rule-picks input[type="checkbox"]');
ok(await пункты.count() === 2, 'в окне правила перечислены оба пункта страницы');
await пункты.nth(0).check();
await пункты.nth(1).check();
await p.locator('.modal button', { hasText: 'Добавить правило' }).click();
await p.waitForTimeout(400);
ok(await p.locator('.rule-row').count() === 1, 'правило показано строкой');
ok(/взаимоисключающие/.test(await p.locator('.rule-text').first().textContent()), 'и названо словами');

// ---------- 5. Кнопка «отметить всё» ----------
await p.locator('[data-role="checkall"]').check();

// ---------- 6. Оформление блока ----------
const первыйБлок = p.locator('[data-role="pagecard"] [data-role="blockcard"]').filter({ has: p.locator('[data-role="blockbody"]') }).first();
await первыйБлок.locator('[data-role="blockbgon"]').check();
await первыйБлок.locator('[data-role="blockpad"]').fill('12');
await первыйБлок.locator('[data-role="blocklistmode"]').selectOption('bullet');
await p.waitForTimeout(300);

// ---------- 7. Сохранение и возврат ----------
await p.click('#saveDocument');
await p.waitForTimeout(900);
let док = await get();
const стр = док.pages[0];
ok((стр.inputs || []).length === 1 && стр.inputs[0].type === 'phone' && стр.inputs[0].required,
  'поле ввода сохранилось с видом и обязательностью: ' + JSON.stringify(стр.inputs));
const таб = (стр.blocks || []).find(b => b.table);
ok(таб && таб.table.rows.length === 3 && таб.table.rows[0][0] === 'Услуга',
  'таблица сохранилась с набранным текстом: ' + JSON.stringify(таб && таб.table.rows));
ok((стр.blocks || []).some(b => b.kind === 'divider'), 'черта сохранилась');
ok((стр.checkRules || []).length === 1 && стр.checkRules[0].kind === 'exclusive',
  'правило сохранилось: ' + JSON.stringify(стр.checkRules));
ok(стр.showCheckAll === true, 'кнопка «отметить всё» сохранилась');
const текстБлок = (стр.blocks || []).find(b => b.runs && b.runs.length);
ok(текстБлок && текстБлок.bg && текстБлок.pad === 12 && текстБлок.list === 'bullet',
  'оформление блока сохранилось: ' + JSON.stringify({ bg: текстБлок && текстБлок.bg, pad: текстБлок && текстБлок.pad, list: текстБлок && текстБлок.list }));

// ---------- 8. После перезагрузки всё на месте ----------
await p.reload();
await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
await отказатьсяОтЧерновика(p);
await p.click('.tab[data-tab="document"]');
await p.waitForSelector('[data-panel="document"]:not(.hidden)', { timeout: 4000 });
await p.waitForTimeout(500);
ok(await p.locator('[data-role="pagecard"] [data-role="inputrow"]').count() === 1, 'поле ввода вернулось после перезагрузки');
ok(await p.locator('[data-role="inptype"]').inputValue() === 'phone', 'с тем же видом значения');
ok(await p.locator('[data-role="pagecard"] [data-role="blocktable"] .table-cell').count() === 6, 'таблица вернулась целиком');
ok(await p.locator('[data-role="pagecard"] [data-special="divider"]').count() === 1, 'черта вернулась');
ok(await p.locator('.rule-row').count() === 1, 'правило вернулось');
ok(await p.locator('[data-role="checkall"]').isChecked(), 'кнопка «отметить всё» вернулась отмеченной');
ok(await p.locator('[data-role="pagecard"] [data-role="blockcard"]').filter({ has: p.locator('[data-role="blockbody"]') }).first().locator('[data-role="blocklistmode"]').inputValue() === 'bullet',
  'список вернулся в панели оформления');

// ---------- 9. Повторное сохранение ничего не теряет ----------
await p.click('#saveDocument');
await p.waitForTimeout(800);
док = await get();
ok((док.pages[0].inputs || []).length === 1 && (док.pages[0].checkRules || []).length === 1,
  'второе сохранение подряд ничего не потеряло');

await browser.close();
if (fail === 0) console.log('\nВСЁ ПРОЙДЕНО');
process.exit(fail ? 1 : 0);
