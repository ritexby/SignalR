import { chromium } from 'playwright';
const BASE = 'http://127.0.0.1:5080';
// Путь к браузеру берётся из окружения: на другой машине он другой, а зашитый путь
// превращал набор в неработающий у всех, кроме одной установки. Пусто значит
// «пусть Playwright возьмёт свой», как он и делает по умолчанию.
const EXE = process.env.SK_CHROME || undefined;
const SP = '' + (process.env.SK_RABOTA || '.') + '';
const browser = await chromium.launch({ executablePath: EXE, headless: true });
const admin = await (await browser.newContext({ viewport: { width: 1500, height: 1000 } })).newPage();
await admin.goto(BASE + '/admin/');
await admin.fill('#password', 'test123'); await admin.click('#loginForm button[type=submit]');
await admin.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
const call = (path, opts) => admin.evaluate(async ([pa, o]) => {
  const r = await fetch('/api/admin' + pa, Object.assign({ credentials: 'same-origin' }, o || {}));
  let b = null; try { b = await r.json(); } catch {} return b;
}, [path, opts]);
const ws = await call('/workstations', { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ externalId: 'WS-204', name: 'Регистратура 2', location: 'первый этаж' }) });
for (const n of ['Стойка регистратуры', 'Второй планшет']) {
  const e = await call('/devices/enroll', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: n, workstationId: ws.id }) });
  const k = await (await browser.newContext()).newPage();
  await k.goto(BASE + '/?enroll=' + encodeURIComponent(e.code));
  await k.waitForFunction(() => !!localStorage.getItem('sk_device_token'), { timeout: 12000 });
  if (n !== 'Стойка регистратуры') await k.context().close();
}
await admin.reload();
await admin.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
await admin.click('.tab[data-tab="devices"]');
await admin.waitForSelector('.dev-item', { timeout: 5000 });
await admin.waitForTimeout(600);
await admin.locator('.dev-item').first().screenshot({ path: SP + '/v50_devbtns.png' });
console.log(JSON.stringify(await admin.evaluate(() => {
  const a = document.querySelector('.dev-actions');
  return { кнопки: Array.from(a.querySelectorAll('button')).map(b => b.className.replace('btn ', '') + '|' + b.textContent.trim()),
    разделитель: !!a.querySelector('.tb-sep'),
    значков: a.querySelectorAll('svg').length };
}), null, 1));
await browser.close();
