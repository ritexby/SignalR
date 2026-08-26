// Тексты, которые видит клиент на планшете, и тексты ошибок в админке. Ищем то, что можно
// понять неправильно: обещания, которые система не выполняет, и советы, которые не помогут.
import { chromium } from 'playwright';
const BASE = 'http://127.0.0.1:5080';
// Путь к браузеру берётся из окружения: на другой машине он другой, а зашитый путь
// превращал набор в неработающий у всех, кроме одной установки. Пусто значит
// «пусть Playwright возьмёт свой», как он и делает по умолчанию.
const EXE = process.env.SK_CHROME || undefined;
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
  title: 'Согласие на обработку данных', signPrompt: 'Распишитесь ниже', thankYouText: 'Спасибо! Ваша подпись принята.', idleReturnSec: 0,
  pages: [{ headingRuns: [{ text: 'Ознакомление' }], blocks: [{ runs: [{ text: 'Текст соглашения.' }], ord: 0 }],
    checkboxes: [{ key: 'c1', label: 'Согласен с условиями', required: true, ord: 1 }],
    groups: [{ key: 'g1', title: 'Трансграничная передача', required: true, ord: 2,
      options: [{ key: 'da', label: 'Разрешаю' }, { key: 'net', label: 'Запрещаю' }] }] }],
  signBlocks: [], signBlocksBelow: [] }) });

const code = (await post('/devices/enroll', { name: 'Стойка' })).body.code;
const kiosk = await (await browser.newContext({ viewport: { width: 800, height: 1280 } })).newPage();
await kiosk.goto(BASE + '/?enroll=' + encodeURIComponent(code));
await kiosk.waitForFunction(() => !!localStorage.getItem('sk_device_token'), { timeout: 12000 });
let deviceId = null;
for (let i = 0; i < 40; i++) {
  const d = (await call('/devices')).body || [];
  const on = d.find(x => x.online); if (on) { deviceId = on.id; break; }
  await kiosk.waitForTimeout(250);
}
console.log('--- экран рекламы (пустой плейлист) ---');
console.log(await kiosk.evaluate(() => document.body.innerText.replace(/\n{2,}/g, '\n').trim().slice(0, 300)));

await post('/show-document', { target: 'device:' + deviceId, fields: {} });
await kiosk.waitForSelector('.doc-body', { timeout: 8000 });
console.log('--- страница документа ---');
console.log(await kiosk.evaluate(() => document.getElementById('document').innerText.replace(/\n{2,}/g, '\n').trim()));

console.log('--- кнопка «Далее» пока ничего не отмечено ---');
console.log(JSON.stringify(await kiosk.evaluate(() => {
  const b = document.getElementById('btnNext');
  return { выключена: b.disabled, подсказка: (document.getElementById('footerNote') || {}).textContent };
})));
// Отмечаем всё обязательное и смотрим, что меняется.
await kiosk.evaluate(() => {
  document.querySelectorAll('.checks .check input').forEach(i => { i.checked = true; i.dispatchEvent(new Event('change', { bubbles: true })); });
  const g = document.querySelector('.group input'); if (g) { g.checked = true; g.dispatchEvent(new Event('change', { bubbles: true })); }
});
await kiosk.waitForTimeout(300);
console.log('--- после отметок ---');
console.log(JSON.stringify(await kiosk.evaluate(() => {
  const b = document.getElementById('btnNext');
  return { выключена: b.disabled, подсказка: (document.getElementById('footerNote') || {}).textContent };
})));
await kiosk.screenshot({ path: '' + (process.env.SK_RABOTA || '.') + '/v50_kiosk_required.png' });
await browser.close();
