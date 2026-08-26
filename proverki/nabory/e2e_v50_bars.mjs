// Полосы «вставить сюда» стоят между элементами страницы. После удаления элемента две полосы
// оказывались подряд и выглядели как сбой. Правило простое: полос всегда на одну больше, чем
// элементов, и двух подряд не бывает никогда.
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
const p = await (await browser.newContext({ viewport: { width: 1500, height: 1100 } })).newPage();
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

await call('/document', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
  title: 'Согласие', signPrompt: 'Распишитесь', thankYouText: 'Спасибо', idleReturnSec: 0,
  pages: [{ headingRuns: [{ text: 'Страница' }],
    blocks: [{ runs: [{ text: 'Первый абзац' }], ord: 0 }, { runs: [{ text: 'Второй абзац' }], ord: 2 }],
    checkboxes: [{ key: 'c1', label: 'Пункт один', required: true, ord: 1 },
                 { key: 'c2', label: 'Пункт два', required: true, ord: 3 }],
    groups: [{ key: 'g1', title: 'Выбор', required: false, ord: 4,
      options: [{ key: 'a', label: 'Первый' }, { key: 'b', label: 'Второй' }] }] }],
  signBlocks: [], signBlocksBelow: [] }) });
await p.reload();
await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
await отказатьсяОтЧерновика(p);
await p.click('.tab[data-tab="document"]');
await p.waitForSelector('[data-role="itemlist"]', { timeout: 5000 });

// Правило проверяем целиком: количество полос, отсутствие двух подряд и порядок.
const состояние = () => p.evaluate(() => {
  const list = document.querySelector('[data-role="itemlist"]');
  const kids = Array.from(list.children);
  const виды = kids.map(n => n.classList.contains('insert-bar') ? 'полоса' : 'элемент');
  let подряд = 0;
  for (let i = 1; i < виды.length; i++) if (виды[i] === 'полоса' && виды[i - 1] === 'полоса') подряд++;
  return { элементов: виды.filter(v => v === 'элемент').length, полос: виды.filter(v => v === 'полоса').length, подряд: подряд, первый: виды[0], последний: виды[виды.length - 1] };
});

let st = await состояние();
ok(st.элементов === 5 && st.полос === 6, 'полос на одну больше, чем элементов: ' + JSON.stringify(st));
ok(st.подряд === 0, 'двух полос подряд нет');
ok(st.первый === 'полоса' && st.последний === 'полоса', 'полосы стоят и в начале, и в конце');

// Удаляем блок текста.
await p.locator('[data-role="blockcard"] .btn-danger:not(.cond-drop)').first().click();
await p.waitForTimeout(200);
st = await состояние();
ok(st.элементов === 4 && st.полос === 5, 'после удаления блока счёт сошёлся: ' + JSON.stringify(st));
ok(st.подряд === 0, 'двух полос подряд не появилось');

// Удаляем чекбокс.
await p.locator('[data-role="cbrow"] .btn-danger:not(.cond-drop)').first().click();
await p.waitForTimeout(200);
st = await состояние();
ok(st.подряд === 0, 'после удаления чекбокса тоже: ' + JSON.stringify(st));

// Удаляем группу.
await p.locator('[data-role="grouprow"] .btn-danger:not(.cond-drop)').first().click();
await p.waitForTimeout(200);
st = await состояние();
ok(st.подряд === 0, 'после удаления группы тоже: ' + JSON.stringify(st));
ok(st.полос === st.элементов + 1, 'правило держится: ' + JSON.stringify(st));

// Оставшееся должно сохраниться правильно.
await p.click('#saveDocument');
await p.waitForTimeout(800);
const doc = (await call('/document')).body;
const page = doc.pages[0];
ok((page.blocks || []).length + (page.checkboxes || []).length + (page.groups || []).length === st.элементов,
  'сохранилось ровно то, что осталось на экране');

ok(jsErr.length === 0, 'ошибок JavaScript нет: ' + jsErr.join(' | '));
await browser.close();
console.log(fail === 0 ? '\nВСЁ ПРОЙДЕНО' : '\n' + fail + ' ПРОВЕРОК УПАЛО');
process.exit(fail === 0 ? 0 : 1);
