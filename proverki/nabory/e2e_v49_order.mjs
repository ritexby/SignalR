// Свободный порядок блоков текста, чекбоксов и групп внутри страницы. Смысл: пункт относится к
// абзацу над ним, поэтому порядок обязан доехать до планшета, в предпросмотр и в запись подписи.
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
const ctx = await browser.newContext({ viewport: { width: 1400, height: 1100 } });
const p = await ctx.newPage();
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

// ---------- Старый документ без номеров показывается как раньше ----------
await put('/document', {
  title: 'Согласие', signPrompt: 'Распишитесь', thankYouText: 'Спасибо', idleReturnSec: 0,
  pages: [{
    headingRuns: [{ text: 'Страница' }],
    blocks: [{ runs: [{ text: 'ТЕКСТ-1' }] }, { runs: [{ text: 'ТЕКСТ-2' }] }],
    checkboxes: [{ key: 'a', label: 'ПУНКТ-A', required: true }, { key: 'b', label: 'ПУНКТ-Б', required: true }],
    groups: [{ key: 'g1', title: 'ВЫБОР', options: [{ key: 'yes', label: 'Да' }, { key: 'no', label: 'Нет' }] }]
  }],
  signBlocks: [], signBlocksBelow: []
});
let doc = (await call('/document')).body;
const ords = [
  ...doc.pages[0].blocks.map(b => ['block', b.ord]),
  ...doc.pages[0].checkboxes.map(c => ['cb', c.ord]),
  ...doc.pages[0].groups.map(g => ['grp', g.ord])
];
ok(JSON.stringify(ords) === JSON.stringify([['block',0],['block',1],['cb',2],['cb',3],['grp',4]]),
  'документу без номеров они проставляются по прежнему порядку: ' + JSON.stringify(ords));

// ---------- Редактор показывает всё одним списком ----------
await p.reload();
await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
await отказатьсяОтЧерновика(p);
await p.click('.tab[data-tab="document"]');
await p.waitForSelector('[data-role="pagecard"]', { timeout: 5000 });

const kinds = () => p.locator('[data-role="itemlist"] > .page-item').evaluateAll(
  ns => ns.map(n => n.getAttribute('data-kind')));
ok(JSON.stringify(await kinds()) === JSON.stringify(['block','block','checkbox','checkbox','group']),
  'все виды элементов лежат в одном списке: ' + JSON.stringify(await kinds()));
ok(await p.locator('[data-role="blocklist"]').count() === 0, 'отдельных списков блоков больше нет');
ok(await p.locator('[data-role="cblist"]').count() === 0, 'отдельных списков чекбоксов больше нет');

// Полос вставки на одну больше, чем элементов: перед первым и после каждого.
ok(await p.locator('[data-role="itemlist"] > .insert-bar').count() === 6,
  'полоса вставки есть перед списком и после каждого элемента');
ok(await p.locator('.insert-bar .insert-chip').first().isVisible(),
  'полоса вставки видна сразу, а не только при наведении');

// ---------- Вставка чекбокса между двумя абзацами ----------
await p.locator('[data-role="itemlist"] > .insert-bar').nth(1).locator('.insert-chip').click();
await p.waitForTimeout(150);
await p.locator('[data-role="itemlist"] > .insert-bar.open button', { hasText: 'Чекбокс' }).first().click();
await p.waitForTimeout(200);
ok(JSON.stringify(await kinds()) === JSON.stringify(['block','checkbox','block','checkbox','checkbox','group']),
  'новый чекбокс встал сразу после первого абзаца: ' + JSON.stringify(await kinds()));

await p.locator('[data-role="itemlist"] > .page-item').nth(1).locator('[data-role="cblabel"]').fill('МЕЖДУ-АБЗАЦАМИ');
await p.click('#saveDocument');
await p.waitForTimeout(700);
doc = (await call('/document')).body;
const page0 = doc.pages[0];
const flat = [
  ...page0.blocks.map(b => ({ ord: b.ord, what: (b.runs || []).map(r => r.text).join('') })),
  ...page0.checkboxes.map(c => ({ ord: c.ord, what: c.label })),
  ...page0.groups.map(g => ({ ord: g.ord, what: g.title }))
].sort((a, b) => a.ord - b.ord).map(x => x.what);
ok(JSON.stringify(flat) === JSON.stringify(['ТЕКСТ-1','МЕЖДУ-АБЗАЦАМИ','ТЕКСТ-2','ПУНКТ-A','ПУНКТ-Б','ВЫБОР']),
  'порядок сохранился в документе: ' + JSON.stringify(flat));

// ---------- Планшет показывает тот же порядок ----------
// Планшет читает разрешённый документ, поэтому проверяем через ту же ручку, что и показ.
const shown = (await call('/document/preview', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fields: {} })
})).body;
const sp = shown.document.pages[0];
const shownFlat = [
  ...sp.blocks.map(b => ({ ord: b.ord, what: (b.runs || []).map(r => r.text).join('') })),
  ...sp.checkboxes.map(c => ({ ord: c.ord, what: c.label })),
  ...sp.groups.map(g => ({ ord: g.ord, what: g.title }))
].sort((a, b) => a.ord - b.ord).map(x => x.what);
ok(JSON.stringify(shownFlat) === JSON.stringify(flat), 'на планшет уходит тот же порядок: ' + JSON.stringify(shownFlat));

// ---------- Предпросмотр в админке ----------
await p.click('#previewDoc');
await p.waitForSelector('.preview-setup', { timeout: 4000 });
await p.click('.preview-setup .btn-primary');
await p.waitForSelector('.preview-wrap', { timeout: 6000 });
const pvOrder = await p.evaluate(() => Array.from(document.querySelectorAll('.pv-body > *'))
  .map(n => n.className + '|' + n.textContent.trim()).filter(x => !/^pv-heading/.test(x)));
ok(/ТЕКСТ-1/.test(pvOrder[0]) && /МЕЖДУ-АБЗАЦАМИ/.test(pvOrder[1]) && /ТЕКСТ-2/.test(pvOrder[2]),
  'предпросмотр показывает тот же порядок: ' + JSON.stringify(pvOrder.slice(0, 4)));
await p.click('#modal .modal-close, #modal .close, .modal .modal-close').catch(() => {});
await p.evaluate(() => { const m = document.getElementById('modal'); if (m) m.classList.add('hidden'); });

// ---------- Перетаскивание внутри общего списка ----------
await p.reload();
await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
await отказатьсяОтЧерновика(p);
await p.click('.tab[data-tab="document"]');
await p.waitForSelector('[data-role="itemlist"]', { timeout: 5000 });
const before = await kinds();
const items = p.locator('[data-role="itemlist"] > .page-item');
// Сворачиваем блоки: иначе список длиннее экрана, и координаты элементов оказываются за
// пределами окна, куда курсор физически не попадает.
await p.evaluate(() => document.querySelectorAll('.item-toggle').forEach(t => t.click()));
await p.waitForTimeout(300);
await p.evaluate(() => {
  const l = document.querySelector('[data-role="itemlist"]');
  window.scrollTo(0, l.getBoundingClientRect().top + window.scrollY - 200);
});
await p.waitForTimeout(300);
const h = await items.first().locator('.drag-handle').first().boundingBox();
const t = await items.nth(3).boundingBox();
ok(h.y > 0 && h.y < 1000 && t.y > 0 && t.y < 1000,
  'оба элемента видны в окне: ручка=' + Math.round(h.y) + ', цель=' + Math.round(t.y));
await p.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
await p.mouse.down();
await p.mouse.move(t.x + t.width / 2, t.y + t.height / 2, { steps: 15 });
await p.mouse.move(t.x + t.width / 2, t.y + t.height / 2 + 8, { steps: 5 });
await p.mouse.up();
await p.waitForTimeout(400);
const after = await kinds();
ok(JSON.stringify(after) !== JSON.stringify(before), 'перетаскивание меняет порядок: ' + JSON.stringify(after));
ok(after.slice().sort().join() === before.slice().sort().join(), 'и ни один элемент не пропал');
ok(await p.locator('[data-role="itemlist"] > .insert-bar').count() === after.length + 1,
  'полосы вставки после перетаскивания расставлены заново');

await p.click('#saveDocument');
await p.waitForTimeout(700);
doc = (await call('/document')).body;
const total = (doc.pages[0].blocks || []).length + (doc.pages[0].checkboxes || []).length + (doc.pages[0].groups || []).length;
ok(total === 6, 'после перетаскивания сохранились все шесть элементов: ' + total);
const allOrds = [
  ...doc.pages[0].blocks.map(b => b.ord),
  ...doc.pages[0].checkboxes.map(c => c.ord),
  ...doc.pages[0].groups.map(g => g.ord)
].sort((a, b) => a - b);
ok(JSON.stringify(allOrds) === JSON.stringify([0,1,2,3,4,5]), 'номера сплошные, без дыр: ' + JSON.stringify(allOrds));

ok(jsErr.length === 0, 'ошибок JavaScript нет: ' + jsErr.join(' | '));
await browser.close();
console.log(fail === 0 ? '\nВСЁ ПРОЙДЕНО' : '\n' + fail + ' ПРОВЕРОК УПАЛО');
process.exit(fail === 0 ? 0 : 1);
