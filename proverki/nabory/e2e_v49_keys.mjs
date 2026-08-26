// Имя для API у групп и вариантов. Раньше оператор вписывал «ДА» и «НЕТ», не заполнял имена, и
// варианты молча пропадали: проверка сообщала, что вариантов нет, хотя на экране их было два.
import { chromium } from 'playwright';
// После перезагрузки редактор может предложить восстановить черновик. Эти проверки про другое,
// поэтому черновик отклоняется, если он предложен.
async function отказатьсяОтЧерновика(page) {
  // Окно появляется не сразу: черновик сравнивается с документом, а тот ещё едет с сервера.
  // Проверка «есть ли окно прямо сейчас» промахивалась, окно всплывало позже и перехватывало
  // нажатия, а набор падал на «кнопка недоступна», ничего не объясняя.
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
const jsErr = []; p.on('pageerror', e => jsErr.push(e.message));
p.on('dialog', d => d.accept());
await p.goto(BASE + '/admin/');
await p.fill('#password', 'test123'); await p.click('#loginForm button[type=submit]');
await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
await отказатьсяОтЧерновика(p);

const call = (path, opts) => p.evaluate(async ([pa, o]) => {
  const r = await fetch('/api/admin' + pa, Object.assign({ credentials: 'same-origin' }, o || {}));
  let body = null; try { body = await r.json(); } catch { body = null; }
  return { status: r.status, body };
}, [path, opts]);
const put = (path, obj) => call(path, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });

await put('/document', {
  title: 'Согласие', signPrompt: 'Распишитесь', thankYouText: 'Спасибо', idleReturnSec: 0,
  pages: [{ headingRuns: [{ text: 'Страница' }], blocks: [{ runs: [{ text: 'Текст' }] }], checkboxes: [], groups: [] }],
  signBlocks: [], signBlocksBelow: []
});
await p.reload();
await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
await отказатьсяОтЧерновика(p);
await p.click('.tab[data-tab="document"]');
await p.waitForSelector('[data-role="itemlist"]', { timeout: 5000 });

// Оператор добавляет группу и вписывает только тексты, как на скриншоте.
await p.locator('[data-role="itemlist"] > .insert-bar').last().locator('.insert-chip').click();
await p.waitForTimeout(150);
await p.locator('.insert-bar.open button', { hasText: 'Двойные зависимые чекбоксы' }).first().click();
await p.waitForTimeout(200);

const grp = p.locator('[data-role="grouprow"]').first();
await grp.locator('[data-role="gtitle"]').fill('зависимый чекбокс');
await grp.locator('[data-role="olabel"]').nth(0).fill('ДА');
await grp.locator('[data-role="olabel"]').nth(1).fill('НЕТ');
await p.waitForTimeout(150);

ok(await grp.locator('[data-role="gkey"]').inputValue() === 'zavisimyy-chekboks',
  'имя группы подставилось латиницей: ' + await grp.locator('[data-role="gkey"]').inputValue());
ok(await grp.locator('[data-role="okey"]').nth(0).inputValue() === 'da',
  'имя первого варианта подставилось: ' + await grp.locator('[data-role="okey"]').nth(0).inputValue());
ok(await grp.locator('[data-role="okey"]').nth(1).inputValue() === 'net',
  'имя второго варианта подставилось: ' + await grp.locator('[data-role="okey"]').nth(1).inputValue());

// Проверка документа не должна жаловаться на то, что вариантов нет.
await p.click('#checkDoc');
await p.waitForTimeout(500);
const problems = await p.locator('.problem').allTextContents();
ok(!problems.some(t => /два варианта/.test(t)), 'проверка больше не говорит, что вариантов нет: ' + JSON.stringify(problems));
ok(!problems.some(t => /нет имени для API/.test(t)), 'и не жалуется на отсутствие имени: ' + JSON.stringify(problems));
if (await p.locator('.problems').count()) await p.click('.problems .btn-ghost');
await p.waitForTimeout(200);

await p.click('#saveDocument');
await p.waitForTimeout(700);
let doc = (await call('/document')).body;
let g = (doc.pages[0].groups || [])[0];
ok(!!g, 'группа сохранилась');
ok(g && g.key === 'zavisimyy-chekboks', 'с именем: ' + (g && g.key));
ok(g && JSON.stringify(g.options.map(o => [o.key, o.label])) === JSON.stringify([['da','ДА'],['net','НЕТ']]),
  'оба варианта на месте: ' + JSON.stringify(g && g.options));

// Имя, вписанное руками, автоподстановка не трогает.
await p.reload();
await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
await отказатьсяОтЧерновика(p);
await p.click('.tab[data-tab="document"]');
await p.waitForSelector('[data-role="grouprow"]', { timeout: 5000 });
const g2 = p.locator('[data-role="grouprow"]').first();
await g2.locator('[data-role="okey"]').nth(0).fill('my-own');
await g2.locator('[data-role="olabel"]').nth(0).fill('Разрешаю');
await p.waitForTimeout(150);
ok(await g2.locator('[data-role="okey"]').nth(0).inputValue() === 'my-own',
  'своё имя не переписывается при правке текста: ' + await g2.locator('[data-role="okey"]').nth(0).inputValue());

// Два одинаковых текста получают разные имена.
// Окно поверх страницы перехватывает нажатия, и набор падал бы на «кнопка недоступна», не
// сказав, какое именно окно мешает. Говорим это вслух.
const окно = p.locator('#modal:not(.hidden)');
if (await окно.count()) {
  console.error('FAIL поверх редактора висит окно: ' +
    (await окно.textContent()).replace(/\s+/g, ' ').trim());
}
await g2.locator('button', { hasText: 'Вариант' }).click();
await p.waitForTimeout(150);
await g2.locator('[data-role="olabel"]').nth(2).fill('НЕТ');
await p.waitForTimeout(150);
ok(await g2.locator('[data-role="okey"]').nth(2).inputValue() === 'net-2',
  'одинаковые тексты получают разные имена: ' + await g2.locator('[data-role="okey"]').nth(2).inputValue());

ok(jsErr.length === 0, 'ошибок JavaScript нет: ' + jsErr.join(' | '));
await browser.close();
console.log(fail === 0 ? '\nВСЁ ПРОЙДЕНО' : '\n' + fail + ' ПРОВЕРОК УПАЛО');
process.exit(fail === 0 ? 0 : 1);
