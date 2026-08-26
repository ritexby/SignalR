import { chromium } from 'playwright';
const BASE = 'http://127.0.0.1:5080';
// Путь к браузеру берётся из окружения: на другой машине он другой, а зашитый путь
// превращал набор в неработающий у всех, кроме одной установки. Пусто значит
// «пусть Playwright возьмёт свой», как он и делает по умолчанию.
const EXE = process.env.SK_CHROME || undefined;
const browser = await chromium.launch({ executablePath: EXE, headless: true });
const p = await (await browser.newContext({ viewport: { width: 1500, height: 1000 } })).newPage();
const jsErr = []; p.on('pageerror', e => jsErr.push(e.message));
await p.goto(BASE + '/admin/');
await p.fill('#password', 'test123'); await p.click('#loginForm button[type=submit]');
await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
await p.evaluate(async () => {
  await fetch('/api/admin/document', { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Т', signPrompt: 'П', thankYouText: 'С', idleReturnSec: 0,
      pages: [{ headingRuns: [{ text: 'С' }], blocks: [{ runs: [{ text: 'А' }], ord: 0 }],
        checkboxes: [{ key: 'c1', label: 'Пункт', required: true, ord: 1 }], groups: [] }],
      signBlocks: [], signBlocksBelow: [] }) });
});
await p.reload(); await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
await p.click('.tab[data-tab="document"]');
await p.waitForTimeout(600);
await p.locator('[data-role="cblabel"]').first().fill('Другой текст');
await p.waitForTimeout(1600);
await p.reload(); await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
// Вкладка восстанавливается из адреса, поэтому окно черновика появляется само.
await p.waitForSelector('.modal h3', { timeout: 8000 });
console.log('заголовок окна:', await p.locator('.modal h3').textContent());
await p.locator('.modal button', { hasText: 'Восстановить черновик' }).click();
await p.waitForTimeout(600);
console.log('окно видно после восстановления:', await p.evaluate(() => {
  const m = document.getElementById('modal');
  return { класс: m.className, содержимое: (m.textContent || '').trim().slice(0, 60) };
}));
console.log('ошибки JS:', jsErr.length ? jsErr.join(' | ') : 'нет');
await browser.close();
