// Поведение оператора в конструкторе документа, смоделированное как есть.
// 1) Добавил элемент и сразу сохранил: пустая заготовка выбрасывается со словами, а не молча.
// 2) Недоделанный элемент, где уже есть условие, при сохранении не пропадает.
// 3) Две открытые админки не затирают друг друга молча: вторая получает выбор.
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

async function войти(ctx) {
  const p = await ctx.newPage();
  p.on('pageerror', e => { console.error('FAIL ошибка на странице: ' + e.message); fail++; });
  await p.goto(BASE + '/admin/');
  await p.fill('#password', 'test123');
  await p.click('#loginForm button[type=submit]');
  await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
  await отказатьсяОтЧерновика(p);
  return p;
}
const admin = await войти(await browser.newContext());
const put = (obj) => admin.evaluate(async (d) => (await fetch('/api/admin/document', { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(d) })).status, obj);
const get = () => admin.evaluate(async () => (await fetch('/api/admin/document', { credentials: 'same-origin' })).json());

await put({
  title: 'Согласие', signPrompt: 'Подпись', thankYouText: 'Спасибо', idleReturnSec: 0,
  pages: [{ headingRuns: [{ text: 'Первая' }], blocks: [{ runs: [{ text: 'текст' }], ord: 0 }], checkboxes: [], includeDynamic: false }]
});
await admin.reload();
await admin.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
await отказатьсяОтЧерновика(admin);
await admin.click('.tab[data-tab="document"]');
await admin.waitForSelector('[data-panel="document"]:not(.hidden)', { timeout: 4000 });
await admin.waitForTimeout(400);

// ---------- 1. Пустая заготовка: выброшена со словами ----------
// «+ элемент» открывает выбор; добавляем поле подписи и сразу сохраняем.
await admin.locator('.insert-chip').last().click();
await admin.waitForTimeout(200);
await admin.locator('button', { hasText: 'Поле подписи' }).first().click();
await admin.waitForTimeout(200);
ok(await admin.locator('[data-role="signrow"]').count() === 1, 'поле подписи добавлено на страницу');
await admin.click('#saveDocument');
await admin.waitForTimeout(700);
const тексты = await admin.evaluate(() => Array.from(document.querySelectorAll('.toast, .toast-warn')).map(t => t.textContent).join(' | '));
ok(/Пустых заготовок не сохранено: 1/.test(тексты) && /Документ сохранён/.test(тексты),
  'сохранение сказало вслух и про успех, и про выброшенную заготовку: ' + тексты.slice(0, 140));
let док = await get();
ok(((док.pages[0] || {}).signatures || []).length === 0, 'пустая заготовка в документ не попала');

// ---------- 2. Недоделанный элемент с условием переживает сохранение ----------
await admin.reload();
await admin.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
await отказатьсяОтЧерновика(admin);
await admin.click('.tab[data-tab="document"]');
await admin.waitForSelector('[data-panel="document"]:not(.hidden)', { timeout: 4000 });
await admin.waitForTimeout(400);
await admin.locator('.insert-chip').last().click();
await admin.waitForTimeout(200);
await admin.locator('button', { hasText: 'Поле подписи' }).first().click();
await admin.waitForTimeout(200);
// Задаём только условие, подпись и имя оставляем пустыми.
const строкаПодписи = admin.locator('[data-role="signrow"]').first();
await строкаПодписи.locator('.cond-badge').click();
await admin.waitForTimeout(200);
const рядУсловия = строкаПодписи.locator('[data-role="crow"]').first();
await рядУсловия.locator('[data-role="cfieldsel"]').selectOption({ label: 'Пол' });
await admin.waitForTimeout(300);
await admin.click('#saveDocument');
await admin.waitForTimeout(700);
док = await get();
const поля = (док.pages[0] || {}).signatures || [];
ok(поля.length === 1 && поля[0].visibleWhen && поля[0].visibleWhen.field === 'Пол',
  'поле с условием, но без имени сохранилось: недоделанное не выбрасывается');

// ---------- 3. Две админки: сверка версий ----------
const другая = await войти(await browser.newContext());
await другая.click('.tab[data-tab="document"]');
await другая.waitForSelector('[data-panel="document"]:not(.hidden)', { timeout: 4000 });
await другая.waitForTimeout(400);

// Первая меняет заголовок и сохраняет.
await admin.fill('#docTitle', 'Согласие ПЕРВОЙ АДМИНКИ');
await admin.click('#saveDocument');
await admin.waitForTimeout(700);

// Вторая, не перезагружаясь, меняет своё и сохраняет: должен быть выбор, а не молчаливая перезапись.
await другая.fill('#docTitle', 'Согласие ВТОРОЙ АДМИНКИ');
await другая.click('#saveDocument');
await другая.waitForSelector('.modal:not(.hidden)', { timeout: 6000 });
const окно = await другая.locator('#modalContent').textContent();
ok(/изменён в другом окне/.test(окно), 'вторая админка получила выбор, а не молчаливую перезапись: ' + окно.trim().slice(0, 80));
док = await get();
ok(док.title === 'Согласие ПЕРВОЙ АДМИНКИ', 'работа первой админки не затёрта');

// «Взять свежий»: правки второй остаются в черновике.
await другая.locator('.modal button', { hasText: 'Взять свежий' }).click();
await другая.waitForTimeout(800);
ok(await другая.inputValue('#docTitle') === 'Согласие ПЕРВОЙ АДМИНКИ', 'вторая админка увидела свежую версию');

// «Сохранить поверх»: осознанный выбор работает.
await другая.fill('#docTitle', 'Согласие ПОВЕРХ');
await другая.click('#saveDocument');
await другая.waitForSelector('.modal:not(.hidden)', { timeout: 6000 }).catch(() => {});
const естьОкно = await другая.locator('.modal:not(.hidden)').count();
if (естьОкно) {
  await другая.locator('.modal button', { hasText: 'поверх' }).click();
  await другая.waitForTimeout(700);
}
док = await get();
ok(док.title === 'Согласие ПОВЕРХ', 'осознанное «сохранить поверх» работает: ' + док.title);

// Обычное сохранение после этого не даёт ложного отказа.
await другая.fill('#docTitle', 'Согласие ИТОГ');
await другая.click('#saveDocument');
await другая.waitForTimeout(700);
док = await get();
ok(док.title === 'Согласие ИТОГ', 'следующее обычное сохранение прошло без ложного отказа');

await browser.close();
if (fail === 0) console.log('\nВСЁ ПРОЙДЕНО');
process.exit(fail ? 1 : 0);
