// Сообщение планшета при неудачной отправке подписи должно соответствовать причине. Повтор
// помогает только при обрыве связи. Если сессия уже закрыта, надо звать сотрудника, а не
// заставлять человека жать кнопку, которая не сработает никогда.
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
  let b = null; try { b = await r.json(); } catch {} return { status: r.status, body: b };
}, [path, opts]);
const post = (path, obj) => call(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });

await call('/document', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
  title: 'Согласие', signPrompt: 'Распишитесь', thankYouText: 'Спасибо', idleReturnSec: 0,
  pages: [{ headingRuns: [{ text: 'Страница' }], blocks: [{ runs: [{ text: 'Текст' }], ord: 0 }], checkboxes: [], groups: [] }],
  signBlocks: [], signBlocksBelow: [] }) });

const code = (await post('/devices/enroll', { name: 'Подписной' })).body.code;
const kiosk = await (await browser.newContext()).newPage();
await kiosk.goto(BASE + '/?enroll=' + encodeURIComponent(code));
await kiosk.waitForFunction(() => !!localStorage.getItem('sk_device_token'), { timeout: 12000 });
let deviceId = null;
for (let i = 0; i < 40; i++) {
  const d = (await call('/devices')).body || [];
  const on = d.find(x => x.online); if (on) { deviceId = on.id; break; }
  await kiosk.waitForTimeout(250);
}
ok(!!deviceId, 'планшет на связи');

async function расписаться() {
  await post('/show-document', { target: 'device:' + deviceId, fields: {} });
  await kiosk.waitForSelector('.doc-body', { timeout: 8000 });
  await kiosk.click('.doc-footer button:last-child');
  await kiosk.waitForSelector('canvas', { timeout: 8000 });
  const box = await kiosk.locator('.sign-wrap').boundingBox();
  await kiosk.mouse.move(box.x + 30, box.y + box.height / 2);
  await kiosk.mouse.down();
  await kiosk.mouse.move(box.x + box.width - 40, box.y + box.height / 2 - 20, { steps: 10 });
  await kiosk.mouse.up();
  await kiosk.waitForTimeout(250);
}

const нажать = () => kiosk.evaluate(() => {
  const b = Array.from(document.querySelectorAll('.doc-footer button')).find(x => /ПОДПИСАТЬ|Подписать/i.test(x.textContent));
  if (b) b.click();
});
const подпись = () => kiosk.evaluate(() => { const n = document.getElementById('footerNote'); return n && n.textContent; });

// Случай первый: сервер отвечает, что сессия уже закрыта. Так бывает, когда оператор вернул
// рекламу, пока планшет был без связи, и планшет об этом ещё не знает. Повтор бессмысленен.
await расписаться();
await kiosk.route('**/api/sign', route => route.fulfill({
  status: 409, contentType: 'application/json',
  body: JSON.stringify({ error: 'no document is being signed on this tablet' })
}));
await нажать();
await kiosk.waitForTimeout(1000);
let note = await подпись();
ok(/завершена/i.test(note || ''), 'при закрытой сессии сказано, что надо звать сотрудника: ' + note);
ok(!/ещё раз/i.test(note || ''), 'и не предлагается бесполезный повтор');
const заблокирована = await kiosk.evaluate(() => {
  const b = Array.from(document.querySelectorAll('.doc-footer button')).find(x => /ПОДПИСАТЬ|Подписать/i.test(x.textContent));
  return !b || b.disabled;
});
ok(заблокирована, 'кнопка не предлагает жать её впустую');

// Случай второй: планшет отвязали. Сообщение другое, и повтор тоже не предлагается.
await kiosk.unroute('**/api/sign');
await расписаться();
await kiosk.route('**/api/sign', route => route.fulfill({ status: 401, contentType: 'application/json', body: '{}' }));
await нажать();
await kiosk.waitForTimeout(1000);
note = await подпись();
ok(/доступ/i.test(note || '') && !/ещё раз/i.test(note || ''), 'при потере доступа сказано именно это: ' + note);
await kiosk.unroute('**/api/sign');

// Случай третий: пропала связь. Повтор как раз помогает, и это должно быть сказано.
await расписаться();
await kiosk.route('**/api/sign', route => route.abort());
await нажать();
await kiosk.waitForTimeout(1200);
note = await подпись();
ok(/нет связи/i.test(note || '') && /ещё раз/i.test(note || ''),
  'при обрыве связи предложено повторить: ' + note);
const canRetry = await kiosk.evaluate(() => {
  const b = Array.from(document.querySelectorAll('.doc-footer button')).find(x => /ПОДПИСАТЬ|Подписать/i.test(x.textContent));
  return b && !b.disabled;
});
ok(canRetry, 'и кнопка снова доступна');

// Повтор после восстановления связи проходит и не создаёт второй записи.
await kiosk.unroute('**/api/sign');
await нажать();
await kiosk.waitForTimeout(1500);
const sigs = (await call('/signatures')).body || [];
ok(sigs.length === 1, 'подпись сохранена ровно один раз: ' + sigs.length);

await browser.close();
console.log(fail === 0 ? '\nВСЁ ПРОЙДЕНО' : '\n' + fail + ' ПРОВЕРОК УПАЛО');
process.exit(fail === 0 ? 0 : 1);
