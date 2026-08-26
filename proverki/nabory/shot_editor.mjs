// Общий вид редактора документа: оглавление, свёрнутая и развёрнутая страница.
import { chromium } from 'playwright';
const BASE = 'http://127.0.0.1:5080';
// Путь к браузеру берётся из окружения: на другой машине он другой, а зашитый путь
// превращал набор в неработающий у всех, кроме одной установки. Пусто значит
// «пусть Playwright возьмёт свой», как он и делает по умолчанию.
const EXE = process.env.SK_CHROME || undefined;
const SP = '' + (process.env.SK_RABOTA || '.') + '';

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const p = await (await browser.newContext({ viewport: { width: 1500, height: 1200 } })).newPage();
await p.goto(BASE + '/admin/');
await p.fill('#password', 'test123'); await p.click('#loginForm button[type=submit]');
await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
await p.evaluate(async () => {
  const page = (n, cond) => ({
    headingRuns: [{ text: n, bold: true, size: 'l', color: '#dc2626' }],
    blocks: [{ runs: [{ text: 'Пожалуйста, внимательно ознакомьтесь с текстом ниже.' }] },
             { runs: [{ text: 'Второй блок' }], visibleWhen: cond }],
    checkboxes: [{ key: 'consent', label: 'Согласен с условиями', required: true }],
    groups: n === 'Шаг 2. Согласия' ? [{ key: 'transfer', title: 'Трансграничная передача', required: true,
      options: [{ key: 'allow', label: 'Разрешаю' }, { key: 'deny', label: 'Запрещаю' }] }] : []
  });
  await fetch('/api/admin/document', {
    method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: 'Согласие на обработку персональных данных', signPrompt: 'Распишитесь', thankYouText: 'Спасибо', idleReturnSec: 0,
      pages: [page('Шаг 1. Ознакомление', { field: 'Пол', op: 'eq', value: 'F' }),
              page('Шаг 2. Согласия'), page('Шаг 3. Подтверждение')],
      signBlocks: [], signBlocksBelow: []
    })
  });
});
await p.reload();
await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
await p.click('.tab[data-tab="document"]');
await p.waitForSelector('[data-role="pagecard"]', { timeout: 5000 });
// Вторую и третью страницы сворачиваем, чтобы на снимке были видны оба состояния.
const toggles = p.locator('.page-toggle');
await toggles.nth(1).click(); await p.waitForTimeout(120);
await toggles.nth(2).click(); await p.waitForTimeout(250);
await p.evaluate(() => window.scrollTo(0, 0));
await p.waitForTimeout(200);
await p.screenshot({ path: SP + '/v48_top.png', fullPage: false });
await p.evaluate(() => window.scrollTo(0, 900));
await p.waitForTimeout(200);
await p.screenshot({ path: SP + '/v48_editor.png', fullPage: false });

const bad = await p.evaluate(() => {
  const out = [];
  document.querySelectorAll('[data-panel="document"] *').forEach(e => {
    if (e.scrollWidth > e.clientWidth + 2 && getComputedStyle(e).overflowX === 'visible')
      out.push((e.className || e.tagName) + ' ' + e.scrollWidth + '>' + e.clientWidth);
  });
  return { page: document.documentElement.scrollWidth > window.innerWidth, bad: out.slice(0, 5) };
});
console.log('вкладка документа: перенос страницы=' + bad.page + ' нарушители=' + JSON.stringify(bad.bad));
await browser.close();
