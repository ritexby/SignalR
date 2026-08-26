// Страница со скрывающим условием на планшете. Раньше она показывалась всегда, а при отправке
// её отметки отбрасывались: человек видел страницу, ставил галочки, и они не попадали в запись.
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
  pages: [
    { headingRuns: [{ text: 'Первая' }], blocks: [],
      checkboxes: [{ key: 'sms', label: 'Согласен на СМС', required: false, ord: 0 }], groups: [] },
    { headingRuns: [{ text: 'ТОЛЬКО-ПРИ-СМС' }], visibleWhen: { field: 'sms', op: 'eq', value: 'true' },
      blocks: [{ runs: [{ text: 'Текст про СМС' }], ord: 0 }],
      checkboxes: [{ key: 'sms_detail', label: 'Уточнение про СМС', required: false, ord: 1 }], groups: [] },
    { headingRuns: [{ text: 'Третья' }], blocks: [{ runs: [{ text: 'Текст третьей' }], ord: 0 }], checkboxes: [], groups: [] }
  ],
  signBlocks: [], signBlocksBelow: [] }) });

const code = (await post('/devices/enroll', { name: 'Планшет' })).body.code;
const kiosk = await (await browser.newContext({ viewport: { width: 800, height: 1200 } })).newPage();
await kiosk.goto(BASE + '/?enroll=' + encodeURIComponent(code));
await kiosk.waitForFunction(() => !!localStorage.getItem('sk_device_token'), { timeout: 12000 });
let deviceId = null;
for (let i = 0; i < 40; i++) {
  const d = (await call('/devices')).body || [];
  const on = d.find(x => x.online); if (on) { deviceId = on.id; break; }
  await kiosk.waitForTimeout(250);
}
ok(!!deviceId, 'планшет на связи');
await post('/show-document', { target: 'device:' + deviceId, fields: {} });
await kiosk.waitForSelector('.check', { timeout: 8000 });

const шаг = () => kiosk.locator('#docProgress').textContent();
const заголовок = () => kiosk.evaluate(() => (document.querySelector('.doc-body h2') || {}).textContent || '');
const далее = () => kiosk.evaluate(() => { const b = document.getElementById('btnNext'); if (b && !b.disabled) b.click(); });

ok(/Шаг 1 из 3/.test(await шаг()), 'скрытая страница не входит в счётчик: ' + await шаг());
await далее(); await kiosk.waitForTimeout(300);
ok(/Третья/.test(await заголовок()), 'листание перескочило скрытую страницу: ' + await заголовок());

// Отмечаем: страница появляется в потоке.
await kiosk.evaluate(() => { const b = document.getElementById('btnBack') || document.querySelector('.doc-footer .btn-ghost'); if (b) b.click(); });
await kiosk.waitForTimeout(300);
await kiosk.evaluate(() => {
  const i = document.querySelector('.checks .check input');
  i.checked = true; i.dispatchEvent(new Event('change', { bubbles: true }));
});
await kiosk.waitForTimeout(300);
ok(/Шаг 1 из 4/.test(await шаг()), 'после отметки страница вошла в поток: ' + await шаг());
await далее(); await kiosk.waitForTimeout(300);
ok(/ТОЛЬКО-ПРИ-СМС/.test(await заголовок()), 'страница по условию открылась: ' + await заголовок());

// Отмечаем пункт на ней и подписываем: отметка обязана попасть в запись.
await kiosk.evaluate(() => {
  const i = document.querySelector('.checks .check input');
  i.checked = true; i.dispatchEvent(new Event('change', { bubbles: true }));
});
await kiosk.waitForTimeout(200);
await далее(); await kiosk.waitForTimeout(300);
await далее(); await kiosk.waitForTimeout(400);
await kiosk.waitForSelector('canvas', { timeout: 8000 });
const box = await kiosk.locator('.sign-wrap').boundingBox();
await kiosk.mouse.move(box.x + 30, box.y + box.height / 2);
await kiosk.mouse.down();
await kiosk.mouse.move(box.x + box.width - 40, box.y + box.height / 2 - 20, { steps: 10 });
await kiosk.mouse.up();
await kiosk.waitForTimeout(300);
await kiosk.evaluate(() => { const b = document.getElementById('btnSign'); if (b && !b.disabled) b.click(); });
await kiosk.waitForTimeout(2000);

const sigs = (await call('/signatures')).body || [];
ok(sigs.length === 1, 'подпись сохранена');
const rec = (await call('/signatures/' + sigs[0].id)).body;
const метки = (rec.items || []).map(i => i.key + '=' + i.checked);
ok(метки.indexOf('sms_detail=true') >= 0,
  'отметка со страницы по условию попала в запись: ' + JSON.stringify(метки));
ok(метки.indexOf('sms=true') >= 0, 'и отметка, включившая страницу, тоже: ' + JSON.stringify(метки));

await browser.close();
console.log(fail === 0 ? '\nВСЁ ПРОЙДЕНО' : '\n' + fail + ' ПРОВЕРОК УПАЛО');
process.exit(fail === 0 ? 0 : 1);
