// Библиотека в редакторе: переключение между документами, свой черновик у каждого, вопрос при
// переключении с несохранёнными правками, импорт новым документом.
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
const p = await (await browser.newContext({ viewport: { width: 1400, height: 1100 } })).newPage();
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
  body: JSON.stringify({ title: 'СОГЛАСИЕ', signPrompt: 'Подпись', thankYouText: 'Спасибо', idleReturnSec: 0,
    pages: [{ headingRuns: [{ text: 'Согласие' }], blocks: [{ runs: [{ text: 'ТЕКСТ СОГЛАСИЯ' }], ord: 0 }], checkboxes: [], includeDynamic: false }] }) });

await p.reload();
await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
await отказатьсяОтЧерновика(p);
await p.click('.tab[data-tab="document"]');
await p.waitForSelector('[data-panel="document"]:not(.hidden)', { timeout: 4000 });
await p.waitForSelector('[data-role="doctab"]', { timeout: 5000 });
await p.waitForTimeout(400);

// ---------- 1. Переключатель ----------
ok(await p.locator('[data-role="doctab"]').count() === 1, 'закладка документа одна');
ok(await p.locator('[data-role="doctab"]').first().locator('.doc-tab-mark').count() === 1,
  'и он помечен значком основного');
ok(await p.inputValue('#docTitle') === 'СОГЛАСИЕ', 'открыт документ по умолчанию');

// ---------- 2. Новый документ ----------
await p.locator('.doc-tab-add').click();
await p.waitForSelector('.modal:not(.hidden)', { timeout: 4000 });
await p.locator('.modal input').first().fill('DOGOVOR');
await p.locator('.modal input').nth(1).fill('Договор услуг');
await p.locator('.modal button', { hasText: 'Завести' }).click();
await p.waitForTimeout(900);
ok(await p.locator('[data-role="doctab"]').count() === 2, 'закладок стало две');
const выбран = await p.locator('.doc-tab.on').textContent();
// На закладке стоит название документа, а не его код: код это имя для внешней системы и
// живёт в подсказке.
ok(/Договор услуг/.test(выбран), 'новый документ сразу открыт: ' + выбран.trim());
ok(await p.inputValue('#docTitle') !== 'СОГЛАСИЕ', 'и это уже не согласие');

// Заполняем второй документ и сохраняем.
await p.fill('#docTitle', 'ДОГОВОР');
await p.click('#saveDocument');
await p.waitForTimeout(800);

// ---------- 3. Переключение туда и обратно ----------
const идентификаторы = await p.locator('[data-role="doctab"]').evaluateAll(o => o.map(x => x.getAttribute('data-id')));
const перейтиНа = (id) => p.locator('[data-role="doctab"][data-id="' + id + '"]').click();
await перейтиНа(идентификаторы[0]);
await p.waitForTimeout(800);
const чтоТам = await p.inputValue('#docTitle');
const окноТам = await p.locator('.modal:not(.hidden)').count() ? await p.locator('#modalContent').textContent() : 'окна нет';
ok(чтоТам === 'СОГЛАСИЕ', 'вернулись к первому документу: заголовок «' + чтоТам + '», ' + окноТам.replace(/\s+/g, ' ').trim().slice(0, 90));
await перейтиНа(идентификаторы[1]);
await p.waitForTimeout(800);
ok(await p.inputValue('#docTitle') === 'ДОГОВОР', 'и снова ко второму: тексты не путаются');

// ---------- 4. Несохранённые правки при переключении ----------
await p.fill('#docTitle', 'ДОГОВОР ПРАВЛЕННЫЙ');
await p.waitForTimeout(400);
await перейтиНа(идентификаторы[0]);
await p.waitForSelector('.modal:not(.hidden)', { timeout: 4000 });
const окно = await p.locator('#modalContent').textContent();
ok(/несохранённые правки/i.test(окно), 'переключение с правками спрашивает, а не теряет молча');
await p.locator('.modal button', { hasText: 'Остаться' }).click();
await p.waitForTimeout(400);
ok(await p.inputValue('#docTitle') === 'ДОГОВОР ПРАВЛЕННЫЙ', '«Остаться» оставляет на месте с правками');

await перейтиНа(идентификаторы[0]);
await p.waitForSelector('.modal:not(.hidden)', { timeout: 4000 });
await p.locator('.modal button', { hasText: 'Сохранить и перейти' }).click();
await p.waitForTimeout(1000);
ok(await p.inputValue('#docTitle') === 'СОГЛАСИЕ', '«Сохранить и перейти» переводит на первый');
const второй = (await call('/document?id=' + идентификаторы[1])).body;
ok(второй.title === 'ДОГОВОР ПРАВЛЕННЫЙ', 'и правки второго документа сохранены: ' + второй.title);

// ---------- 5. У каждого документа свой черновик ----------
await p.fill('#docTitle', 'СОГЛАСИЕ ЧЕРНОВИК');
await p.waitForTimeout(1600);   // черновик пишется с задержкой
const ключи = await p.evaluate(() => Object.keys(localStorage).filter(k => k.indexOf('sk_doc_draft') === 0));
ok(ключи.length >= 1 && ключи.every(k => k.indexOf(':') > 0),
  'черновик лежит под ключом своего документа: ' + JSON.stringify(ключи));

await перейтиНа(идентификаторы[1]);
await p.waitForSelector('.modal:not(.hidden)', { timeout: 4000 });
await p.locator('.modal button', { hasText: 'Перейти без сохранения' }).click();
await p.waitForTimeout(900);
ok(await p.inputValue('#docTitle') === 'ДОГОВОР ПРАВЛЕННЫЙ',
  'во втором документе черновик первого не предложен: ' + await p.inputValue('#docTitle'));
ok(await p.locator('.modal:not(.hidden)').count() === 0, 'и окна восстановления чужого черновика нет');

// ---------- 6. Код и название правятся ----------
await p.locator('.doc-tab.on .doc-tab-menu').click();
await p.waitForSelector('[data-role="docmenu"]', { timeout: 3000 });
await p.locator('.doc-menu .btn', { hasText: 'Код для API' }).click();
await p.waitForSelector('.modal:not(.hidden)', { timeout: 4000 });
await p.locator('.modal input').first().fill('DOGOVOR-2');
await p.locator('.modal button', { hasText: 'Сохранить' }).click();
await p.waitForTimeout(800);
const список = (await call('/documents')).body;
ok(список.some(d => d.code === 'DOGOVOR-2'), 'код документа изменён: ' + JSON.stringify(список.map(d => d.code)));

// ---------- 7. Копия ----------
await p.locator('.doc-tab.on .doc-tab-menu').click();
await p.waitForSelector('[data-role="docmenu"]', { timeout: 3000 });
await p.locator('.doc-menu .btn', { hasText: 'Создать копию' }).click();
await p.waitForSelector('.modal:not(.hidden)', { timeout: 4000 });
await p.locator('.modal input').first().fill('KOPIYA');
await p.locator('.modal input').nth(1).fill('Копия договора');
await p.locator('.modal button', { hasText: 'Завести' }).click();
await p.waitForTimeout(1000);
ok(await p.inputValue('#docTitle') === 'ДОГОВОР ПРАВЛЕННЫЙ', 'копия начинается с текста исходного документа');
ok(await p.locator('[data-role="doctab"]').count() === 3, 'в библиотеке стало три документа');

// ---------- 8. Удаление ----------
await p.locator('.doc-tab.on .doc-tab-menu').click();
await p.waitForSelector('[data-role="docmenu"]', { timeout: 3000 });
await p.locator('.doc-menu .btn', { hasText: 'Удалить документ' }).click();
await p.waitForTimeout(1000);
ok(await p.locator('[data-role="doctab"]').count() === 2, 'документ удалён, осталось два');

await browser.close();
if (fail === 0) console.log('\nВСЁ ПРОЙДЕНО');
process.exit(fail ? 1 : 0);
