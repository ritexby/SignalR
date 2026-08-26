import { chromium } from 'playwright';
const BASE = 'http://127.0.0.1:5080';
// Путь к браузеру берётся из окружения: на другой машине он другой, а зашитый путь
// превращал набор в неработающий у всех, кроме одной установки. Пусто значит
// «пусть Playwright возьмёт свой», как он и делает по умолчанию.
const EXE = process.env.SK_CHROME || undefined;
const SP = '' + (process.env.SK_RABOTA || '.') + '';
const browser = await chromium.launch({ executablePath: EXE, headless: true });
const p = await (await browser.newContext({ viewport: { width: 1400, height: 1300 } })).newPage();
await p.goto(BASE + '/admin/');
await p.fill('#password', 'test123'); await p.click('#loginForm button[type=submit]');
await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
await p.evaluate(async () => {
  await fetch('/api/admin/document', { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Информационное соглашение', signPrompt: 'Распишитесь', thankYouText: 'Спасибо', idleReturnSec: 180,
      pages: [{ headingRuns: [{ text: 'Данные' }],
        blocks: [{ runs: [{ text: 'Пациент: {{ФИО}}, {{ДР}}, пол {{ПОЛ}}, {{email}}, {{Адрес регистрации}}, {{telephone}}' }], ord: 0 }],
        checkboxes: [{ key: 'sms', label: 'Согласен на СМС', required: false, ord: 1 },
                     { key: 'viber', label: 'Опросы в Viber', required: false, ord: 2 }],
        groups: [{ key: 'transfer', title: 'Трансграничная передача', required: false, ord: 3,
          options: [{ key: 'allow', label: 'Разрешаю' }, { key: 'deny', label: 'Запрещаю' }] }] }],
      signBlocks: [], signBlocksBelow: [] }) });
  const e = await (await fetch('/api/admin/devices/enroll', { method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' }, body: '{"name":"Регистратура 1"}' })).json();
  window.__code = e.code;
});
const code = await p.evaluate(() => window.__code);
const k = await (await browser.newContext()).newPage();
await k.goto(BASE + '/?enroll=' + encodeURIComponent(code));
await k.waitForFunction(() => !!localStorage.getItem('sk_device_token'), { timeout: 12000 });
await p.reload(); await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
await p.click('.tab[data-tab="document"]');
await p.waitForTimeout(700);
await p.click('#previewDoc');
await p.waitForSelector('.preview-setup', { timeout: 5000 });
await p.waitForTimeout(400);
await p.locator('.modal-card, .modal > div, .preview-setup').first().screenshot({ path: SP + '/v51_preview_setup.png' });
await browser.close();
