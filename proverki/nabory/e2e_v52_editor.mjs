// Редактор v5.2: одна панель оформления, сворачивание элементов, защита несохранённого,
// перетаскивание между страницами.
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
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1100 } });
const p = await ctx.newPage();
const jsErr = []; p.on('pageerror', e => jsErr.push(e.message));
p.on('dialog', d => d.accept());
await p.goto(BASE + '/admin/');
await p.fill('#password', 'test123'); await p.click('#loginForm button[type=submit]');
await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
await отказатьсяОтЧерновика(p);
const call = (path, opts) => p.evaluate(async ([pa, o]) => {
  const r = await fetch('/api/admin' + pa, Object.assign({ credentials: 'same-origin' }, o || {}));
  let b = null; try { b = await r.json(); } catch {} return { status: r.status, body: b };
}, [path, opts]);

const стр = (n, k) => ({ headingRuns: [{ text: 'Страница ' + n }],
  blocks: [{ runs: [{ text: 'АБЗАЦ-' + n + ' Настоящим я подтверждаю, что ознакомлен с условиями.' }], ord: 0 }],
  checkboxes: Array.from({ length: k }, (_, i) => ({ key: 'p' + n + '_' + i, label: 'Пункт ' + n + '.' + (i + 1), required: true, ord: 1 + i })),
  groups: [] });
await call('/document', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
  title: 'Согласие', signPrompt: 'Распишитесь', thankYouText: 'Спасибо', idleReturnSec: 180,
  pages: [стр(1, 2), стр(2, 2), стр(3, 1)], signBlocks: [], signBlocksBelow: [] }) });
await p.reload(); await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
await отказатьсяОтЧерновика(p);
await p.click('.tab[data-tab="document"]');
await p.waitForSelector('[data-role="pagecard"]', { timeout: 5000 });
await p.waitForTimeout(500);

// ---------- Одна панель оформления ----------
ok(await p.locator('.rt-toolbar').count() === 1, 'панель оформления на странице ровно одна');
ok(await p.locator('.rt-toolbar.rt-idle').count() === 1, 'пока поле не выбрано, панель неактивна');
ok(/Поставьте курсор/.test(await p.locator('.rt-hint').textContent()), 'и говорит, что делать');
await p.locator('.rt-editor').first().click();
await p.waitForTimeout(250);
ok(await p.locator('.rt-toolbar.rt-idle').count() === 0, 'после клика в текст панель ожила');

// Панель стоит на своём месте и ничего не закрывает: всплывающая над полем прятала кнопку
// условия показа, подписи и часть текста.
const перекрытие = await p.evaluate(() => {
  const bar = document.querySelector('.rt-toolbar').getBoundingClientRect();
  const закрыто = [];
  document.querySelectorAll('[data-panel="document"] .cond-badge, [data-panel="document"] .seg, [data-panel="document"] .rt-editor, [data-panel="document"] .section-label, [data-panel="document"] .cb-row').forEach(e => {
    const r = e.getBoundingClientRect();
    if (r.width === 0 || r.bottom < 0 || r.top > window.innerHeight) return;
    if (!(r.right < bar.left || r.left > bar.right || r.bottom < bar.top || r.top > bar.bottom))
      закрыто.push((e.className || '').toString().slice(0, 24));
  });
  return закрыто;
});
ok(перекрытие.length === 0, 'панель ничего не закрывает: ' + JSON.stringify(перекрытие));

// При прокрутке остаётся на виду, иначе к ней пришлось бы возвращаться наверх.
await p.evaluate(() => window.scrollTo(0, 700));
await p.waitForTimeout(250);
ok(await p.evaluate(() => {
  const r = document.querySelector('.rt-toolbar').getBoundingClientRect();
  return r.top >= 0 && r.bottom <= window.innerHeight;
}), 'при прокрутке панель остаётся видна');
await p.evaluate(() => window.scrollTo(0, 0));
await p.waitForTimeout(200);

// Пометка о несохранённом не должна раздвигать ряд кнопок.
const рядДо = await p.evaluate(() => {
  const s = new Set(); document.querySelectorAll('.toolbar-actions .btn').forEach(b => s.add(Math.round(b.getBoundingClientRect().top)));
  return s.size;
});
await p.locator('#docTitle').fill('Проверка ряда');
await p.waitForTimeout(300);
const рядПосле = await p.evaluate(() => {
  const s = new Set(); document.querySelectorAll('.toolbar-actions .btn').forEach(b => s.add(Math.round(b.getBoundingClientRect().top)));
  return s.size;
});
ok(рядДо === рядПосле, 'пометка о несохранённом не сдвинула кнопки: ' + рядДо + ' → ' + рядПосле);

// Команды работают именно с этим полем.
await p.evaluate(() => {
  const ed = document.querySelector('.block-card .rt-editor');
  ed.focus();
  const r = document.createRange(); r.selectNodeContents(ed);
  const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
});
await p.waitForTimeout(150);
await p.locator('.rt-toolbar button', { hasText: /^Ж$/ }).click();
await p.waitForTimeout(200);
await p.click('#saveDocument');
await p.waitForTimeout(700);
let doc = (await call('/document')).body;
ok(JSON.stringify(doc.pages[0].blocks[0].runs).includes('"bold":true'), 'кнопка панели применилась к нужному блоку');

// Панель прячется, когда ушли из полей.
await p.locator('#docTitle').click();
await p.waitForTimeout(250);
ok(await p.locator('.rt-toolbar.rt-idle').count() === 1, 'панель погасла, когда редактирование закончилось');

// ---------- Сворачивание элементов ----------
const блок = p.locator('.block-card').first();
ok(await блок.locator('.item-toggle').count() === 1, 'у блока есть кнопка сворачивания');
await блок.locator('.item-toggle').click();
await p.waitForTimeout(200);
ok(await блок.evaluate(e => e.classList.contains('item-collapsed')), 'блок свернулся');
const сводка = await блок.locator('.item-summary').textContent();
ok(/АБЗАЦ-1/.test(сводка), 'в свёрнутом виде показано начало текста: ' + сводка);
ok(!(await блок.locator('.rt-editor').isVisible()), 'сам текст скрыт');

// Свёрнутый блок не теряется при сохранении.
await p.click('#saveDocument');
await p.waitForTimeout(700);
doc = (await call('/document')).body;
ok(JSON.stringify(doc.pages[0].blocks[0]).includes('АБЗАЦ-1'), 'содержимое свёрнутого блока сохранилось');
await блок.locator('.item-toggle').click();
await p.waitForTimeout(200);
ok(await блок.locator('.rt-editor').isVisible(), 'разворачивается обратно');

// Пункт занимает одну строку: условие стоит в той же строке.
const строкаПункта = p.locator('[data-role="cbrow"]').first();
ok(await строкаПункта.locator('.cond-inline').count() === 1, 'условие пункта стоит в его же строке');
const высота = await строкаПункта.evaluate(e => Math.round(e.getBoundingClientRect().height));
ok(высота < 80, 'и пункт помещается в одну строку: ' + высота + ' px');

// ---------- Защита несохранённого ----------
ok(await p.locator('#docDirty').isHidden(), 'сразу после сохранения пометки нет');
await p.locator('[data-role="cblabel"]').first().click();
await p.keyboard.press('Control+A');
await p.keyboard.type('Изменённый пункт');
await p.waitForTimeout(150);
await p.waitForTimeout(300);
ok(await p.locator('#docDirty').isVisible(), 'после правки появилась пометка о несохранённом');
await p.waitForTimeout(1500);
// Черновик лежит под ключом своего документа: у каждого документа библиотеки он свой.
const черновик = await p.evaluate(() => {
  const k = Object.keys(localStorage).filter(x => x.indexOf('sk_doc_draft') === 0);
  return k.length ? localStorage.getItem(k[0]) : null;
});
ok(!!черновик && черновик.indexOf('Изменённый пункт') >= 0, 'черновик записан в браузер');

// Перезагрузка: черновик предлагается восстановить. Здесь его как раз проверяем, поэтому
// общий помощник не вызываем.
await p.reload();
await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
await p.waitForSelector('.modal h3', { timeout: 8000 });
ok(/несохранённый черновик/i.test(await p.locator('.modal h3').textContent()), 'предложено восстановить черновик');
await p.locator('.modal button', { hasText: 'Восстановить черновик' }).click();
await p.waitForTimeout(500);
ok((await p.locator('[data-role="cblabel"]').first().textContent()) === 'Изменённый пункт', 'черновик восстановлен');
ok(await p.locator('#docDirty').isVisible(), 'и помечен как несохранённый');
await p.click('#saveDocument');
await p.waitForTimeout(700);
ok(await p.locator('#docDirty').isHidden(), 'после сохранения пометка снялась');
ok(!(await p.evaluate(() => localStorage.getItem('sk_doc_draft'))), 'и черновик убран');

// ---------- Перетаскивание между страницами ----------
// Документ делается компактным, чтобы обе страницы помещались в окно: тащить можно только
// туда, куда дотягивается курсор.
await call('/document', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
  title: 'Согласие', signPrompt: 'Распишитесь', thankYouText: 'Спасибо', idleReturnSec: 180,
  pages: [
    { headingRuns: [{ text: 'Первая' }], blocks: [],
      checkboxes: [{ key: 'a1', label: 'ПЕРЕЕЗЖАЮЩИЙ', required: true, ord: 0 },
                   { key: 'a2', label: 'Остаётся', required: true, ord: 1 }], groups: [] },
    { headingRuns: [{ text: 'Вторая' }], blocks: [],
      checkboxes: [{ key: 'b1', label: 'Уже был здесь', required: true, ord: 0 }], groups: [] }
  ], signBlocks: [], signBlocksBelow: [] }) });
await p.reload();
await p.waitForSelector('[data-role="pagecard"]', { timeout: 8000 });
await p.waitForTimeout(600);
const было = ((await call('/document')).body.pages || []).map(x => (x.checkboxes || []).length);
ok(JSON.stringify(было) === '[2,1]', 'пунктов на страницах: ' + JSON.stringify(было));
const источник = p.locator('#pagesEditor > [data-role="pagecard"]').first().locator('[data-role="cbrow"]').first();
const чужойПункт = p.locator('#pagesEditor > [data-role="pagecard"]').nth(1).locator('[data-role="cbrow"]').first();
// Вторая страница ниже окна: тащим к нижнему краю и ждём, пока сработает автопрокрутка.
// Прокручиваем к ручке, как это делает оператор: тащить можно только то, что видно. Раньше
// набор начинал перетаскивание по координатам от начала страницы и держался лишь потому, что
// ручка случайно попадала в окно; любая надстройка выше по странице ломала его на ровном месте.
await источник.locator('.drag-handle').scrollIntoViewIfNeeded();
await p.waitForTimeout(300);
const rh = await источник.locator('.drag-handle').boundingBox();
const до = await p.evaluate(() => window.scrollY);
await p.mouse.move(rh.x + rh.width / 2, rh.y + rh.height / 2);
await p.mouse.down();
await p.mouse.move(rh.x + rh.width / 2, rh.y + 40, { steps: 5 });
// Держим курсор у нижней кромки: страница должна поехать сама.
for (let i = 0; i < 30; i++) {
  await p.mouse.move(rh.x + 40, 1090 - (i % 2), { steps: 2 });
  await p.waitForTimeout(60);
  const видна = await чужойПункт.boundingBox();
  if (видна && видна.y < 900) break;
}
const после = await p.evaluate(() => window.scrollY);
ok(после > до + 200, 'страница проехала сама во время перетаскивания: ' + до + ' → ' + после);
const rt = await чужойПункт.boundingBox();
await p.mouse.move(rt.x + 40, rt.y + rt.height - 4, { steps: 10 });
await p.mouse.move(rt.x + 40, rt.y + rt.height - 2, { steps: 5 });
await p.mouse.up();
await p.waitForTimeout(400);
await p.click('#saveDocument');
await p.waitForTimeout(800);
const стало = ((await call('/document')).body.pages || []).map(x => (x.checkboxes || []).length);
ok(стало[0] === 1 && стало[1] === 2, 'пункт переехал на другую страницу: ' + JSON.stringify(стало));
const вторая = (await call('/document')).body.pages[1];
ok(JSON.stringify(вторая.checkboxes).includes('ПЕРЕЕЗЖАЮЩИЙ'), 'переехал именно тот пункт');
const полосы = await p.evaluate(() => {
  const out = [];
  document.querySelectorAll('[data-role="itemlist"]').forEach(l => {
    const виды = Array.from(l.children).map(n => n.classList.contains('insert-bar') ? 'п' : 'э');
    let подряд = 0;
    for (let i = 1; i < виды.length; i++) if (виды[i] === 'п' && виды[i - 1] === 'п') подряд++;
    out.push({ элементов: виды.filter(v => v === 'э').length, полос: виды.filter(v => v === 'п').length, подряд });
  });
  return out;
});
ok(полосы.every(x => x.подряд === 0 && x.полос === x.элементов + 1),
  'полосы вставки пересобраны в обоих списках: ' + JSON.stringify(полосы));

ok(jsErr.length === 0, 'ошибок JavaScript нет: ' + jsErr.join(' | '));
await browser.close();
console.log(fail === 0 ? '\nВСЁ ПРОЙДЕНО' : '\n' + fail + ' ПРОВЕРОК УПАЛО');
process.exit(fail === 0 ? 0 : 1);
