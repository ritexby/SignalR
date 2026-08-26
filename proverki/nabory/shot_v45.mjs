// Screenshots of the new v4.5 screens at the widths an operator actually uses, plus an
// automatic check that nothing overflows its container horizontally.
import { chromium } from 'playwright';

const BASE = 'http://127.0.0.1:5080';
// Путь к браузеру берётся из окружения: на другой машине он другой, а зашитый путь
// превращал набор в неработающий у всех, кроме одной установки. Пусто значит
// «пусть Playwright возьмёт свой», как он и делает по умолчанию.
const EXE = process.env.SK_CHROME || undefined;
const TABLET_IP = process.env.TABLET_IP || '192.0.2.2';
const SP = '' + (process.env.SK_RABOTA || '.') + '';

const browser = await chromium.launch({ executablePath: EXE, headless: true });

for (const width of [820, 1100, 1280, 1920]) {
  const ctx = await browser.newContext({ viewport: { width, height: 1100 } });
  const p = await ctx.newPage();
  await p.goto(BASE + '/admin/');
  await p.fill('#password', 'test123'); await p.click('#loginForm button[type=submit]');
  await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });

  // A tablet with a control address, so the card and the modal have something to show.
  await p.evaluate(async (ip) => {
    const enr = await (await fetch('/api/admin/devices/enroll', { method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Планшет ресепшн 1', ttlMinutes: 30 }) })).json();
    const dev = await (await fetch('/api/kiosk/enroll', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: enr.code, name: 'Планшет ресепшн 1' }) })).json();
    await fetch('/api/admin/kiosk-control/settings', { method: 'PUT', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true, port: 8099, apiKey: 'secret-key', timeoutSec: 4,
        autoHeal: true, autoHealAfterMinutes: 15, batteryWarnPercent: 20, storageWarnPercent: 10 }) });
    await fetch('/api/admin/devices/' + dev.deviceId + '/control-address', { method: 'PUT', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ip: ip, port: null }) });
  }, TABLET_IP);

  await p.click('.tab[data-tab="devices"]');
  await p.waitForSelector('[data-panel="devices"]:not(.hidden)', { timeout: 4000 });
  await p.waitForTimeout(600);
  await p.screenshot({ path: SP + '/v45_devices_' + width + '.png', fullPage: true });

  // Anything wider than the viewport means an unwanted horizontal scroll.
  const overflow = await p.evaluate(() => {
    const bad = [];
    document.querySelectorAll('[data-panel="devices"] *').forEach(e => {
      if (e.scrollWidth > e.clientWidth + 2 && getComputedStyle(e).overflowX === 'visible')
        bad.push((e.className || e.tagName) + ' ' + e.scrollWidth + '>' + e.clientWidth);
    });
    return { page: document.documentElement.scrollWidth > window.innerWidth, bad: bad.slice(0, 8) };
  });
  console.log(width + 'px devices panel: page overflow=' + overflow.page + ' offenders=' + JSON.stringify(overflow.bad));

  await p.locator('.dev-item button', { hasText: 'Управление' }).first().click();
  await p.waitForSelector('.ctl-wrap', { timeout: 4000 });
  await p.waitForTimeout(1200);
  await p.screenshot({ path: SP + '/v45_control_' + width + '.png' });
  const modalOverflow = await p.evaluate(() => {
    const bad = [];
    document.querySelectorAll('.ctl-wrap *').forEach(e => {
      if (e.scrollWidth > e.clientWidth + 2 && getComputedStyle(e).overflowX === 'visible')
        bad.push((e.className || e.tagName) + ' ' + e.scrollWidth + '>' + e.clientWidth);
    });
    return bad.slice(0, 8);
  });
  console.log(width + 'px control modal: offenders=' + JSON.stringify(modalOverflow));

  await ctx.close();
}

await browser.close();
