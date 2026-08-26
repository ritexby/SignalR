// Добавление поля подписи и сканирования через редактор.
import { chromium } from 'playwright';
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
const p = await (await browser.newContext({ viewport: { width: 1600, height: 1100 } })).newPage();
const jsErr = []; p.on('pageerror', e => jsErr.push(e.message));
p.on('dialog', d => d.accept());
await p.goto(BASE + '/admin/');
await p.fill('#password', 'test123'); await p.click('#loginForm button[type=submit]');
await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
const call = (path, opts) => p.evaluate(async ([pa, o]) => {
  const r = await fetch('/api/admin' + pa, Object.assign({ credentials: 'same-origin' }, o || {}));
  let b = null; try { b = await r.json(); } catch {} return { status: r.status, body: b };
}, [path, opts]);

await call('/document', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
  title: 'Согласие', signPrompt: 'Распишитесь', thankYouText: 'Спасибо', idleReturnSec: 0,
  pages: [{ headingRuns: [{ text: 'Страница' }], blocks: [{ runs: [{ text: 'Текст' }], ord: 0 }],
    checkboxes: [], groups: [] }], signBlocks: [], signBlocksBelow: [] }) });
await p.reload(); await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
await отказатьсяОтЧерновика(p);
await p.click('.tab[data-tab="document"]');
await p.waitForSelector('[data-role="itemlist"]', { timeout: 5000 });

// В меню вставки появились новые пункты.
await p.locator('.insert-chip').last().click();
await p.waitForTimeout(250);
const пункты = await p.locator('.insert-bar.open button').allTextContents();
ok(пункты.some(t => /Поле подписи/.test(t)), 'в меню есть поле подписи: ' + JSON.stringify(пункты));
ok(пункты.some(t => /Сканирование кода/.test(t)), 'и сканирование кода');

await p.locator('.insert-bar.open button', { hasText: 'Поле подписи' }).click();
await p.waitForTimeout(250);
const sig = p.locator('[data-role="signrow"]').first();
ok(await sig.count() === 1, 'поле подписи добавилось');
await sig.locator('[data-role="siglabel"]').type('Подпись пациента');
await p.waitForTimeout(250);
ok(await sig.locator('[data-role="sigkey"]').inputValue() === 'podpis-pacienta',
  'имя для API подставилось само: ' + await sig.locator('[data-role="sigkey"]').inputValue());

await p.locator('.insert-chip').last().click();
await p.waitForTimeout(250);
await p.locator('.insert-bar.open button', { hasText: 'Сканирование кода' }).click();
await p.waitForTimeout(250);
const sc = p.locator('[data-role="scanrow"]').first();
await sc.locator('[data-role="scanlabel"]').type('Штрихкод пробирки');
await p.waitForTimeout(250);
ok(await sc.locator('[data-role="scankey"]').inputValue().then(v => v.length > 0), 'у сканирования имя тоже подставилось');

await p.click('#saveDocument');
await p.waitForTimeout(900);
const page = ((await call('/document')).body.pages || [])[0];
ok((page.signatures || []).length === 1, 'поле подписи сохранено');
ok((page.scans || []).length === 1, 'сканирование сохранено');
ok(page.signatures[0].label === 'Подпись пациента', 'надпись сохранена: ' + page.signatures[0].label);
ok(page.signatures[0].required === true, 'обязательность по умолчанию');
const порядок = [page.blocks[0].ord, page.signatures[0].ord, page.scans[0].ord];
ok(JSON.stringify(порядок) === '[0,1,2]', 'порядок сквозной: ' + JSON.stringify(порядок));

// После перезагрузки элементы на месте и в том же порядке.
await p.reload(); await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
await отказатьсяОтЧерновика(p);
await p.click('.tab[data-tab="document"]');
await p.waitForSelector('[data-role="itemlist"]', { timeout: 5000 });
const виды = await p.evaluate(() => Array.from(document.querySelectorAll('[data-role="itemlist"] > .page-item')).map(n => n.getAttribute('data-kind')));
ok(JSON.stringify(виды) === '["block","signature","scan"]', 'порядок в редакторе тот же: ' + JSON.stringify(виды));

// Условие показа у них тоже работает.
const условие = p.locator('[data-role="signrow"] .cond-badge').first();
ok(await условие.count() === 1, 'у поля подписи есть условие показа');

ok(jsErr.length === 0, 'ошибок JavaScript нет: ' + jsErr.join(' | '));
await browser.close();
console.log(fail === 0 ? '\nВСЁ ПРОЙДЕНО' : '\n' + fail + ' ПРОВЕРОК УПАЛО');
process.exit(fail === 0 ? 0 : 1);
