// Точный путь оператора: «Отправить на планшет» → «Заполнить примером» → «Отправить на планшет».
import { chromium } from 'playwright';
const BASE = 'http://127.0.0.1:5080';
// Путь к браузеру берётся из окружения: на другой машине он другой, а зашитый путь
// превращал набор в неработающий у всех, кроме одной установки. Пусто значит
// «пусть Playwright возьмёт свой», как он и делает по умолчанию.
const EXE = process.env.SK_CHROME || undefined;
const browser = await chromium.launch({ executablePath: EXE, headless: true });
const p = await (await browser.newContext({ viewport: { width: 1500, height: 1100 } })).newPage();
const jsErr = []; p.on('pageerror', e => jsErr.push(e.message));
const failed = []; p.on('requestfailed', r => failed.push(r.url() + ' ' + (r.failure() || {}).errorText));
const responses = []; p.on('response', r => { if (r.url().indexOf('/api/') >= 0) responses.push(r.status() + ' ' + r.url().replace(BASE, '')); });
p.on('dialog', d => { console.log('ДИАЛОГ:', d.message()); d.accept(); });
await p.goto(BASE + '/admin/');
await p.fill('#password', 'test123'); await p.click('#loginForm button[type=submit]');
await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
await p.evaluate(async () => {
  await fetch('/api/admin/document', { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Информационное соглашение', signPrompt: 'Распишитесь', thankYouText: 'Спасибо', idleReturnSec: 180,
      pages: [{ headingRuns: [{ text: '1. Проверка данных' }],
        blocks: [{ runs: [{ text: '{{ФИО}}, {{ДР}}, {{ПОЛ}}, {{email}}, {{Адрес регистрации}}, {{telephone}}' }], ord: 0 }],
        checkboxes: [], groups: [] }], signBlocks: [], signBlocksBelow: [] }) });
  const e = await (await fetch('/api/admin/devices/enroll', { method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' }, body: '{"name":"Tablet"}' })).json();
  window.__code = e.code;
});
const code = await p.evaluate(() => window.__code);
const k = await (await browser.newContext()).newPage();
await k.goto(BASE + '/?enroll=' + encodeURIComponent(code));
await k.waitForFunction(() => !!localStorage.getItem('sk_device_token'), { timeout: 12000 });
await p.reload(); await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
await p.click('.tab[data-tab="document"]');
await p.waitForTimeout(800);

console.log('--- нажимаю «Отправить на планшет» ---');
await p.click('#showDocument');
await p.waitForTimeout(1200);
console.log('модалка открылась:', await p.locator('.modal .field').count() > 0);
console.log('есть окно замечаний:', await p.locator('.problems').count());

await p.locator('.modal button', { hasText: 'Заполнить примером' }).click();
await p.waitForTimeout(400);
console.log('ФИО после примера:', await p.locator('.modal input[type=text]').first().inputValue());

console.log('--- нажимаю «Отправить на планшет» в окне ---');
const send = p.locator('.modal button', { hasText: 'Отправить на планшет' });
console.log('кнопок «Отправить на планшет» в окне:', await send.count());
await send.last().click();
await p.waitForTimeout(1800);
console.log('модалка закрылась:', await p.locator('.modal .field').count() === 0);
console.log('всплывающее сообщение:', await p.evaluate(() => (document.querySelector('.toast') || {}).textContent || '(нет)'));
console.log('на планшете:', await k.evaluate(() => {
  const b = document.querySelector('.doc-body');
  return b ? b.textContent.slice(0, 90) : '(документа нет)';
}));
console.log('запросы:', JSON.stringify(responses.slice(-6)));
console.log('ошибки JS:', jsErr.length ? jsErr.join(' | ') : 'нет');
console.log('неудачные запросы:', failed.length ? failed.join(' | ') : 'нет');
await browser.close();
