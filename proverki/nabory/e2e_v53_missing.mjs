// Клиент нажал «Далее», не отметив обязательный пункт. Раньше кнопка была просто выключена:
// нажатие не давало ничего, и искать неотмеченную галочку среди десятка приходилось глазами.
// Теперь кнопка работает и показывает, чего именно не хватает.
import { chromium } from 'playwright';
const BASE = 'http://127.0.0.1:5080';
// Путь к браузеру берётся из окружения: на другой машине он другой, а зашитый путь
// превращал набор в неработающий у всех, кроме одной установки. Пусто значит
// «пусть Playwright возьмёт свой», как он и делает по умолчанию.
const EXE = process.env.SK_CHROME || undefined;
const SP = '' + (process.env.SK_RABOTA || '.') + '';
let fail = 0;
const ok = (c, m) => { if (c) console.log('PASS', m); else { console.error('FAIL', m); fail++; } };

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const admin = await (await browser.newContext()).newPage();
await admin.goto(BASE + '/admin/');
await admin.fill('#password', 'test123'); await admin.click('#loginForm button[type=submit]');
await admin.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
const call = (path, opts) => admin.evaluate(async ([pa, o]) => {
  const r = await fetch('/api/admin' + pa, Object.assign({ credentials: 'same-origin' }, o || {}));
  let b = null; try { b = await r.json(); } catch {} return { status: r.status, body: b };
}, [path, opts]);

const абз = 'Настоящим подтверждаю, что ознакомлен с условиями оказания услуг и порядком обработки персональных данных.';
await call('/document', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
  title: 'Согласие', signPrompt: 'Распишитесь', thankYouText: 'Спасибо', idleReturnSec: 0,
  pages: [{ headingRuns: [{ text: 'Согласия' }],
    blocks: [{ runs: [{ text: абз }], ord: 0 }, { runs: [{ text: абз + ' ' + абз }], ord: 1 }],
    checkboxes: [
      { key: 'a', label: 'Первый пункт, необязательный', required: false, ord: 2 },
      { key: 'b', label: 'ВТОРОЙ ПУНКТ, ОБЯЗАТЕЛЬНЫЙ', required: true, ord: 3 },
      { key: 'c', label: 'ТРЕТИЙ ПУНКТ, ТОЖЕ ОБЯЗАТЕЛЬНЫЙ', required: true, ord: 4 }],
    groups: [{ key: 'g', title: 'Трансграничная передача', required: true, ord: 5,
      options: [{ key: 'yes', label: 'Разрешаю' }, { key: 'no', label: 'Запрещаю' }] }] }],
  signBlocks: [], signBlocksBelow: [] }) });

const code = (await call('/devices/enroll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"name":"Планшет"}' })).body.code;
const kiosk = await (await browser.newContext({ viewport: { width: 800, height: 1200 } })).newPage();
await kiosk.goto(BASE + '/?enroll=' + encodeURIComponent(code));
await kiosk.waitForFunction(() => !!localStorage.getItem('sk_device_token'), { timeout: 12000 });
let id = null;
for (let i = 0; i < 40; i++) {
  const d = (await call('/devices')).body || []; const on = d.find(x => x.online);
  if (on) { id = on.id; break; }
  await kiosk.waitForTimeout(250);
}
await call('/show-document', { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ target: 'device:' + id, fields: {} }) });
await kiosk.waitForSelector('.check', { timeout: 8000 });

const далее = kiosk.locator('#btnNext');
ok(!(await далее.isDisabled()), 'кнопка «Далее» рабочая, а не выключенная');
ok(await далее.evaluate(e => e.classList.contains('btn-wait')), 'но приглушена: срабатывать ей ещё рано');
ok(await kiosk.locator('.miss').count() === 0, 'до нажатия ничего не подсвечено: человеку не в чем виниться заранее');

await далее.click();
await kiosk.waitForTimeout(600);
const подсвечено = await kiosk.locator('.miss').count();
ok(подсвечено === 3, 'подсвечены все пропущенные: два пункта и группа, всего ' + подсвечено);
ok(await kiosk.locator('.miss-note').count() === 3, 'у каждого написано словами, что делать');
const текстПодписи = await kiosk.locator('.miss-note').first().textContent();
ok(/Нужно отметить/.test(текстПодписи), 'подпись у пункта: ' + текстПодписи);
const текстГруппы = await kiosk.evaluate(() => {
  const g = document.querySelector('.group.miss .miss-note');
  return g ? g.textContent : '';
});
ok(/выбрать один вариант/.test(текстГруппы), 'у группы своя подпись: ' + текстГруппы);
const подсказка = await kiosk.locator('#footerNote').textContent();
ok(/осталось 3/.test(подсказка), 'внизу названо число: ' + подсказка);

// Неотмеченный необязательный пункт не должен подсвечиваться.
const первыйПодсвечен = await kiosk.evaluate(() => {
  const l = document.querySelectorAll('.checks .check')[0];
  return l ? l.classList.contains('miss') : null;
});
ok(первыйПодсвечен === false, 'необязательный пункт не подсвечен');

// Экран подвёлся к первому пропущенному.
const виден = await kiosk.evaluate(() => {
  const m = document.querySelector('.miss');
  const r = m.getBoundingClientRect();
  return r.top > 0 && r.bottom < window.innerHeight;
});
ok(виден, 'экран подвёлся к первому пропущенному пункту');
await kiosk.screenshot({ path: SP + '/v53_missing.png', fullPage: false });

// Отметили один: подсветка с него снимается сразу, счётчик уменьшается.
await kiosk.evaluate(() => {
  const l = document.querySelector('.check.miss input');
  l.checked = true; l.dispatchEvent(new Event('change', { bubbles: true }));
});
await kiosk.waitForTimeout(300);
ok(await kiosk.locator('.miss').count() === 2, 'подсветка снялась с отмеченного сразу');

await далее.click();
await kiosk.waitForTimeout(400);
ok(/осталось 2/.test(await kiosk.locator('#footerNote').textContent()), 'счётчик обновился');

// Отмечаем всё: подсветка уходит, кнопка перестаёт быть приглушённой, страница листается.
await kiosk.evaluate(() => {
  document.querySelectorAll('.checks .check input').forEach(i => {
    if (!i.checked) { i.checked = true; i.dispatchEvent(new Event('change', { bubbles: true })); }
  });
});
await kiosk.waitForTimeout(400);
ok(await kiosk.locator('.miss').count() === 0, 'подсветка полностью убралась');
ok(!(await далее.evaluate(e => e.classList.contains('btn-wait'))), 'кнопка стала обычной');

// Подпись: та же логика вместо выключенной кнопки.
await далее.click();
await kiosk.waitForSelector('canvas', { timeout: 8000 });
const подписать = kiosk.locator('#btnSign');
ok(!(await подписать.isDisabled()), 'кнопка «Подписать» рабочая');
await подписать.click();
await kiosk.waitForTimeout(400);
ok(await kiosk.locator('.sign-wrap.miss').count() === 1, 'поле подписи подсвечено');
ok(/выделенном поле/.test(await kiosk.locator('#footerNote').textContent()), 'и сказано, что делать');

await browser.close();
console.log(fail === 0 ? '\nВСЁ ПРОЙДЕНО' : '\n' + fail + ' ПРОВЕРОК УПАЛО');
process.exit(fail === 0 ? 0 : 1);
