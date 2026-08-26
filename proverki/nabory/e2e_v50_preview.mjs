// Предпросмотр должен показывать документ ровно так, как его увидит клиент, включая условия.
// Разбираемый случай: тег в тексте записан «ПОЛ», а условия ссылаются на «Пол». Сервер сравнивает
// имена без учёта регистра, а редактор раньше сравнивал с учётом: поле оставалось пустой строкой
// ввода без списка значений, условия не срабатывали ни на одно, и оба блока пропадали.
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
  pages: [{
    headingRuns: [{ text: 'Данные' }],
    blocks: [
      { runs: [{ text: 'Пациент: {{ФИО}}, пол: {{ПОЛ}}' }], ord: 0 },
      { runs: [{ text: 'БЛОК-ДЛЯ-ЖЕНЩИН' }], visibleWhen: { field: 'Пол', op: 'eq', value: 'F' }, ord: 1 },
      { runs: [{ text: 'БЛОК-ДЛЯ-МУЖЧИН' }], visibleWhen: { field: 'Пол', op: 'eq', value: 'M' }, ord: 2 }
    ],
    checkboxes: [], groups: []
  }],
  signBlocks: [], signBlocksBelow: []
});
await p.reload();
await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
await отказатьсяОтЧерновика(p);
await p.click('.tab[data-tab="document"]');
await p.waitForSelector('[data-role="itemlist"]', { timeout: 5000 });

await p.click('#previewDoc');
await p.waitForSelector('.preview-setup', { timeout: 4000 });

// Тег «ПОЛ» должен получить список значений, а не пустое поле ввода.
const polSel = p.locator('.preview-setup label.field', { hasText: 'ПОЛ' }).locator('select');
ok(await polSel.count() === 1, 'для тега «ПОЛ» предлагается список значений, а не пустое поле');
const opts = await polSel.locator('option').evaluateAll(ns => ns.map(n => n.value));
const labels = await polSel.locator('option').allTextContents();
ok(JSON.stringify(opts) === JSON.stringify(['M', 'F']), 'на проводе значения M и F: ' + JSON.stringify(opts));
ok(labels.some(t => /Ж/.test(t)) && labels.some(t => /М/.test(t)), 'а на экране Ж и М: ' + JSON.stringify(labels));
ok(await polSel.inputValue() === 'F', 'по умолчанию подставлено осмысленное значение: ' + await polSel.inputValue());

async function shown() {
  await p.click('.preview-setup .btn-primary');
  await p.waitForSelector('.preview-wrap', { timeout: 6000 });
  const t = await p.locator('.pv-body').textContent();
  await p.locator('.preview-wrap button', { hasText: 'Изменить значения' }).click();
  await p.waitForSelector('.preview-setup', { timeout: 4000 });
  return t;
}

let text = await shown();
ok(/БЛОК-ДЛЯ-ЖЕНЩИН/.test(text), 'при F показан женский блок');
ok(!/БЛОК-ДЛЯ-МУЖЧИН/.test(text), 'и скрыт мужской: ' + text.slice(0, 120));
ok(/пол: F/.test(text), 'значение подставилось в текст: ' + text.slice(0, 120));

await p.locator('.preview-setup label.field', { hasText: 'ПОЛ' }).locator('select').selectOption('M');
text = await shown();
ok(/БЛОК-ДЛЯ-МУЖЧИН/.test(text), 'при M показан мужской блок');
ok(!/БЛОК-ДЛЯ-ЖЕНЩИН/.test(text), 'и скрыт женский: ' + text.slice(0, 120));
ok(/пол: M/.test(text), 'значение снова подставилось: ' + text.slice(0, 120));

// Экран подписи в предпросмотре: одно поле подписи, а не два.
await p.click('.preview-setup .btn-primary');
await p.waitForSelector('.preview-wrap', { timeout: 6000 });
for (let i = 0; i < 5; i++) {
  const next = p.locator('.pv-footer button', { hasText: 'Далее' });
  if (await next.isDisabled()) break;
  await next.click(); await p.waitForTimeout(120);
}
const pads = await p.locator('.pv-pad').count();
ok(pads === 1, 'на странице подписи ровно одно поле подписи, а не два: ' + pads);
const order = await p.evaluate(() => Array.from(document.querySelectorAll('.pv-body > *')).map(n => n.className));
ok(order.indexOf('pv-prompt') >= 0 && order.indexOf('pv-pad') === order.indexOf('pv-prompt') + 1,
  'надпись стоит прямо над полем подписи, как на планшете: ' + JSON.stringify(order));

ok(jsErr.length === 0, 'ошибок JavaScript нет: ' + jsErr.join(' | '));
await browser.close();
console.log(fail === 0 ? '\nВСЁ ПРОЙДЕНО' : '\n' + fail + ' ПРОВЕРОК УПАЛО');
process.exit(fail === 0 ? 0 : 1);
