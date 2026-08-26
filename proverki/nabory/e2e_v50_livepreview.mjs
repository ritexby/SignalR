// Предпросмотр должен вести себя как планшет, а не только выглядеть как он. Иначе условие,
// которое зависит от отметки клиента, проверить до отправки невозможно: оно не сработает
// никогда. И страница, скрытая таким условием, не должна показываться ни там, ни там.
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
  let b = null; try { b = await r.json(); } catch {} return { status: r.status, body: b };
}, [path, opts]);
const put = (path, obj) => call(path, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });

// Первая страница: чекбокс и блок, зависящий от него. Вторая страница целиком зависит от того
// же чекбокса. Третья видна всегда.
await put('/document', {
  title: 'Согласие', signPrompt: 'Распишитесь', thankYouText: 'Спасибо', idleReturnSec: 0,
  pages: [
    { headingRuns: [{ text: 'Первая' }],
      blocks: [{ runs: [{ text: 'ЗАВИСИМЫЙ-БЛОК' }], ord: 2, visibleWhen: { field: 'sms', op: 'eq', value: 'true' } }],
      checkboxes: [{ key: 'sms', label: 'Согласен на СМС', required: false, ord: 0 },
                   { key: 'must', label: 'Обязательный пункт', required: true, ord: 1 }],
      groups: [{ key: 'transfer', title: 'Передача данных', required: false, ord: 3,
        options: [{ key: 'allow', label: 'Разрешаю' }, { key: 'deny', label: 'Запрещаю' }] }] },
    { headingRuns: [{ text: 'ВТОРАЯ-ПО-УСЛОВИЮ' }], visibleWhen: { field: 'sms', op: 'eq', value: 'true' },
      blocks: [{ runs: [{ text: 'Текст второй' }], ord: 0 }], checkboxes: [], groups: [] },
    { headingRuns: [{ text: 'Третья' }], blocks: [{ runs: [{ text: 'Текст третьей' }], ord: 0 }], checkboxes: [], groups: [] }
  ],
  signBlocks: [], signBlocksBelow: []
});
await p.reload();
await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
await отказатьсяОтЧерновика(p);
await p.click('.tab[data-tab="document"]');
await p.waitForSelector('[data-role="itemlist"]', { timeout: 5000 });
await p.click('#previewDoc');
await p.waitForSelector('.preview-setup', { timeout: 4000 });
await p.click('.preview-setup .btn-primary');
await p.waitForSelector('.preview-wrap', { timeout: 6000 });

const текст = () => p.locator('.pv-body').textContent();
const шаг = () => p.locator('.pv-progress').textContent();

ok((await p.locator('.pv-live input[type=checkbox]').count()) >= 2, 'пункты в предпросмотре нажимаются');
ok(!/ЗАВИСИМЫЙ-БЛОК/.test(await текст()), 'зависимый блок пока скрыт');
ok(await p.locator('.pv-footer .btn-primary').isDisabled(), '«Далее» не пускает: обязательный пункт не отмечен');
ok(/Отметьте обязательные/.test(await p.locator('.pv-note').textContent()), 'и сказано почему');
ok(/Шаг 1 из 3/.test(await шаг()), 'скрытая страница не считается в шагах: ' + await шаг());

// Отмечаем зависимый пункт: блок появляется, скрытая страница входит в поток.
await p.locator('.pv-live input[type=checkbox]').first().check();
await p.waitForTimeout(200);
ok(/ЗАВИСИМЫЙ-БЛОК/.test(await текст()), 'после отметки зависимый блок появился');
ok(/Шаг 1 из 4/.test(await шаг()), 'и страница по условию вошла в поток: ' + await шаг());

// Обязательный пункт: «Далее» открывается.
await p.locator('.pv-live input[type=checkbox]').nth(1).check();
await p.waitForTimeout(200);
ok(!(await p.locator('.pv-footer .btn-primary').isDisabled()), 'после обязательного пункта «Далее» открылось');

// Группа: выбрать можно только один вариант, повторное нажатие снимает выбор.
const варианты = p.locator('.pv-group .pv-live input[type=checkbox]');
await варианты.first().check();
await p.waitForTimeout(150);
ok(await варианты.first().isChecked() && !(await варианты.nth(1).isChecked()), 'выбран первый вариант');
await варианты.nth(1).check();
await p.waitForTimeout(150);
ok(!(await варианты.first().isChecked()) && await варианты.nth(1).isChecked(), 'выбор одного снимает другой');
await варианты.nth(1).uncheck();
await p.waitForTimeout(150);
ok(!(await варианты.nth(1).isChecked()), 'повторное нажатие снимает выбор: «не выбрано» тоже состояние');

// Листаем: страница по условию действительно показывается.
await p.locator('.pv-footer .btn-primary').click();
await p.waitForTimeout(250);
ok(/ВТОРАЯ-ПО-УСЛОВИЮ/.test(await текст()), 'страница по условию открылась: ' + (await текст()).slice(0, 60));

// Снимаем отметку и убеждаемся, что страница уходит из потока.
await p.locator('.pv-footer .btn-ghost').first().click();
await p.waitForTimeout(250);
await p.locator('.pv-live input[type=checkbox]').first().uncheck();
await p.waitForTimeout(250);
ok(/Шаг 1 из 3/.test(await шаг()), 'страница вышла из потока: ' + await шаг());
await p.locator('.pv-footer .btn-primary').click();
await p.waitForTimeout(250);
ok(/Третья/.test(await текст()) && !/ВТОРАЯ-ПО-УСЛОВИЮ/.test(await текст()),
  'листание перескочило скрытую страницу: ' + (await текст()).slice(0, 60));

ok(jsErr.length === 0, 'ошибок JavaScript нет: ' + jsErr.join(' | '));
await browser.close();
console.log(fail === 0 ? '\nВСЁ ПРОЙДЕНО' : '\n' + fail + ' ПРОВЕРОК УПАЛО');
process.exit(fail === 0 ? 0 : 1);
