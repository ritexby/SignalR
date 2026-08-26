import { chromium } from 'playwright';
const BASE = 'http://127.0.0.1:5080';
// Путь к браузеру берётся из окружения: на другой машине он другой, а зашитый путь
// превращал набор в неработающий у всех, кроме одной установки. Пусто значит
// «пусть Playwright возьмёт свой», как он и делает по умолчанию.
const EXE = process.env.SK_CHROME || undefined;
const SP = '' + (process.env.SK_RABOTA || '.') + '';
const browser = await chromium.launch({ executablePath: EXE, headless: true });
const p = await (await browser.newContext({ viewport: { width: 1500, height: 900 } })).newPage();
await p.goto(BASE + '/admin/');
await p.fill('#password', 'test123'); await p.click('#loginForm button[type=submit]');
await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
await p.evaluate(async () => {
  await fetch('/api/admin/document', { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Согласие', signPrompt: 'Распишитесь', thankYouText: 'Спасибо', idleReturnSec: 0,
      pages: [{ headingRuns: [{ text: 'Данные' }],
        blocks: [{ runs: [{ text: 'ФИО: {{ФИО}}, ДР: {{ДР}}, пол: {{ПОЛ}}, почта: {{email}}, адрес: {{Адрес регистрации}}, тел: {{telephone}}, опечатка: {{ФИ0}}' }], ord: 0 }],
        checkboxes: [], groups: [] }], signBlocks: [], signBlocksBelow: [] }) });
});
await p.reload();
await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
await p.click('.tab[data-tab="document"]');
// Справка о тегах свёрнута, чтобы не занимать четверть экрана. Раскрываем её, как это делает
// оператор: список тегов живёт внутри неё.
await p.evaluate(() => { var d = document.querySelector('.tags-box'); if (d) d.open = true; });
await p.waitForSelector('.placeholders .ph-tag', { timeout: 5000 });
await p.waitForTimeout(300);
await p.locator('.note-box').first().screenshot({ path: SP + '/v50_tags.png' });
const info = await p.evaluate(() => ({
  всего: document.querySelectorAll('.placeholders .ph-tag').length,
  выделено: document.querySelectorAll('.placeholders .ph-used').length,
  неизвестных: Array.from(document.querySelectorAll('.placeholders .ph-unknown')).map(e => e.textContent),
  перенос: document.documentElement.scrollWidth > window.innerWidth
}));
console.log(JSON.stringify(info, null, 1));
await browser.close();
