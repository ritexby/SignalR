import { chromium } from 'playwright';
const BASE = 'http://127.0.0.1:5080';
// Путь к браузеру берётся из окружения: на другой машине он другой, а зашитый путь
// превращал набор в неработающий у всех, кроме одной установки. Пусто значит
// «пусть Playwright возьмёт свой», как он и делает по умолчанию.
const EXE = process.env.SK_CHROME || undefined;
const browser = await chromium.launch({ executablePath: EXE, headless: true });
const p = await (await browser.newContext({ viewport: { width: 1500, height: 1000 } })).newPage();
await p.goto(BASE + '/admin/');
await p.fill('#password', 'test123'); await p.click('#loginForm button[type=submit]');
await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
await p.evaluate(async () => {
  await fetch('/api/admin/document', { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Т', signPrompt: 'П', thankYouText: 'С', idleReturnSec: 0,
      pages: [{ headingRuns: [{ text: 'С' }],
        blocks: [{ runs: [{ text: 'А1' }], ord: 0 }, { runs: [{ text: 'А2' }], ord: 2 }],
        checkboxes: [{ key: 'c1', label: 'П1', required: true, ord: 1 }, { key: 'c2', label: 'П2', required: true, ord: 3 }, { key: 'c3', label: 'П3', required: true, ord: 4 }],
        groups: [{ key: 'g', title: 'В', required: false, ord: 5, options: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }] }] }],
      signBlocks: [], signBlocksBelow: [] }) });
});
await p.reload(); await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
await p.click('.tab[data-tab="document"]');
await p.waitForSelector('[data-role="itemlist"]', { timeout: 5000 });
await p.waitForTimeout(400);
const виды = () => p.evaluate(() => Array.from(document.querySelectorAll('[data-role="itemlist"] > .page-item')).map(n => n.getAttribute('data-kind')));
console.log('до:', JSON.stringify(await виды()));
const items = p.locator('[data-role="itemlist"] > .page-item');
await p.evaluate(() => document.querySelectorAll('.item-toggle').forEach(t => t.click()));
await p.waitForTimeout(300);
console.log('высота страницы после сворачивания:', await p.evaluate(() => document.documentElement.scrollHeight));
await p.evaluate(() => {
  const l = document.querySelector('[data-role="itemlist"]');
  window.scrollTo(0, l.getBoundingClientRect().top + window.scrollY - 200);
});
await p.waitForTimeout(300);
console.log('прокрутка:', await p.evaluate(() => window.scrollY));
const h = await items.first().locator('.drag-handle').first().boundingBox();
const t = await items.nth(3).boundingBox();
console.log('ручка y=' + Math.round(h.y) + ', цель y=' + Math.round(t.y) + ', высота окна 1000');
await p.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
await p.mouse.down();
await p.mouse.move(t.x + t.width / 2, t.y + t.height / 2, { steps: 15 });
console.log('после движения:', JSON.stringify(await виды()), 'прокрутка=' + await p.evaluate(() => window.scrollY));
await p.mouse.move(t.x + t.width / 2, t.y + t.height / 2 + 8, { steps: 5 });
await p.mouse.up();
await p.waitForTimeout(400);
console.log('после:', JSON.stringify(await виды()));
await browser.close();
