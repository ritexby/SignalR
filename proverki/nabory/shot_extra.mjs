import { chromium } from 'playwright';
const BASE = 'http://127.0.0.1:5080';
// Путь к браузеру берётся из окружения: на другой машине он другой, а зашитый путь
// превращал набор в неработающий у всех, кроме одной установки. Пусто значит
// «пусть Playwright возьмёт свой», как он и делает по умолчанию.
const EXE = process.env.SK_CHROME || undefined;
const SP = '' + (process.env.SK_RABOTA || '.') + '';
const browser = await chromium.launch({ executablePath: EXE, headless: true });
for (const w of [1500, 1100, 820]) {
  const p = await (await browser.newContext({ viewport: { width: w, height: 900 } })).newPage();
  await p.goto(BASE + '/admin/');
  await p.fill('#password', 'test123'); await p.click('#loginForm button[type=submit]');
  await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
  await p.click('.tab[data-tab="document"]');
  await p.waitForSelector('.doc-extra', { timeout: 5000 });
  await p.waitForTimeout(300);
  const clipped = await p.evaluate(() => Array.from(document.querySelectorAll('.doc-extra .field'))
    .map(f => ({ w: Math.round(f.getBoundingClientRect().width), scroll: f.scrollWidth, обрезано: f.scrollWidth > f.clientWidth + 1 })));
  console.log(w + 'px: ' + JSON.stringify(clipped));
  if (w === 1500) await p.locator('.doc-extra').screenshot({ path: SP + '/v50_extra.png' });
  await p.context().close();
}
await browser.close();
