// Редактор документа: перетаскивание, сворачивание страниц, оглавление, свёрнутое условие
// и проверка документа. Главное здесь не внешний вид, а то, что порядок и содержимое
// действительно сохраняются: редактор собирает документ из DOM, и любая перестановка узлов
// обязана доехать до сервера ровно в том виде, в каком её увидел оператор.
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

const page = (n, blocks) => ({
  headingRuns: [{ text: 'Страница ' + n }],
  blocks: blocks.map(t => ({ runs: [{ text: t }] })),
  checkboxes: [{ key: 'cb' + n, label: 'Пункт ' + n, required: true, checked: false }],
  groups: []
});

await put('/document', {
  title: 'Согласие', signPrompt: 'Распишитесь', thankYouText: 'Спасибо', idleReturnSec: 0,
  pages: [page('A', ['БЛОК-1', 'БЛОК-2']), page('B', ['Б-один']), page('C', ['В-один'])],
  signBlocks: [], signBlocksBelow: []
});
await p.reload();
await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
await отказатьсяОтЧерновика(p);
await p.click('.tab[data-tab="document"]');
await p.waitForSelector('[data-role="pagecard"]', { timeout: 5000 });

// ---------- Оглавление ----------
ok(await p.locator('.doc-toc').isVisible(), 'оглавление видно на широком экране');
const toc = await p.locator('.toc-item').allTextContents();
ok(toc.length === 3, 'в оглавлении столько же пунктов, сколько страниц: ' + toc.length);
ok(/Страница A/.test(toc[0]) && /Страница C/.test(toc[2]), 'пункты названы по заголовкам: ' + JSON.stringify(toc));
const fixed = (await p.locator('.toc-fixed').allTextContents()).map(t => t.trim());
ok(fixed.join(',') === 'Подпись,Спасибо', 'экраны подписи и благодарности тоже перечислены: ' + JSON.stringify(fixed));

// ---------- Сворачивание ----------
const firstCard = p.locator('[data-role="pagecard"]').first();
ok(await firstCard.locator('.page-body').isVisible(), 'страница развёрнута по умолчанию');
ok((await firstCard.locator('.page-toggle:not(.item-toggle)').getAttribute('title')).includes('Свернуть'), 'кнопка предлагает свернуть');

await firstCard.locator('.page-toggle:not(.item-toggle)').click();
await p.waitForTimeout(150);
ok(!(await firstCard.locator('.page-body').isVisible()), 'содержимое страницы скрылось');
ok((await firstCard.locator('.page-toggle:not(.item-toggle)').getAttribute('title')).includes('Развернуть'), 'кнопка предлагает развернуть');
ok(await firstCard.evaluate(e => e.classList.contains('collapsed')), 'свёрнутая страница помечена отдельно');
const summary = await firstCard.locator('.page-summary').textContent();
ok(/Страница A/.test(summary) && /блоков: 2/.test(summary),
  'вместо содержимого показана сводка: ' + summary);

// Свёрнутая страница не должна потерять содержимое при сохранении.
await p.click('#saveDocument');
await p.waitForTimeout(700);
let doc = (await call('/document')).body;
ok((doc.pages || []).length === 3, 'все три страницы на месте после сохранения со свёрнутой');
ok(JSON.stringify(doc.pages[0]).includes('БЛОК-1'), 'содержимое свёрнутой страницы не потерялось');

await firstCard.locator('.page-toggle:not(.item-toggle)').click();
await p.waitForTimeout(150);
ok(await firstCard.locator('.page-body').isVisible(), 'страница разворачивается обратно');

// «Свернуть все» и «Развернуть все».
await p.locator('.toc-actions button', { hasText: 'Свернуть все' }).click();
await p.waitForTimeout(200);
ok(await p.locator('[data-role="pagecard"].collapsed').count() === 3, 'свернулись все страницы');
await p.locator('.toc-actions button', { hasText: 'Развернуть все' }).click();
await p.waitForTimeout(200);
ok(await p.locator('[data-role="pagecard"].collapsed').count() === 0, 'развернулись все страницы');

// ---------- Условие свёрнуто в значок ----------
const firstBlockCond = p.locator('.block-card').first().locator('.cond-box');
ok(await firstBlockCond.locator('.cond-badge').isVisible(), 'условие показано значком, а не тремя списками');
ok(!(await firstBlockCond.locator('.cond-fields').isVisible()), 'поля условия скрыты, пока их не открыли');
ok((await firstBlockCond.locator('.cond-badge').textContent()).includes('условие'),
  'значок предлагает добавить условие');

await firstBlockCond.locator('.cond-badge').click();
await p.waitForTimeout(150);
ok(await firstBlockCond.locator('.cond-fields').isVisible(), 'по нажатию поля открываются');
ok(await firstBlockCond.locator('select.cond-mode').inputValue() === 'cond',
  'и сразу переключаются в режим условия, а не оставляют «Показывать всегда»');

await firstBlockCond.locator('select[data-role="cfieldsel"]').selectOption('Пол');
await firstBlockCond.locator('select[data-role="cvalsel"]').selectOption('F');
await p.click('#saveDocument');
await p.waitForTimeout(700);
doc = (await call('/document')).body;
ok(doc.pages[0].blocks[0].visibleWhen && doc.pages[0].blocks[0].visibleWhen.value === 'F',
  'условие, заданное через значок, сохраняется: ' + JSON.stringify(doc.pages[0].blocks[0].visibleWhen));

await p.reload();
await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
await отказатьсяОтЧерновика(p);
await p.click('.tab[data-tab="document"]');
await p.waitForSelector('[data-role="pagecard"]', { timeout: 5000 });
const savedBadge = await p.locator('.block-card').first().locator('.cond-badge').textContent();
ok(/Пол/.test(savedBadge) && /Ж/.test(savedBadge), 'сохранённое условие читается прямо со значка: ' + savedBadge);

// ---------- Перетаскивание страниц ----------
ok(await p.locator('[data-role="pagecard"] .drag-handle').first().isVisible(), 'у страницы есть ручка');

async function dragTo(handle, target) {
  const h = await handle.boundingBox();
  const t = await target.boundingBox();
  await p.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await p.mouse.down();
  // Несколько шагов: браузеру нужно отличить перетаскивание от щелчка.
  await p.mouse.move(t.x + t.width / 2, t.y + t.height / 2, { steps: 15 });
  await p.mouse.move(t.x + t.width / 2, t.y + t.height / 2 + 6, { steps: 5 });
  await p.mouse.up();
  await p.waitForTimeout(300);
}

const before = (await call('/document')).body.pages.map(x => x.headingRuns[0].text);
await dragTo(p.locator('#pagesEditor > [data-role="pagecard"]').first().locator('.drag-handle').first(),
             p.locator('#pagesEditor > [data-role="pagecard"]').nth(2));
await p.click('#saveDocument');
await p.waitForTimeout(700);
const after = (await call('/document')).body.pages.map(x => x.headingRuns[0].text);
ok(after.length === 3, 'после перетаскивания страниц по-прежнему три');
ok(JSON.stringify(after) !== JSON.stringify(before), 'порядок страниц изменился: ' + JSON.stringify(after));
ok(after.slice().sort().join() === before.slice().sort().join(), 'и ни одна страница не потерялась');

// ---------- Проверка документа ----------
// Недоделанную группу нельзя завести через API: сервер такую не хранит, и правильно делает.
// Поэтому она создаётся так же, как это сделал бы оператор, прямо в редакторе.
await put('/document', {
  title: 'Согласие', signPrompt: 'Распишитесь', thankYouText: 'Спасибо', idleReturnSec: 0,
  pages: [{
    headingRuns: [{ text: 'Проблемная' }],
    blocks: [
      { runs: [{ text: 'Текст с {{неизвестныйТег}}' }] },
      { runs: [{ text: 'Условие в никуда' }], visibleWhen: { field: 'нетТакого', op: 'eq', value: 'x' } }
    ],
    checkboxes: [{ key: 'dup', label: 'Первый', required: true }, { key: 'dup', label: 'Второй', required: true }],
    groups: []
  }],
  signBlocks: [], signBlocksBelow: []
});
await p.reload();
await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
await отказатьсяОтЧерновика(p);
await p.click('.tab[data-tab="document"]');
await p.waitForSelector('[data-role="pagecard"]', { timeout: 5000 });

// Оператор завёл группу, заполнил один вариант и на этом остановился.
// Добавление идёт через полосу вставки: она позволяет поставить элемент в нужное место,
// а не только в конец страницы.
await p.locator('[data-role="itemlist"] > .insert-bar').last().locator('.insert-chip').click();
await p.waitForTimeout(150);
await p.locator('.insert-bar.open button', { hasText: 'Двойные зависимые чекбоксы' }).first().click();
await p.waitForTimeout(200);
// Заголовок не вписан, поэтому имя для API подставить не из чего: ровно та недоделанная
// группа, о которой проверка и должна сказать. Один вариант заполнен, второго нет.
await p.locator('[data-role="grouprow"]').first().locator('[data-role="olabel"]').first().fill('Единственный');
await p.waitForTimeout(150);

await p.click('#checkDoc');
await p.waitForSelector('.problems', { timeout: 4000 });
const found = (await p.locator('.problem').allTextContents()).join(' | ');
ok(/нетТакого/.test(found), 'найдено условие на несуществующее имя');
ok(/неизвестныйТег/.test(found), 'найден тег с опечаткой');
ok(/dup/.test(found), 'найдено повторяющееся имя чекбокса');
ok(/нет имени для API/.test(found), 'найдена группа без имени: ' + found);
ok(/два варианта/.test(found), 'найдена группа без вариантов');
ok(await p.locator('.problem-error').count() >= 3, 'ошибки отделены от предупреждений');
await p.click('.problems .btn-ghost');
await p.waitForTimeout(200);

// Чистый документ не должен ни на что жаловаться.
await put('/document', {
  title: 'Согласие', signPrompt: 'Распишитесь', thankYouText: 'Спасибо', idleReturnSec: 0,
  pages: [{ headingRuns: [{ text: 'Чистая' }], blocks: [{ runs: [{ text: 'Текст' }] }],
    checkboxes: [{ key: 'ok1', label: 'Согласен', required: true }], groups: [] }],
  signBlocks: [], signBlocksBelow: []
});
await p.reload();
await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
await отказатьсяОтЧерновика(p);
await p.click('.tab[data-tab="document"]');
await p.waitForSelector('[data-role="pagecard"]', { timeout: 5000 });
await p.click('#checkDoc');
await p.waitForTimeout(400);
ok(await p.locator('.problems').count() === 0, 'на чистом документе окно с замечаниями не появляется');

ok(jsErr.length === 0, 'ошибок JavaScript в админке нет: ' + jsErr.join(' | '));

await browser.close();
console.log(fail === 0 ? '\nВСЁ ПРОЙДЕНО' : '\n' + fail + ' ПРОВЕРОК УПАЛО');
process.exit(fail === 0 ? 0 : 1);
