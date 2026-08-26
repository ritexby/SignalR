// Пустые состояния: что видит человек, открывший систему в первый раз. Каждая вкладка должна
// объяснять, что здесь делать, а не показывать пустоту.
import { chromium } from 'playwright';
const BASE = 'http://127.0.0.1:5080';
// Путь к браузеру берётся из окружения: на другой машине он другой, а зашитый путь
// превращал набор в неработающий у всех, кроме одной установки. Пусто значит
// «пусть Playwright возьмёт свой», как он и делает по умолчанию.
const EXE = process.env.SK_CHROME || undefined;
const SP = '' + (process.env.SK_RABOTA || '.') + '';
const browser = await chromium.launch({ executablePath: EXE, headless: true });
const p = await (await browser.newContext({ viewport: { width: 1400, height: 1000 } })).newPage();
await p.goto(BASE + '/admin/');
await p.fill('#password', 'test123'); await p.click('#loginForm button[type=submit]');
await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
const tabs = await p.locator('.tab').evaluateAll(ns => ns.map(n => n.dataset.tab));
for (const key of tabs) {
  await p.click('.tab[data-tab="' + key + '"]');
  await p.waitForTimeout(600);
  const text = await p.evaluate(() => {
    const panel = document.querySelector('[data-panel]:not(.hidden)');
    return panel ? panel.innerText.replace(/\n{2,}/g, '\n').trim().slice(0, 500) : '(нет панели)';
  });
  console.log('===== ' + key + ' =====');
  console.log(text);
}
await browser.close();
