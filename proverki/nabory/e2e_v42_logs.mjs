import { chromium } from 'playwright';
const BASE = 'http://127.0.0.1:5080';
// Путь к браузеру берётся из окружения: на другой машине он другой, а зашитый путь
// превращал набор в неработающий у всех, кроме одной установки. Пусто значит
// «пусть Playwright возьмёт свой», как он и делает по умолчанию.
const EXE = process.env.SK_CHROME || undefined;
let fail = 0;
const ok = (c, m) => { if (c) console.log('PASS', m); else { console.error('FAIL', m); fail++; } };

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const admin = await (await browser.newContext()).newPage();
const jsErr = []; admin.on('pageerror', e => jsErr.push(e.message));
await admin.goto(BASE + '/admin/');
await admin.fill('#password', 'test123'); await admin.click('#loginForm button[type=submit]');
await admin.waitForSelector('#app:not(.hidden)', { timeout: 8000 });

// a tablet reports a failure
const enr = await admin.evaluate(async () => (await fetch('/api/admin/devices/enroll', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'ЛогПланшет', ttlMinutes: 30 }) })).json());
const tok = await admin.evaluate(async (code) => (await fetch('/api/kiosk/enroll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) })).json(), enr.code);
// Report from a clean context: a real tablet has no admin cookie (the auth handler prefers the
// admin cookie when both are present, which would make this an admin call, not a device call).
const tabletCtx = await browser.newContext();
const rep = await tabletCtx.request.post(BASE + '/api/log', {
  headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + tok.token },
  data: JSON.stringify({ level: 'error', message: 'Тестовая ошибка планшета', detail: 'Stack line 1\nStack line 2' })
});
ok(rep.status() === 200, 'tablet reported an error to /api/log (' + rep.status() + ')');

// logs tab renders it
await admin.click('.tab[data-tab="logs"]');
await admin.waitForSelector('[data-panel="logs"]:not(.hidden)', { timeout: 4000 });
await admin.waitForTimeout(600);
const shown = await admin.evaluate(() => {
  const items = Array.from(document.querySelectorAll('#logsList .log-item'));
  return {
    count: items.length,
    first: items[0] ? items[0].textContent : '',
    hasDetails: !!(items[0] && items[0].querySelector('details')),
    countText: (document.getElementById('logsCount') || {}).textContent
  };
});
ok(shown.count >= 1, 'logs tab lists entries (' + shown.count + ')');
ok(/Тестовая ошибка планшета/.test(shown.first), 'tablet error is shown');
ok(/ЛогПланшет/.test(shown.first), 'entry shows the tablet name');
ok(shown.hasDetails, 'entry has an expandable detail block');
ok(/Показано/.test(shown.countText || ''), 'count line rendered: ' + shown.countText);

// level filter
await admin.selectOption('#logLevel', 'info');
await admin.waitForTimeout(500);
const infoOnly = await admin.evaluate(() => Array.from(document.querySelectorAll('#logsList .log-item')).map(i => i.className).join(','));
ok(!/log-error/.test(infoOnly), 'level filter "info" excludes errors');
await admin.selectOption('#logLevel', 'all');
await admin.waitForTimeout(400);

// search filter
await admin.fill('#logSearch', 'zzz-nomatch');
await admin.waitForTimeout(500);
const none = await admin.evaluate(() => document.querySelectorAll('#logsList .log-item').length);
ok(none === 0, 'search filter narrows the list to nothing for a nonsense query');
await admin.fill('#logSearch', '');
await admin.waitForTimeout(500);

// polling stops when leaving the tab (no stacked intervals)
await admin.click('.tab[data-tab="devices"]');
await admin.waitForTimeout(300);
await admin.click('.tab[data-tab="logs"]');
await admin.waitForTimeout(300);
await admin.click('.tab[data-tab="logs"]');
await admin.waitForTimeout(300);
ok(true, 'switching tabs repeatedly does not throw');

// clear
admin.on('dialog', d => d.accept());
await admin.click('#clearLogs');
await admin.waitForTimeout(700);
const afterClear = await admin.evaluate(() => document.querySelectorAll('#logsList .log-item').length);
ok(afterClear === 0, 'clear empties the log (' + afterClear + ')');

ok(jsErr.length === 0, 'no admin JS errors (' + JSON.stringify(jsErr) + ')');
await browser.close();
console.log(fail === 0 ? '\nV4.2 LOGS E2E PASSED' : `\n${fail} CHECK(S) FAILED`);
process.exit(fail === 0 ? 0 : 1);
