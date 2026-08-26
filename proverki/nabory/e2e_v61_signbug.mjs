// Подписание при включённом наблюдении: после подписи клиент должен увидеть «Спасибо», а не
// начать документ заново с первой страницы.
import { chromium } from 'playwright';
const BASE = 'http://127.0.0.1:5080';
// Путь к браузеру берётся из окружения: на другой машине он другой, а зашитый путь
// превращал набор в неработающий у всех, кроме одной установки. Пусто значит
// «пусть Playwright возьмёт свой», как он и делает по умолчанию.
const EXE = process.env.SK_CHROME || undefined;
let fail = 0;
const ok = (c, m) => { if (c) console.log('PASS', m); else { console.error('FAIL', m); fail++; } };

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const p = await (await browser.newContext({ viewport: { width: 1500, height: 950 } })).newPage();
await p.goto(BASE + '/admin/');
await p.fill('#password', 'test123'); await p.click('#loginForm button[type=submit]');
await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
const call = (path, opts) => p.evaluate(async ([pa, o]) => {
  const r = await fetch('/api/admin' + pa, Object.assign({ credentials: 'same-origin' }, o || {}));
  let b = null; try { b = await r.json(); } catch {} return { status: r.status, body: b };
}, [path, opts]);

await call('/document', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
  title: 'СОГЛАСИЕ', signPrompt: 'Распишитесь', thankYouText: 'Спасибо, документ подписан', idleReturnSec: 0,
  pages: [{ headingRuns: [{ text: 'Условия' }], blocks: [{ runs: [{ text: 'Текст.' }], ord: 0 }],
    checkboxes: [{ key: 'ok', label: 'Согласен', required: true, ord: 1 }], groups: [], signatures: [], scans: [] }],
  signBlocks: [], signBlocksBelow: [] }) });

const заведи = async (имя) => {
  const code = (await call('/devices/enroll', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: имя }) })).body.code;
  const k = await (await browser.newContext({ viewport: { width: 800, height: 1200 } })).newPage();
  await k.goto(BASE + '/?enroll=' + encodeURIComponent(code));
  await k.waitForFunction(() => !!localStorage.getItem('sk_device_token'), { timeout: 12000 });
  let id = null;
  for (let i = 0; i < 40; i++) {
    const d = (await call('/devices')).body || [];
    const on = d.find(x => x.online && x.name === имя);
    if (on) { id = on.id; break; }
    await k.waitForTimeout(250);
  }
  return { page: k, id: id };
};

const подписать = async (k) => {
  await k.waitForSelector('.check', { timeout: 8000 });
  await k.evaluate(() => {
    document.querySelectorAll('.checks .check input').forEach(x => { x.checked = true; x.dispatchEvent(new Event('change', { bubbles: true })); });
    document.getElementById('btnNext').click();
  });
  await k.waitForSelector('.sign-screen canvas', { timeout: 8000 });
  const b = await k.locator('.sign-screen .sign-wrap').boundingBox();
  await k.mouse.move(b.x + 30, b.y + b.height / 2);
  await k.mouse.down();
  await k.mouse.move(b.x + b.width - 40, b.y + b.height / 2 - 25, { steps: 12 });
  await k.mouse.up();
  await k.waitForTimeout(300);
  await k.evaluate(() => document.getElementById('btnSign').click());
};

const состояние = async (k) => k.evaluate(() => {
  const t = document.body.textContent.replace(/\s+/g, ' ');
  return {
    спасибо: /Спасибо, документ подписан/.test(t),
    перваяСтраница: !!document.querySelector('.checks .check'),
    реклама: !document.getElementById('document') || document.getElementById('document').classList.contains('hidden'),
    шаг: (t.match(/Шаг \d+ из \d+/) || [''])[0]
  };
});

// 1. Без наблюдения: как эталон.
const a = await заведи('Без наблюдения');
await call('/show-document', { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ target: 'device:' + a.id, fields: {} }) });
await подписать(a.page);
await a.page.waitForTimeout(2500);
const безНаблюдения = await состояние(a.page);
ok(безНаблюдения.спасибо, 'без наблюдения после подписи показано «Спасибо»: ' + JSON.stringify(безНаблюдения));
ok(!безНаблюдения.перваяСтраница, 'и документ не начался заново');

// 2. С наблюдением: должно быть то же самое.
const b2 = await заведи('Под наблюдением');
await p.click('[data-tab="devices"]'); await p.waitForTimeout(900);
// Наблюдение открывается отдельным окном браузера.
const [окно] = await Promise.all([
  p.context().waitForEvent('page', { timeout: 15000 }),
  p.locator('.dev-item', { hasText: 'Под наблюдением' }).locator('button', { hasText: 'Смотреть' }).click()
]);
await окно.waitForLoadState();
await окно.waitForSelector('.watch-screen', { timeout: 15000 });
await окно.waitForTimeout(600);
ok(await окно.locator('.watch-screen').count() === 1, 'наблюдение включено');

await call('/show-document', { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ target: 'device:' + b2.id, fields: {} }) });
await подписать(b2.page);
await b2.page.waitForTimeout(2500);
const сНаблюдением = await состояние(b2.page);
ok(сНаблюдением.спасибо, 'с наблюдением после подписи тоже «Спасибо»: ' + JSON.stringify(сНаблюдением));
ok(!сНаблюдением.перваяСтраница, 'и документ НЕ начался заново');

// 3. И дальше планшет уходит в рекламу, а не остаётся в документе.
await b2.page.waitForTimeout(6000);
const потом = await состояние(b2.page);
ok(!потом.перваяСтраница, 'спустя время документ не открылся снова: ' + JSON.stringify(потом));

// 4. Подпись сохранилась ровно одна на каждый планшет.
const подписи = (await call('/signatures')).body || [];
ok(подписи.length === 2, 'сохранено две подписи, по одной на планшет: ' + подписи.length);

await browser.close();
console.log(fail === 0 ? '\nВСЁ ПРОЙДЕНО' : '\n' + fail + ' ПРОВЕРОК УПАЛО');
process.exit(fail === 0 ? 0 : 1);
