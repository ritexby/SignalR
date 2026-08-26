import { chromium } from 'playwright';
const BASE = 'http://127.0.0.1:5080';
// Путь к браузеру берётся из окружения: на другой машине он другой, а зашитый путь
// превращал набор в неработающий у всех, кроме одной установки. Пусто значит
// «пусть Playwright возьмёт свой», как он и делает по умолчанию.
const EXE = process.env.SK_CHROME || undefined;
const browser = await chromium.launch({ executablePath: EXE, headless: true });
const p = await (await browser.newContext({ viewport: { width: 900, height: 1000 } })).newPage();
await p.goto(BASE + '/admin/');
await p.fill('#password', 'test123'); await p.click('#loginForm button[type=submit]');
await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
await p.click('.tab[data-tab="devices"]');
await p.waitForTimeout(400);
console.log(JSON.stringify(await p.evaluate(() => {
  const vw = document.documentElement.clientWidth;
  const out = [];
  document.querySelectorAll('body *').forEach(e => {
    const st = getComputedStyle(e);
    if (st.display === 'none') return;
    const r = e.getBoundingClientRect();
    if (r.right > vw + 1) out.push({ cls: (e.className || e.tagName).toString().slice(0, 50), right: Math.round(r.right), w: Math.round(r.width), minW: st.minWidth });
  });
  return { vw, scroll: document.documentElement.scrollWidth, over: out.slice(0, 12) };
}), null, 1));
await browser.close();
