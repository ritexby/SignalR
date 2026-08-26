// The signature page card in the editor, with a block above and below.
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
        pages: [{ headingRuns: [{ text: 'Шаг 1' }], blocks: [{ runs: [{ text: 'Текст' }] }], checkboxes: [] }],
        signBlocks: [{ runs: [{ text: 'Подтверждаю согласие на обработку данных', bold: true }] }],
        signBlocksBelow: [{ runs: [{ text: 'ООО Ромашка, УНП 123456789, г. Минск' }] }]
      })
    });
  });
  await p.reload();
  await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
  await p.click('.tab[data-tab="document"]');
  await p.waitForSelector('.sign-page-card', { timeout: 5000 });
  await p.waitForTimeout(400);
  await p.locator('.sign-page-card').screenshot({ path: SP + '/v45_signpage_' + width + '.png' });

  const bad = await p.evaluate(() => {
    const out = [];
    document.querySelectorAll('.sign-page-card *').forEach(e => {
      if (e.scrollWidth > e.clientWidth + 2 && getComputedStyle(e).overflowX === 'visible')
        out.push((e.className || e.tagName) + ' ' + e.scrollWidth + '>' + e.clientWidth);
    });
    return out.slice(0, 5);
  });
  console.log(width + 'px sign page card: offenders=' + JSON.stringify(bad));
}
await browser.close();
