import { chromium } from 'playwright';
const BASE = 'http://127.0.0.1:5080';
// Путь к браузеру берётся из окружения: на другой машине он другой, а зашитый путь
// превращал набор в неработающий у всех, кроме одной установки. Пусто значит
// «пусть Playwright возьмёт свой», как он и делает по умолчанию.
const EXE = process.env.SK_CHROME || undefined;
const SP = '' + (process.env.SK_RABOTA || '.') + '';
const browser = await chromium.launch({ executablePath: EXE, headless: true });
const p = await (await browser.newContext({ viewport: { width: 1500, height: 1000 } })).newPage();
await p.goto(BASE + '/admin/');
await p.fill('#password', 'test123'); await p.click('#loginForm button[type=submit]');
await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
for (const имя of ['Регистратура 1', 'Регистратура 2', 'Процедурная', 'Касса']) {
  const e = await p.evaluate(async n => {
    const r = await fetch('/api/admin/devices/enroll', { method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: n }) });
    return await r.json();
  }, имя);
  const k = await (await browser.newContext()).newPage();
  await k.goto(BASE + '/?enroll=' + encodeURIComponent(e.code));
  await k.waitForFunction(() => !!localStorage.getItem('sk_device_token'), { timeout: 12000 });
  await k.context().close();
}
await p.reload(); await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
await p.selectOption('#slidesTarget', 'devices');
await p.waitForTimeout(400);
await p.locator('#slidesDevices input[data-device]').nth(0).check();
await p.locator('#slidesDevices input[data-device]').nth(2).check();
await p.waitForTimeout(200);
await p.locator('.panel[data-panel="slides"] .toolbar').screenshot({ path: SP + '/v51_multi_top.png' }).catch(() => {});
await p.locator('#slidesDevices').screenshot({ path: SP + '/v51_multi.png' });
console.log(JSON.stringify(await p.evaluate(() => ({
  перенос: document.documentElement.scrollWidth > window.innerWidth,
  отмечено: document.querySelectorAll('#slidesDevices input:checked').length
}))));
await browser.close();
