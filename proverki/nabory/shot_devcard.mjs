import { chromium } from 'playwright';
const BASE = 'http://127.0.0.1:5080';
// Путь к браузеру берётся из окружения: на другой машине он другой, а зашитый путь
// превращал набор в неработающий у всех, кроме одной установки. Пусто значит
// «пусть Playwright возьмёт свой», как он и делает по умолчанию.
const EXE = process.env.SK_CHROME || undefined;
const SP = '' + (process.env.SK_RABOTA || '.') + '';
const browser = await chromium.launch({ executablePath: EXE, headless: true });
const admin = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
await admin.goto(BASE + '/admin/');
await admin.fill('#password', 'test123'); await admin.click('#loginForm button[type=submit]');
await admin.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
const call = (path, opts) => admin.evaluate(async ([pa, o]) => {
  const r = await fetch('/api/admin' + pa, Object.assign({ credentials: 'same-origin' }, o || {}));
  let b = null; try { b = await r.json(); } catch {} return b;
}, [path, opts]);
const ws = await call('/workstations', { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ externalId: 'WS-204', name: 'Регистратура 2', location: 'первый этаж, у окна' }) });
const en = await call('/devices/enroll', { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: 'Стойка регистратуры', workstationId: ws.id }) });
const kiosk = await (await browser.newContext()).newPage();
await kiosk.goto(BASE + '/?enroll=' + encodeURIComponent(en.code));
await kiosk.waitForFunction(() => !!localStorage.getItem('sk_device_token'), { timeout: 12000 });
await admin.reload();
await admin.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
await admin.click('.tab[data-tab="devices"]');
await admin.waitForSelector('.dev-id-code', { timeout: 5000 });
await admin.waitForTimeout(400);
await admin.locator('.dev-item').first().screenshot({ path: SP + '/v50_devcard.png' });
console.log(await admin.evaluate(() => Array.from(document.querySelectorAll('.dev-meta')).map(e => e.textContent.trim()).join('\n')));
await browser.close();
