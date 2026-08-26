// Обход всех вкладок админки: переносы, вылезание за край, пустые состояния и тексты.
import { chromium } from 'playwright';
const BASE = 'http://127.0.0.1:5080';
// Путь к браузеру берётся из окружения: на другой машине он другой, а зашитый путь
// превращал набор в неработающий у всех, кроме одной установки. Пусто значит
// «пусть Playwright возьмёт свой», как он и делает по умолчанию.
const EXE = process.env.SK_CHROME || undefined;
const SP = '' + (process.env.SK_RABOTA || '.') + '';
const browser = await chromium.launch({ executablePath: EXE, headless: true });

for (const width of [1600, 1400, 1280, 1100, 980, 860, 760]) {
  const p = await (await browser.newContext({ viewport: { width, height: 1000 } })).newPage();
  const jsErr = []; p.on('pageerror', e => jsErr.push(e.message));
  await p.goto(BASE + '/admin/');
  await p.fill('#password', 'test123'); await p.click('#loginForm button[type=submit]');
  await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });

  const tabs = await p.locator('.tab').evaluateAll(ns => ns.map(n => n.dataset.tab + '|' + n.textContent.trim()));
  for (const t of tabs) {
    const key = t.split('|')[0];
    await p.click('.tab[data-tab="' + key + '"]');
    await p.waitForTimeout(500);
    const bad = await p.evaluate(() => {
      const out = [];
      document.querySelectorAll('[data-panel]:not(.hidden) *').forEach(e => {
        const st = getComputedStyle(e);
        if (st.display === 'none' || st.visibility === 'hidden') return;
        if (e.scrollWidth > e.clientWidth + 2 && st.overflowX === 'visible' && e.clientWidth > 0)
          out.push((e.className || e.tagName) + ' ' + e.scrollWidth + '>' + e.clientWidth);
      });
      return { page: document.documentElement.scrollWidth > window.innerWidth + 1, bad: out.slice(0, 4) };
    });
    if (bad.page || bad.bad.length) console.log(width + 'px ' + key + ': перенос=' + bad.page + ' ' + JSON.stringify(bad.bad));
  }
  if (jsErr.length) console.log(width + 'px ошибки JS: ' + jsErr.join(' | '));
  await p.context().close();
}
await browser.close();
console.log('обход завершён');
