import { chromium } from 'playwright';
const BASE = 'http://127.0.0.1:5080';
// Путь к браузеру берётся из окружения: на другой машине он другой, а зашитый путь
// превращал набор в неработающий у всех, кроме одной установки. Пусто значит
// «пусть Playwright возьмёт свой», как он и делает по умолчанию.
const EXE = process.env.SK_CHROME || undefined;
const SP = '' + (process.env.SK_RABOTA || '.') + '';
const browser = await chromium.launch({ executablePath: EXE, headless: true });
const p = await (await browser.newContext({ viewport: { width: 1600, height: 1100 } })).newPage();
await p.goto(BASE + '/admin/');
await p.fill('#password', 'test123'); await p.click('#loginForm button[type=submit]');
await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
await p.evaluate(async () => {
  await fetch('/api/admin/groups', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{"name":"Зал 1"}' });
  await fetch('/api/admin/schedule', { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify([
      { enabled: true, time: '06:50', days: [1,2,3,4,5], action: 'screen-on', target: 'all', skipBusy: true, note: 'Утро, перед открытием' },
      { enabled: true, time: '21:00', days: [1,2,3,4,5,6,7], action: 'screen-off', target: 'all', skipBusy: true, note: 'Закрытие' },
      { enabled: true, time: '03:30', days: [7], action: 'reboot', target: 'all', skipBusy: true, note: 'Ночная перезагрузка, раз в неделю' },
      { enabled: false, time: '19:00', days: [], action: 'brightness', value: 40, target: 'all', skipBusy: false, note: 'Вечером приглушить' }
    ]) });
});
await p.reload();
await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
await p.click('.tab[data-tab="devices"]');
await p.waitForSelector('[data-role="schrule"]', { timeout: 5000 });
await p.waitForTimeout(500);
await p.locator('#scheduleList').screenshot({ path: SP + '/v51_schedule.png' });
console.log(JSON.stringify(await p.evaluate(() => ({
  правил: document.querySelectorAll('[data-role="schrule"]').length,
  перенос: document.documentElement.scrollWidth > window.innerWidth
})), null, 1));
await browser.close();
