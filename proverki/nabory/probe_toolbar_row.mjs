import { chromium } from 'playwright';
const BASE = 'http://127.0.0.1:5080';
// Путь к браузеру берётся из окружения: на другой машине он другой, а зашитый путь
// превращал набор в неработающий у всех, кроме одной установки. Пусто значит
// «пусть Playwright возьмёт свой», как он и делает по умолчанию.
const EXE = process.env.SK_CHROME || undefined;
const SP = '' + (process.env.SK_RABOTA || '.') + '';
const browser = await chromium.launch({ executablePath: EXE, headless: true });
for (const w of [1600, 1400, 1200]) {
  const p = await (await browser.newContext({ viewport: { width: w, height: 1000 } })).newPage();
  await p.goto(BASE + '/admin/');
  await p.fill('#password', 'test123'); await p.click('#loginForm button[type=submit]');
  await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
  await p.evaluate(async () => {
    await fetch('/api/admin/document', { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'ИНФОРМАЦИОННОЕ СОГЛАШЕНИЕ', signPrompt: 'Распишитесь', thankYouText: 'Спасибо', idleReturnSec: 180,
        pages: [{ headingRuns: [{ text: '1. Проверка' }], blocks: [{ runs: [{ text: 'Текст соглашения' }], ord: 0 }],
          checkboxes: [{ key: 'c1', label: 'Пункт', required: true, ord: 1 }], groups: [] }],
        signBlocks: [], signBlocksBelow: [] }) });
    const e = await (await fetch('/api/admin/devices/enroll', { method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' }, body: '{"name":"Маяковского 129а к2 раб.место 1"}' })).json();
    window.__c = e.code;
  });
  const code = await p.evaluate(() => window.__c);
  const k = await (await browser.newContext()).newPage();
  await k.goto(BASE + '/?enroll=' + encodeURIComponent(code));
  await k.waitForFunction(() => !!localStorage.getItem('sk_device_token'), { timeout: 12000 });
  await p.reload(); await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
  await p.click('.tab[data-tab="document"]');
  await p.waitForTimeout(700);
  const было = await p.evaluate(() => {
    const b = document.querySelectorAll('.toolbar-actions .btn');
    const строки = new Set(); b.forEach(x => строки.add(Math.round(x.getBoundingClientRect().top)));
    return { строк: строки.size, высотаПанели: Math.round(document.querySelector('.toolbar').getBoundingClientRect().height) };
  });
  await p.locator('#docTitle').fill('ИЗМЕНЕНО');
  await p.waitForTimeout(400);
  const стало = await p.evaluate(() => {
    const b = document.querySelectorAll('.toolbar-actions .btn');
    const строки = new Set(); b.forEach(x => строки.add(Math.round(x.getBoundingClientRect().top)));
    return { строк: строки.size, пометкаВидна: !document.getElementById('docDirty').classList.contains('hidden'),
      высотаПанели: Math.round(document.querySelector('.toolbar').getBoundingClientRect().height) };
  });
  console.log(w + 'px: до=' + JSON.stringify(было) + ' после=' + JSON.stringify(стало) +
    ' ряд кнопок не изменился=' + (было.строк === стало.строк));
  if (w === 1600) await p.screenshot({ path: SP + '/v52_toolbar_row.png', fullPage: false });
  await p.context().close();
}
await browser.close();
