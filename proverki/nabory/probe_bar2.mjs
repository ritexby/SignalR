import { chromium } from 'playwright';
const BASE = 'http://127.0.0.1:5080';
// Путь к браузеру берётся из окружения: на другой машине он другой, а зашитый путь
// превращал набор в неработающий у всех, кроме одной установки. Пусто значит
// «пусть Playwright возьмёт свой», как он и делает по умолчанию.
const EXE = process.env.SK_CHROME || undefined;
const SP = '' + (process.env.SK_RABOTA || '.') + '';
const browser = await chromium.launch({ executablePath: EXE, headless: true });
const p = await (await browser.newContext({ viewport: { width: 1600, height: 1000 } })).newPage();
const jsErr = []; p.on('pageerror', e => jsErr.push(e.message));
await p.goto(BASE + '/admin/');
await p.fill('#password', 'test123'); await p.click('#loginForm button[type=submit]');
await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
await p.evaluate(async () => {
  const абз = 'Пожалуйста, проверьте правильность указанных персональных и контактных данных. Если данные требуют актуализации, сообщите медицинскому регистратору.';
  await fetch('/api/admin/document', { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'ИНФОРМАЦИОННОЕ СОГЛАШЕНИЕ', signPrompt: 'Распишитесь', thankYouText: 'Спасибо', idleReturnSec: 180,
      pages: [1,2,3].map(n => ({ headingRuns: [{ text: n + '. Проверка персональных данных', bold: true }],
        blocks: [{ runs: [{ text: абз }], ord: 0 }, { runs: [{ text: абз }], ord: 1 }],
        checkboxes: [{ key: 'c' + n, label: 'Пункт ' + n, required: true, ord: 2 }], groups: [] })),
      signBlocks: [], signBlocksBelow: [] }) });
});
await p.reload(); await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
await p.click('.tab[data-tab="document"]');
await p.waitForSelector('#rtBarHost .rt-toolbar', { timeout: 5000 });

await p.waitForTimeout(500);
console.log('панель на месте всегда:', await p.locator('#rtBarHost .rt-toolbar').count() === 1);
console.log('пока не выбрано поле, неактивна:', await p.locator('.rt-idle').count() === 1);
await p.locator('.block-card .rt-editor').first().click();
await p.waitForTimeout(300);
console.log('после клика активна:', await p.locator('.rt-idle').count() === 0);
// Ничего ли она закрывает: сравниваем прямоугольники панели и соседних элементов.
console.log(JSON.stringify(await p.evaluate(() => {
  const bar = document.querySelector('#rtBarHost .rt-toolbar').getBoundingClientRect();
  const перекрыто = [];
  document.querySelectorAll('[data-panel="document"] .cond-badge, [data-panel="document"] .seg, [data-panel="document"] .rt-editor, [data-panel="document"] .section-label').forEach(e => {
    const r = e.getBoundingClientRect();
    if (r.width === 0 || r.bottom < 0 || r.top > window.innerHeight) return;
    const пересечение = !(r.right < bar.left || r.left > bar.right || r.bottom < bar.top || r.top > bar.bottom);
    if (пересечение) перекрыто.push((e.className || '').toString().slice(0, 30));
  });
  return { перекрыто: перекрыто.slice(0, 5) };
}), null, 1));
await p.evaluate(() => window.scrollTo(0, 900));
await p.waitForTimeout(300);
console.log('при прокрутке панель осталась видна:', await p.evaluate(() => {
  const r = document.querySelector('#rtBarHost .rt-toolbar').getBoundingClientRect();
  return r.top >= 0 && r.bottom <= window.innerHeight;
}));
await p.screenshot({ path: SP + '/v52_bar_docked.png', fullPage: false });
console.log('ошибки JS:', jsErr.length ? jsErr.join(' | ') : 'нет');
await browser.close();
