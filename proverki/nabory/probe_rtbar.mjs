import { chromium } from 'playwright';
const BASE = 'http://127.0.0.1:5080';
// Путь к браузеру берётся из окружения: на другой машине он другой, а зашитый путь
// превращал набор в неработающий у всех, кроме одной установки. Пусто значит
// «пусть Playwright возьмёт свой», как он и делает по умолчанию.
const EXE = process.env.SK_CHROME || undefined;
const SP = '' + (process.env.SK_RABOTA || '.') + '';
const browser = await chromium.launch({ executablePath: EXE, headless: true });
const p = await (await browser.newContext({ viewport: { width: 1600, height: 1200 } })).newPage();
const jsErr = []; p.on('pageerror', e => jsErr.push(e.message));
await p.goto(BASE + '/admin/');
await p.fill('#password', 'test123'); await p.click('#loginForm button[type=submit]');
await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
await p.evaluate(async () => {
  const абзац = 'Настоящим я подтверждаю, что ознакомлен с порядком оказания услуг и с условиями обработки моих персональных данных.';
  const стр = (n, зг, k) => ({ headingRuns: [{ text: n + '. ' + зг, bold: true }],
    blocks: [{ runs: [{ text: абзац }], ord: 0 }, { runs: [{ text: абзац + ' ' + абзац }], ord: 1 }],
    checkboxes: Array.from({ length: k }, (_, i) => ({ key: 'p' + n + '_' + i, label: 'ДА / НЕТ Пункт ' + (i + 1), required: true, ord: 2 + i })), groups: [] });
  await fetch('/api/admin/document', { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'СОГЛАШЕНИЕ', signPrompt: 'Распишитесь', thankYouText: 'Спасибо', idleReturnSec: 180,
      pages: [стр(1,'Проверка',2), стр(2,'Согласие',4), стр(3,'Информация',3), стр(4,'Исследование',5), стр(5,'Дополнительно',6)],
      signBlocks: [], signBlocksBelow: [] }) });
});
await p.reload(); await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
await p.click('.tab[data-tab="document"]');
await p.waitForSelector('[data-role="pagecard"]', { timeout: 5000 });
await p.waitForTimeout(600);
console.log('панелей в разметке:', await p.locator('.rt-toolbar').count());
console.log('видимых кнопок:', await p.evaluate(() => {
  let n = 0; document.querySelectorAll('[data-panel="document"] button, [data-panel="document"] a.btn').forEach(b => { if (b.offsetParent) n++; });
  return n;
}));
console.log('высота страницы:', await p.evaluate(() => document.documentElement.scrollHeight));
await p.locator('.rt-editor').first().click();
await p.waitForTimeout(300);
console.log('после клика в поле панель видна:', await p.locator('.rt-float:not(.hidden)').count() === 1);
const пол = await p.evaluate(() => {
  const b = document.querySelector('.rt-float'), e = document.querySelectorAll('.rt-editor')[0];
  const rb = b.getBoundingClientRect(), re = e.getBoundingClientRect();
  return { панельНад: rb.bottom <= re.top + 2, слеваСовпадает: Math.abs(rb.left - re.left) < 3 };
});
console.log('положение:', JSON.stringify(пол));
await p.screenshot({ path: SP + '/v52_rtbar.png', fullPage: false });
// Сворачиваем все элементы и смотрим, во что превращается страница.
await p.evaluate(() => {
  document.querySelectorAll('.item-toggle').forEach(t => t.click());
});
await p.waitForTimeout(400);
console.log('после сворачивания высота:', await p.evaluate(() => document.documentElement.scrollHeight));
console.log('свёрнутых элементов:', await p.locator('.item-collapsed').count());
console.log('сводки видны:', await p.evaluate(() => {
  const s = document.querySelector('.item-collapsed .item-summary');
  return s ? s.textContent.slice(0, 50) : '(нет)';
}));
await p.evaluate(() => window.scrollTo(0, 0));
await p.waitForTimeout(200);
await p.screenshot({ path: SP + '/v52_collapsed.png', fullPage: false });
console.log('ошибки JS:', jsErr.length ? jsErr.join(' | ') : 'нет');
await browser.close();
