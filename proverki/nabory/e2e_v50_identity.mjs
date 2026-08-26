// Идентификатор планшета не меняется: он выдаётся один раз при активации и живёт на сервере.
// Планшет помнит только токен, и помнит его в двух местах сразу, чтобы частичная чистка
// данных в WebView не лишала его привязки.
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
await admin.goto(BASE + '/admin/');
await admin.fill('#password', 'test123'); await admin.click('#loginForm button[type=submit]');
await admin.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
const call = (path, opts) => admin.evaluate(async ([pa, o]) => {
  const r = await fetch('/api/admin' + pa, Object.assign({ credentials: 'same-origin' }, o || {}));
  let body = null; try { body = await r.json(); } catch { body = null; }
  return { status: r.status, body };
}, [path, opts]);

const code = (await call('/devices/enroll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"name":"Стойка 1"}' })).body.code;

const ctx = await browser.newContext();
const kiosk = await ctx.newPage();
await kiosk.goto(BASE + '/?enroll=' + encodeURIComponent(code));
await kiosk.waitForFunction(() => !!localStorage.getItem('sk_device_token'), { timeout: 12000 });

const идентификатор = async () => {
  for (let i = 0; i < 40; i++) {
    const d = (await call('/devices')).body || [];
    const on = d.find(x => x.online);
    if (on) return on.id;
    await kiosk.waitForTimeout(250);
  }
  return null;
};
const first = await идентификатор();
ok(/^dev-[0-9a-f]{10}$/.test(first || ''), 'идентификатор выдан сервером при активации: ' + first);

// Токен лежит и в localStorage, и в cookie.
const where = await kiosk.evaluate(() => ({
  storage: !!localStorage.getItem('sk_device_token'),
  cookie: document.cookie.indexOf('sk_device_token=') >= 0
}));
ok(where.storage && where.cookie, 'токен сохранён в двух местах: ' + JSON.stringify(where));

// Перезагрузка страницы: тот же планшет, тот же идентификатор.
await kiosk.reload();
await kiosk.waitForTimeout(1500);
ok(await идентификатор() === first, 'после перезагрузки страницы идентификатор тот же');
ok(((await call('/devices')).body || []).length === 1, 'второй записи не появилось');

// Стёрли localStorage (в WebView это отдельный вызов): планшет восстанавливается из cookie.
await kiosk.evaluate(() => localStorage.removeItem('sk_device_token'));
await kiosk.reload();
await kiosk.waitForTimeout(1800);
ok(await идентификатор() === first, 'после чистки localStorage привязка уцелела');
ok(await kiosk.evaluate(() => !!localStorage.getItem('sk_device_token')),
  'и localStorage восстановлен из cookie');
ok(((await call('/devices')).body || []).length === 1, 'по-прежнему одна запись, дубля нет');

// Стёрли cookie: восстанавливается из localStorage.
await kiosk.context().clearCookies();
await kiosk.reload();
await kiosk.waitForTimeout(1800);
ok(await идентификатор() === first, 'после чистки cookie привязка тоже уцелела');
ok(await kiosk.evaluate(() => document.cookie.indexOf('sk_device_token=') >= 0),
  'и cookie восстановлен из localStorage');

// Полная чистка данных: планшет теряет привязку и просит активацию заново. Это ожидаемо.
await kiosk.context().clearCookies();
await kiosk.evaluate(() => localStorage.clear());
await kiosk.reload();
await kiosk.waitForSelector('#enrollLayer:not(.hidden), .enroll', { timeout: 8000 }).catch(() => {});
const asksEnroll = await kiosk.evaluate(() => !!document.querySelector('#code, #enrollCode, .enroll input'));
ok(asksEnroll, 'после полной чистки данных планшет просит код активации');
ok(((await call('/devices')).body || []).length === 1,
  'старая запись на сервере остаётся: идентификатор принадлежит записи, а не устройству');

await browser.close();
console.log(fail === 0 ? '\nВСЁ ПРОЙДЕНО' : '\n' + fail + ' ПРОВЕРОК УПАЛО');
process.exit(fail === 0 ? 0 : 1);
