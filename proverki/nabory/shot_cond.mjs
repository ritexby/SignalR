// The condition row with its two dropdowns, at the widths an operator uses.
import { chromium } from 'playwright';
const BASE = 'http://127.0.0.1:5080';
// Путь к браузеру берётся из окружения: на другой машине он другой, а зашитый путь
// превращал набор в неработающий у всех, кроме одной установки. Пусто значит
// «пусть Playwright возьмёт свой», как он и делает по умолчанию.
const EXE = process.env.SK_CHROME || undefined;
const SP = '' + (process.env.SK_RABOTA || '.') + '';

const browser = await chromium.launch({ executablePath: EXE, headless: true });
for (const width of [820, 1280]) {
  const p = await (await browser.newContext({ viewport: { width, height: 1200 } })).newPage();
  await p.goto(BASE + '/admin/');
  await p.fill('#password', 'test123'); await p.click('#loginForm button[type=submit]');
  await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
  await p.evaluate(async () => {
    await fetch('/api/admin/document', {
      method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Согласие', signPrompt: 'Распишитесь', thankYouText: 'Спасибо', idleReturnSec: 0,
        pages: [{
          headingRuns: [{ text: 'Шаг 1. Ознакомление', bold: true, size: 'h', color: '#dc2626' }],
          blocks: [{ runs: [{ text: 'Текст блока' }], visibleWhen: { field: 'Пол', op: 'eq', value: 'F' } }],
          checkboxes: [
            { key: 'consent', label: 'Согласен с условиями', required: true, checked: false },
            { key: 'marketing', label: 'Согласен на рассылку', required: false, checked: false }
          ],
          groups: [{ key: 'transfer', title: 'Трансграничная передача', required: true,
            options: [{ key: 'allow', label: 'Разрешаю' }, { key: 'deny', label: 'Запрещаю' }] }]
        }],
        signBlocks: [], signBlocksBelow: []
      })
    });
  });
  await p.reload();
  await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
  await p.click('.tab[data-tab="document"]');
  await p.waitForSelector('.cond-box', { timeout: 5000 });
  await p.waitForTimeout(400);
  await p.locator('[data-role="pagecard"]').first().screenshot({ path: SP + '/v47_page_' + width + '.png' });

  const bad = await p.evaluate(() => {
    const out = [];
    document.querySelectorAll('[data-role="pagecard"] *').forEach(e => {
      if (e.scrollWidth > e.clientWidth + 2 && getComputedStyle(e).overflowX === 'visible')
        out.push((e.className || e.tagName) + ' ' + e.scrollWidth + '>' + e.clientWidth);
    });
    return out.slice(0, 5);
  });
  console.log(width + 'px карточка страницы: offenders=' + JSON.stringify(bad));
}
await browser.close();
