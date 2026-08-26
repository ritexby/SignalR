import { chromium } from 'playwright';
const BASE = 'http://127.0.0.1:5080';
// Путь к браузеру берётся из окружения: на другой машине он другой, а зашитый путь
// превращал набор в неработающий у всех, кроме одной установки. Пусто значит
// «пусть Playwright возьмёт свой», как он и делает по умолчанию.
const EXE = process.env.SK_CHROME || undefined;
const SP = '' + (process.env.SK_RABOTA || '.') + '';
const browser = await chromium.launch({ executablePath: EXE, headless: true });
const p = await (await browser.newContext({ viewport: { width: 1500, height: 1000 } })).newPage();
const jsErr = []; p.on('pageerror', e => jsErr.push(e.message));
await p.goto(BASE + '/admin/');
await p.fill('#password', 'test123'); await p.click('#loginForm button[type=submit]');
await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
await p.evaluate(async () => {
  const j = (pa, b) => fetch('/api/admin' + pa, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: b });
  await j('/groups', '{"name":"Зал 1"}');
  await j('/workstations', '{"externalId":"WS-204","name":"Регистратура","location":"1 этаж"}');
  await j('/apikeys', '{"label":"ERP"}');
});
await p.reload(); await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
const tabs = await p.locator('.tab').evaluateAll(ns => ns.map(n => n.dataset.tab));
const без = [];
for (const t of tabs) {
  await p.click('.tab[data-tab="' + t + '"]');
  await p.waitForTimeout(500);
  const r = await p.evaluate(() => {
    const panel = document.querySelector('[data-panel]:not(.hidden)');
    const btns = Array.from(panel.querySelectorAll('button.btn, a.btn')).filter(b => b.offsetParent !== null);
    return btns.filter(b => !b.querySelector('svg') && b.textContent.trim().length > 2)
      .map(b => b.textContent.trim().slice(0, 24));
  });
  if (r.length) без.push(t + ': ' + JSON.stringify(r));
}
console.log(без.length ? 'кнопки без значка:\n' + без.join('\n') : 'все видимые кнопки со значками');
if (jsErr.length) console.log('ошибки JS: ' + jsErr.join(' | '));
await p.click('.tab[data-tab="devices"]');
await p.waitForTimeout(400);
await p.screenshot({ path: SP + '/v50_tabs.png', fullPage: false });
await browser.close();
