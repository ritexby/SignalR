// Страница планшета, открытая в браузере, где уже выполнен вход в админку, должна работать как
// планшет, а не сыпать ошибками в журнал оператора.
import { chromium } from 'playwright';
const BASE = 'http://127.0.0.1:5080';
// Путь к браузеру берётся из окружения: на другой машине он другой, а зашитый путь
// превращал набор в неработающий у всех, кроме одной установки. Пусто значит
// «пусть Playwright возьмёт свой», как он и делает по умолчанию.
const EXE = process.env.SK_CHROME || undefined;
let fail = 0;
const ok = (c, m) => { if (c) console.log('PASS', m); else { console.error('FAIL', m); fail++; } };

const browser = await chromium.launch({ executablePath: EXE, headless: true });
// Один и тот же контекст: одна кука админки и один localStorage на обе страницы.
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const p = await ctx.newPage();
await p.goto(BASE + '/admin/');
await p.fill('#password', 'test123'); await p.click('#loginForm button[type=submit]');
await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
const call = (path, opts) => p.evaluate(async ([pa, o]) => {
  const r = await fetch('/api/admin' + pa, Object.assign({ credentials: 'same-origin' }, o || {}));
  let b = null; try { b = await r.json(); } catch {} return { status: r.status, body: b };
}, [path, opts]);

const code = (await call('/devices/enroll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"name":"Планшет оператора"}' })).body.code;

// Страница планшета в том же браузере, где открыта админка.
const kiosk = await ctx.newPage();
await kiosk.goto(BASE + '/?enroll=' + encodeURIComponent(code));
await kiosk.waitForFunction(() => !!localStorage.getItem('sk_device_token'), { timeout: 12000 });
await kiosk.waitForTimeout(1500);

let dev = null;
for (let i = 0; i < 40; i++) {
  const d = (await call('/devices')).body || []; dev = d.find(x => x.online);
  if (dev) break;
  await kiosk.waitForTimeout(250);
}
ok(!!dev, 'планшет вышел на связь из браузера с открытой админкой');
ok(!(await kiosk.locator('#enroll:not(.hidden)').count()), 'экран активации не показан');

// Переподключение: раньше именно оно наполняло журнал ошибками.
await kiosk.reload();
await kiosk.waitForTimeout(2000);
const снова = ((await call('/devices')).body || []).find(x => x.online);
ok(!!снова, 'после перезагрузки страницы планшет снова на связи');

// Журнал оператора не должен содержать ошибок регистрации.
const логи = (await call('/logs')).body || [];
const строки = JSON.stringify(логи);
ok(!/not a device connection/.test(строки), 'в журнале нет «not a device connection»');
ok(!/RegisterKiosk/.test(строки), 'и вообще нет ошибок регистрации: ' + строки.slice(0, 160));

// Документ доходит до такого планшета.
await call('/document', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
  title: 'ПРОВЕРКА', signPrompt: 'x', thankYouText: 'x', idleReturnSec: 0,
  pages: [{ headingRuns: [{ text: 'Страница' }], blocks: [{ runs: [{ text: 'Текст для планшета.' }], ord: 0 }],
    checkboxes: [], groups: [], signatures: [], scans: [] }], signBlocks: [], signBlocksBelow: [] }) });
await call('/show-document', { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ target: 'device:' + снова.id, fields: {} }) });
await kiosk.waitForTimeout(1200);
ok((await kiosk.textContent('body')).includes('Текст для планшета.'), 'документ дошёл до планшета');

await browser.close();
console.log(fail === 0 ? '\nВСЁ ПРОЙДЕНО' : '\n' + fail + ' ПРОВЕРОК УПАЛО');
process.exit(fail === 0 ? 0 : 1);
