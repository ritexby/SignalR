// Экран «Спасибо» как настраиваемая страница: оформленный заголовок, блоки и время показа.
import { chromium } from 'playwright';
const BASE = 'http://127.0.0.1:5080';
// Путь к браузеру берётся из окружения: на другой машине он другой, а зашитый путь
// превращал набор в неработающий у всех, кроме одной установки. Пусто значит
// «пусть Playwright возьмёт свой», как он и делает по умолчанию.
const EXE = process.env.SK_CHROME || undefined;
let fail = 0;
const ok = (c, m) => { if (c) console.log('PASS', m); else { console.error('FAIL', m); fail++; } };
async function отказатьсяОтЧерновика(page) {
  // Окно появляется не сразу: черновик сравнивается с документом, а тот ещё едет с сервера.
  // Проверка «есть ли окно прямо сейчас» промахивалась, окно всплывало позже и перехватывало
  // нажатия, а набор падал на «кнопка недоступна», ничего не объясняя.
  const btn = page.locator('.modal button', { hasText: 'Отказаться от черновика' });
  try { await btn.waitFor({ state: 'visible', timeout: 2500 }); } catch { return; }
  await btn.click();
  await page.waitForTimeout(200);
}

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const p = await (await browser.newContext({ viewport: { width: 1500, height: 950 } })).newPage();
p.on('pageerror', e => console.log('ОШИБКА АДМИНКИ:', e.message));
await p.goto(BASE + '/admin/');
await p.fill('#password', 'test123'); await p.click('#loginForm button[type=submit]');
await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
const call = (path, opts) => p.evaluate(async ([pa, o]) => {
  const r = await fetch('/api/admin' + pa, Object.assign({ credentials: 'same-origin' }, o || {}));
  let b = null; try { b = await r.json(); } catch {} return { status: r.status, body: b };
}, [path, opts]);

await call('/document', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
  title: 'СОГЛАСИЕ', signPrompt: 'Распишитесь', idleReturnSec: 0,
  thankYouRuns: [{ text: 'Готово, ' }, { text: 'спасибо!', bold: true, color: '#16a34a', size: 'l' }],
  thankYouAlign: 'center',
  thankYouBlocks: [{ runs: [{ text: 'Документ подписан. Заберите свой экземпляр у администратора.' }], ord: 0, align: 'center' }],
  thankYouSec: 3,
  pages: [{ headingRuns: [{ text: 'Условия' }], blocks: [{ runs: [{ text: 'Текст.' }], ord: 0 }],
    checkboxes: [{ key: 'ok', label: 'Согласен', required: true, ord: 1 }], groups: [], signatures: [], scans: [] }],
  signBlocks: [], signBlocksBelow: [] }) });

const сохр = (await call('/document')).body;
ok((сохр.thankYouRuns || []).length === 2, 'оформленный заголовок сохранён: ' + JSON.stringify(сохр.thankYouRuns));
ok(сохр.thankYouText === 'Готово, спасибо!', 'простой текст собран из оформленного: ' + сохр.thankYouText);
ok((сохр.thankYouBlocks || []).length === 1, 'блок под заголовком сохранён');
ok(сохр.thankYouSec === 3, 'время показа сохранено: ' + сохр.thankYouSec);
ok(сохр.thankYouAlign === 'center', 'выравнивание сохранено');

// Границы времени.
const проверитьСек = async (v) => {
  const d = JSON.parse(JSON.stringify(сохр)); d.thankYouSec = v;
  await call('/document', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(d) });
  return (await call('/document')).body.thankYouSec;
};
ok((await проверитьСек(0)) === 6, 'ноль секунд приводится к шести');
ok((await проверитьСек(600)) === 60, 'больше минуты не бывает');
ok((await проверитьСек(1)) === 2, 'меньше двух секунд тоже');
await проверитьСек(3);

// Планшет: страница показывается целиком и держится заданное время.
const code = (await call('/devices/enroll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"name":"Планшет"}' })).body.code;
const kiosk = await (await browser.newContext({ viewport: { width: 900, height: 1400 } })).newPage();
await kiosk.goto(BASE + '/?enroll=' + encodeURIComponent(code));
await kiosk.waitForFunction(() => !!localStorage.getItem('sk_device_token'), { timeout: 12000 });
let id = null;
for (let i = 0; i < 40; i++) {
  const d = (await call('/devices')).body || []; const on = d.find(x => x.online);
  if (on) { id = on.id; break; }
  await kiosk.waitForTimeout(250);
}
await call('/show-document', { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ target: 'device:' + id, fields: {} }) });
await kiosk.waitForSelector('.check', { timeout: 8000 });
await kiosk.evaluate(() => {
  document.querySelectorAll('.checks .check input').forEach(x => { x.checked = true; x.dispatchEvent(new Event('change', { bubbles: true })); });
  document.getElementById('btnNext').click();
});
await kiosk.waitForSelector('.sign-screen canvas', { timeout: 8000 });
const b = await kiosk.locator('.sign-screen .sign-wrap').boundingBox();
await kiosk.mouse.move(b.x + 30, b.y + b.height / 2);
await kiosk.mouse.down();
await kiosk.mouse.move(b.x + b.width - 40, b.y + b.height / 2 - 20, { steps: 10 });
await kiosk.mouse.up();
await kiosk.waitForTimeout(300);
const t0 = Date.now();
await kiosk.evaluate(() => document.getElementById('btnSign').click());
await kiosk.waitForSelector('.thankyou', { timeout: 8000 });

const наЭкране = await kiosk.evaluate(() => {
  const t = document.querySelector('.thankyou');
  const h = t.querySelector('h2');
  const жирный = Array.from(h.querySelectorAll('*')).find(x => x.textContent === 'спасибо!');
  return {
    текст: t.textContent.replace(/\s+/g, ' ').trim(),
    выравнивание: getComputedStyle(h).textAlign,
    вес: жирный ? getComputedStyle(жирный).fontWeight : '',
    цвет: жирный ? getComputedStyle(жирный).color : ''
  };
});
ok(/Готово, спасибо!/.test(наЭкране.текст), 'заголовок показан: ' + наЭкране.текст.slice(0, 60));
ok(/Заберите свой экземпляр/.test(наЭкране.текст), 'и блок под ним тоже');
ok(наЭкране.выравнивание === 'center', 'заголовок по центру: ' + наЭкране.выравнивание);
ok(parseInt(наЭкране.вес, 10) >= 600, 'оформление заголовка на месте: ' + наЭкране.вес);
ok(/22, 163, 74/.test(наЭкране.цвет), 'и цвет тоже: ' + наЭкране.цвет);

// Через заданные три секунды планшет уходит в рекламу, а не через шесть.
await kiosk.waitForFunction(() => !document.querySelector('.thankyou'), { timeout: 12000 });
const прошло = Date.now() - t0;
ok(прошло >= 2500 && прошло <= 7000, 'экран держался заданное время: ' + Math.round(прошло / 100) / 10 + ' с');

// Редактор: карточка «Спасибо» на месте и правится.
await p.evaluate(() => Object.keys(localStorage).filter(k => k.indexOf('sk_doc_draft') === 0).forEach(k => localStorage.removeItem(k)));
await p.reload(); await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
await p.click('[data-tab="document"]'); await p.waitForTimeout(700);
await отказатьсяОтЧерновика(p);
ok(await p.locator('.thanks-page-card').count() === 1, 'карточка экрана «Спасибо» есть в редакторе');
ok(await p.locator('[data-role="thanksheading"]').count() === 1, 'с оформляемым заголовком');
ok(await p.locator('[data-role="thanksblocklist"] [data-role="blockcard"]').count() === 1, 'и с блоком под ним');
ok((await p.locator('[data-role="thankssec"]').inputValue()) === '3', 'и с временем показа');
ok(await p.locator('#thankYou').count() === 0, 'старого поля с текстом «Спасибо» больше нет');

await p.locator('[data-role="thankssec"]').fill('12');
await p.click('#saveDocument'); await p.waitForTimeout(800);
ok(((await call('/document')).body.thankYouSec) === 12, 'правка времени сохранилась');

await browser.close();
console.log(fail === 0 ? '\nВСЁ ПРОЙДЕНО' : '\n' + fail + ' ПРОВЕРОК УПАЛО');
process.exit(fail === 0 ? 0 : 1);
