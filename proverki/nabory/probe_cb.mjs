import { chromium } from 'playwright';
const BASE = 'http://127.0.0.1:5080';
// Путь к браузеру берётся из окружения: на другой машине он другой, а зашитый путь
// превращал набор в неработающий у всех, кроме одной установки. Пусто значит
// «пусть Playwright возьмёт свой», как он и делает по умолчанию.
const EXE = process.env.SK_CHROME || undefined;
const browser = await chromium.launch({ executablePath: EXE, headless: true });
const p = await (await browser.newContext({ viewport: { width: 1500, height: 1100 } })).newPage();
await p.goto(BASE + '/admin/');
await p.fill('#password', 'test123'); await p.click('#loginForm button[type=submit]');
await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
await p.evaluate(async () => {
  await fetch('/api/admin/document', { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Т', signPrompt: 'П', thankYouText: 'С', idleReturnSec: 0,
      pages: [{ headingRuns: [{ text: 'С' }], blocks: [{ runs: [{ text: 'А' }], ord: 0 }],
        checkboxes: [{ key: 'c1', label: 'Пункт', required: true, ord: 1 }],
        groups: [{ key: 'g1', title: 'В', required: false, ord: 2, options: [{ key: 'a', label: 'П' }, { key: 'b', label: 'В' }] }] }],
      signBlocks: [], signBlocksBelow: [] }) });
});
await p.reload();
await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
await p.click('.tab[data-tab="document"]');
await p.waitForSelector('[data-role="itemlist"]', { timeout: 5000 });
console.log(await p.evaluate(() => {
  const out = [];
  document.querySelectorAll('[data-role="cbrow"]').forEach(n => {
    out.push({ роль: n.getAttribute('data-role') || n.className,
      кнопки: Array.from(n.querySelectorAll('button')).map(b => b.className + '|' + b.textContent.trim() + '|видна=' + (b.offsetParent !== null)) });
  });
  return out;
}));
await browser.close();
