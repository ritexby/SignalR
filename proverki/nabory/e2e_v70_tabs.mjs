// Закладки документов вместо выпадающего списка. Проверяется то, ради чего всё делалось:
// с одного взгляда видно, что документов несколько, в каком ты сейчас и где добавить ещё.
import { chromium } from 'playwright';
async function отказатьсяОтЧерновика(page) {
  const btn = page.locator('.modal button', { hasText: 'Отказаться от черновика' });
  try { await btn.waitFor({ state: 'visible', timeout: 2000 }); } catch { return; }
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
const p = await (await browser.newContext({ viewport: { width: 1500, height: 1000 } })).newPage();
p.on('pageerror', e => { console.error('FAIL ошибка в админке: ' + e.message); fail++; });
p.on('dialog', d => d.accept());
await p.goto(BASE + '/admin/');
await p.fill('#password', 'test123');
await p.click('#loginForm button[type=submit]');
await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
await отказатьсяОтЧерновика(p);

const call = (path, opts) => p.evaluate(async ([pa, o]) => {
  const r = await fetch('/api/admin' + pa, Object.assign({ credentials: 'same-origin' }, o || {}));
  let body = null; try { body = await r.json(); } catch { body = null; }
  return { status: r.status, body };
}, [path, opts]);

await call('/document', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ title: 'СОГЛАСИЕ', signPrompt: 'x', thankYouText: 'Спасибо', idleReturnSec: 0,
    pages: [{ headingRuns: [{ text: 'Стр' }], blocks: [{ runs: [{ text: 'т' }], ord: 0 }], includeDynamic: false }] }) });
await p.reload();
await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
await отказатьсяОтЧерновика(p);
await p.click('.tab[data-tab="document"]');
await p.waitForSelector('.doc-tab', { timeout: 5000 });
await p.waitForTimeout(500);

// ---------- 1. Один документ: закладка, плюс и подсказка ----------
ok(await p.locator('[data-role="doctab"]').count() === 1, 'одна закладка документа');
ok(await p.locator('.doc-tab-add').count() === 1, 'рядом кнопка добавления');
ok(await p.locator('.doc-tab-add').isVisible(), 'и она видна без прокрутки');
const подсказка = await p.locator('.doc-tabs-hint').textContent();
ok(/несколько/.test(подсказка || ''), 'пока документ один, подсказка объясняет, зачем плюс: ' + (подсказка || '').slice(0, 50));
ok((await p.locator('[data-role="doctab"]').first().textContent()).indexOf('СОГЛАСИЕ') >= 0,
  'на закладке заголовок документа');
ok(await p.locator('[data-role="doctab"]').first().getAttribute('aria-selected') === 'true',
  'своя закладка помечена как выбранная');

// Список тегов свёрнут и не занимает экран.
ok(await p.locator('.tags-box').count() === 1, 'справка о тегах есть');
ok(await p.evaluate(() => !document.querySelector('.tags-box').open), 'и она свёрнута');

// ---------- 2. Второй документ ----------
await p.locator('.doc-tab-add').click();
await p.waitForSelector('.modal:not(.hidden)', { timeout: 4000 });
await p.locator('.modal input').first().fill('DOGOVOR');
await p.locator('.modal button', { hasText: 'Завести' }).click();
await p.waitForTimeout(1000);
ok(await p.locator('[data-role="doctab"]').count() === 2, 'закладок стало две');
ok(await p.locator('.doc-tabs-hint').count() === 0, 'подсказка исчезла: она больше не нужна');
const выбранная = await p.locator('.doc-tab.on').textContent();
ok(/DOGOVOR/.test(выбранная), 'новый документ сразу открыт и назван как задали: ' + выбранная.trim());
// Новый документ должен быть чистым, а не копией образца: иначе человек получает чужой готовый
// текст и не понимает, откуда он взялся.
const страницНового = await p.locator('#pagesEditor [data-role="pagecard"]').count();
ok(страницНового === 1, 'новый документ начинается с одной пустой страницы (' + страницНового + ')');
ok(!/персональных данных/i.test(await p.textContent('#pagesEditor')),
  'и в нём нет чужого готового текста');

// ---------- 3. Закладка следует за заголовком, без сохранения ----------
await p.fill('#docTitle', 'ДОГОВОР УСЛУГ');
await p.waitForTimeout(300);
ok((await p.locator('.doc-tab.on .doc-tab-name').textContent()) === 'ДОГОВОР УСЛУГ',
  'закладка показывает заголовок сразу, не дожидаясь сохранения');
ok(await p.locator('.doc-tab.on .doc-tab-dot').count() === 1, 'и точка несохранённого зажглась');
await p.click('#saveDocument');
await p.waitForTimeout(900);
ok(await p.locator('.doc-tab.on .doc-tab-dot').count() === 0, 'после сохранения точка погасла');

// ---------- 4. Переключение по закладкам ----------
const первая = p.locator('[data-role="doctab"]').first();
await первая.click();
await p.waitForTimeout(900);
ok(await p.inputValue('#docTitle') === 'СОГЛАСИЕ', 'нажатие на чужую закладку переключает документ');
ok(await первая.getAttribute('aria-selected') === 'true', 'и она становится выбранной');

// ---------- 5. Значки: основной и вид ----------
ok(await p.locator('[data-role="doctab"]').first().locator('.doc-tab-mark').count() === 1,
  'у основного документа стоит значок');
ok(await p.locator('[data-role="doctab"]').nth(1).locator('.doc-tab-mark').count() === 0,
  'у обычного его нет');
ok(await p.locator('.doc-tab-kind').count() === 2, 'вид документа помечен на каждой закладке');

// ---------- 6. Меню закладки ----------
await p.locator('.doc-tab.on .doc-tab-menu').click();
await p.waitForSelector('[data-role="docmenu"]', { timeout: 3000 });
const пункты = await p.locator('.doc-menu .btn').allTextContents();
ok(пункты.length >= 3, 'меню закладки открылось: ' + JSON.stringify(пункты.map(x => x.trim())));
ok(пункты.some(x => /показ/.test(x)), 'в меню есть смена вида документа');
ok(!пункты.some(x => /Удалить/.test(x)), 'у основного документа удаления в меню нет');
const примечание = await p.locator('.doc-menu-note').textContent();
ok(/нельзя удалить/.test(примечание || ''), 'и сказано, почему: ' + (примечание || '').slice(0, 50));
await p.keyboard.press('Escape');
await p.mouse.click(10, 400);
await p.waitForTimeout(300);
ok(await p.locator('[data-role="docmenu"]').count() === 0, 'меню закрывается нажатием мимо');

// ---------- 7. Вид документа меняется из меню ----------
await p.locator('[data-role="doctab"]').nth(1).click();
await p.waitForTimeout(900);
await p.locator('.doc-tab.on .doc-tab-menu').click();
await p.waitForSelector('[data-role="docmenu"]', { timeout: 3000 });
await p.locator('.doc-menu .btn', { hasText: 'показ' }).click();
await p.waitForTimeout(1200);
ok(await p.textContent('#docHeading') === 'Документ для показа',
  'заголовок сменился вместе с видом: ' + await p.textContent('#docHeading'));
ok(/не подписывают/.test(await p.textContent('#docHint')), 'и описание тоже');
const завершающие = await p.locator('.toc-fixed').allTextContents();
ok(завершающие.length === 1 && /Спасибо/.test(завершающие[0]),
  'у документа для показа экрана подписи в оглавлении нет: ' + JSON.stringify(завершающие));
ok(/не подписывают/.test(await p.locator('.toc-fixed-note').textContent()), 'и это сказано словами');

// ---------- 8. Завершающие экраны отделены от страниц ----------
await p.locator('[data-role="doctab"]').first().click();
await p.waitForTimeout(900);
ok(await p.locator('.toc-fixed-title').count() === 1, 'у завершающих экранов свой подзаголовок');
ok((await p.locator('.toc-fixed-title').textContent()).indexOf('Завершающие') >= 0, 'и он их называет');
ok(await p.locator('.toc-fixed').count() === 2, 'для подписного документа их два: подпись и спасибо');

// ---------- 9. Кнопки собраны в группы ----------
ok(await p.locator('.toolbar-actions .tb-group').count() === 3, 'кнопки разбиты на три группы');
ok(await p.locator('.tb-group-save #saveDocument').count() === 1, 'сохранение выделено в свою группу');

// ---------- 10. Узкий экран: закладки не ломают вёрстку ----------
await p.setViewportSize({ width: 900, height: 900 });
await p.waitForTimeout(400);
const переполнение = await p.evaluate(() => {
  const r = document.querySelector('.doc-tabs');
  return { прокрутка: r.scrollWidth > r.clientWidth, высота: Math.round(r.getBoundingClientRect().height) };
});
ok(переполнение.высота < 70, 'на узком экране ряд закладок остаётся в одну строку: ' + переполнение.высота + 'px');
ok(await p.locator('.doc-tab.on').isVisible(), 'и своя закладка видна');

await browser.close();
if (fail === 0) console.log('\nВСЁ ПРОЙДЕНО');
process.exit(fail ? 1 : 0);
