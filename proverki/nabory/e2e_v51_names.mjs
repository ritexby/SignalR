// Имя для API у чекбокса и группы должно подставляться само из текста: без него оператор
// не понимает, что туда писать, и оставляет поле пустым. И отдельно: в fields можно прислать
// любое имя, а не только из стандартного списка.
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
const p = await (await browser.newContext({ viewport: { width: 1600, height: 1100 } })).newPage();
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
  pages: [{ headingRuns: [{ text: 'Страница' }], blocks: [], checkboxes: [], groups: [] }],
  signBlocks: [], signBlocksBelow: [] }) });
await p.reload(); await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
await отказатьсяОтЧерновика(p);
await p.click('.tab[data-tab="document"]');
// Справка о тегах свёрнута, чтобы не занимать четверть экрана. Раскрываем её, как это делает
// оператор: список тегов живёт внутри неё.
await p.evaluate(() => { var d = document.querySelector('.tags-box'); if (d) d.open = true; });
await p.waitForSelector('[data-role="itemlist"]', { timeout: 5000 });

// Чекбокс: набираем текст, имя появляется само.
await p.locator('.insert-chip').last().click();
await p.waitForTimeout(200);
await p.locator('button', { hasText: 'Чекбокс' }).first().click();
await p.waitForTimeout(200);
const cb = p.locator('[data-role="cbrow"]').first();
await cb.locator('[data-role="cblabel"]').fill('');
await cb.locator('[data-role="cblabel"]').type('Гормоны');
await p.waitForTimeout(200);
const имя = await cb.locator('[data-role="cbkey"]').inputValue();
ok(имя === 'gormony', 'имя для API подставилось само из текста: ' + имя);

// Второй пункт с тем же началом не должен получить то же имя.
await p.locator('.insert-chip').last().click();
await p.waitForTimeout(200);
await p.locator('button', { hasText: 'Чекбокс' }).first().click();
await p.waitForTimeout(200);
const cb2 = p.locator('[data-role="cbrow"]').nth(1);
await cb2.locator('[data-role="cblabel"]').type('Гормоны');
await p.waitForTimeout(200);
const имя2 = await cb2.locator('[data-role="cbkey"]').inputValue();
ok(имя2 && имя2 !== имя, 'у второго пункта имя другое: ' + имя2);

// Вписанное руками не переписывается.
await cb2.locator('[data-role="cbkey"]').fill('my_key');
await cb2.locator('[data-role="cblabel"]').fill('Совсем другой текст');
await p.waitForTimeout(200);
ok(await cb2.locator('[data-role="cbkey"]').inputValue() === 'my_key', 'заданное руками имя не переписывается');

// Группа: заголовок тоже даёт имя.
await p.locator('.insert-chip').last().click();
await p.waitForTimeout(200);
await p.locator('button', { hasText: 'Двойные зависимые чекбоксы' }).first().click();
await p.waitForTimeout(200);
const g = p.locator('[data-role="grouprow"]').first();
await g.locator('[data-role="gtitle"]').type('Трансграничная передача');
await p.waitForTimeout(200);
const gk = await g.locator('[data-role="gkey"]').inputValue();
ok(gk && /^[a-z0-9_-]+$/.test(gk), 'у группы имя тоже подставилось: ' + gk);

// Группа без вариантов не сохраняется намеренно: выбирать было бы не из чего. Заполняем.
await g.locator('button', { hasText: 'Вариант' }).click();
await p.waitForTimeout(150);
await g.locator('button', { hasText: 'Вариант' }).click();
await p.waitForTimeout(150);
const варианты = g.locator('[data-role="optrow"]');
await варианты.nth(0).locator('[data-role="olabel"]').type('Разрешаю');
await варианты.nth(1).locator('[data-role="olabel"]').type('Запрещаю');
await p.waitForTimeout(200);
ok(await варианты.nth(0).locator('[data-role="okey"]').inputValue() === 'razreshayu',
  'у варианта имя тоже подставилось: ' + await варианты.nth(0).locator('[data-role="okey"]').inputValue());

await p.click('#saveDocument');
await p.waitForTimeout(800);
const page = ((await call('/document')).body || {}).pages[0];
ok((page.checkboxes || []).every(c => c.key), 'все пункты сохранены с именами: ' + JSON.stringify((page.checkboxes || []).map(c => c.key)));
ok((page.groups || [])[0] && page.groups[0].key, 'и группа тоже: ' + JSON.stringify((page.groups || []).map(x => x.key)));

// ---------- Свой тег, которого нет в стандартном списке ----------
await call('/document', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
  title: 'Согласие', signPrompt: 'Распишитесь', thankYouText: 'Спасибо', idleReturnSec: 0,
  pages: [{ headingRuns: [{ text: 'Страница' }],
    blocks: [{ runs: [{ text: 'Врач: {{Лечащий врач}}, кабинет {{кабинет}}' }], ord: 0 },
             { runs: [{ text: 'БЛОК-ПО-СВОЕМУ-ТЕГУ' }], ord: 1, visibleWhen: { field: 'отделение', op: 'eq', value: 'урология' } }],
    checkboxes: [], groups: [] }],
  signBlocks: [], signBlocksBelow: [] }) });

const r = await p.evaluate(async () => {
  const res = await fetch('/api/admin/document/preview', { method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: { 'Лечащий врач': 'Иванов И.И.', 'кабинет': '304', 'отделение': 'урология' } }) });
  return await res.json();
});
const текст = JSON.stringify(r.document);
ok(/Иванов И.И./.test(текст), 'свой тег подставился: имена в fields не ограничены списком');
ok(/кабинет 304/.test(текст), 'и второй свой тег тоже');
ok(/БЛОК-ПО-СВОЕМУ-ТЕГУ/.test(текст), 'условие на свой тег сработало');

// В банере они показаны отдельно и объяснены, а не помечены как ошибка.
await p.reload(); await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
await отказатьсяОтЧерновика(p);
await p.click('.tab[data-tab="document"]');
// Справка о тегах свёрнута, чтобы не занимать четверть экрана. Раскрываем её, как это делает
// оператор: список тегов живёт внутри неё.
await p.evaluate(() => { var d = document.querySelector('.tags-box'); if (d) d.open = true; });
await p.waitForSelector('.placeholders', { timeout: 5000 });
const своиLabel = await p.locator('.ph-label-warn').textContent();
ok(/Свои теги/.test(своиLabel || ''), 'свои теги подписаны как свои, а не как ошибка: ' + своиLabel);
const подсказка = await p.locator('.ph-unknown').first().getAttribute('title');
ok(/любое имя/.test(подсказка || ''), 'подсказка объясняет, что так можно: ' + (подсказка || '').slice(0, 60));

await p.click('#checkDoc');
await p.waitForTimeout(500);
const замечания = (await p.locator('.problem').allTextContents()).join(' | ');
ok(!/не входит в список известных/.test(замечания), 'старой формулировки про «неизвестный тег» больше нет');
ok(await p.locator('.problem-error').count() === 0, 'свои теги не считаются ошибками: ' + замечания.slice(0, 120));

ok(jsErr.length === 0, 'ошибок JavaScript нет: ' + jsErr.join(' | '));
await browser.close();
console.log(fail === 0 ? '\nВСЁ ПРОЙДЕНО' : '\n' + fail + ' ПРОВЕРОК УПАЛО');
process.exit(fail === 0 ? 0 : 1);
