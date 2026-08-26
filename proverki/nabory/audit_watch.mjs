// Разбор наблюдения за планшетом: каждый поток, включая крайние случаи.
import { chromium } from 'playwright';
const BASE = 'http://127.0.0.1:5080';
// Путь к браузеру берётся из окружения: на другой машине он другой, а зашитый путь
// превращал набор в неработающий у всех, кроме одной установки. Пусто значит
// «пусть Playwright возьмёт свой», как он и делает по умолчанию.
const EXE = process.env.SK_CHROME || undefined;
const найдено = [];
const баг = (что) => { найдено.push(что); console.log('FAIL ' + что); };
const норм = (что) => console.log('в порядке: ' + что);

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const ctx = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
const p = await ctx.newPage();
const ошибкиJS = [];
p.on('pageerror', e => ошибкиJS.push(String(e.message).slice(0, 140)));
await p.goto(BASE + '/admin/');
await p.fill('#password', 'test123'); await p.click('#loginForm button[type=submit]');
await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
const call = (path, opts) => p.evaluate(async ([pa, o]) => {
  const r = await fetch('/api/admin' + pa, Object.assign({ credentials: 'same-origin' }, o || {}));
  let b = null; try { b = await r.json(); } catch {} return { status: r.status, body: b };
}, [path, opts]);

await call('/document', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
  title: 'СОГЛАСИЕ', signPrompt: 'Распишитесь', thankYouText: 'Спасибо', idleReturnSec: 0,
  pages: [{ headingRuns: [{ text: 'Условия' }], blocks: [{ runs: [{ text: 'Текст.' }], ord: 0 }],
    checkboxes: [{ key: 'ok', label: 'Согласен', required: true, ord: 1 }], groups: [],
    signatures: [{ key: 'vrach', label: 'Подпись врача', required: false, ord: 2 }], scans: [] }],
  signBlocks: [], signBlocksBelow: [] }) });

const заведи = async (имя) => {
  const code = (await call('/devices/enroll', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: имя }) })).body.code;
  const k = await (await browser.newContext({ viewport: { width: 900, height: 1400 } })).newPage();
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
const t = await заведи('Планшет');

// Открываем наблюдение отдельным окном.
await p.click('[data-tab="devices"]'); await p.waitForTimeout(900);
const [w] = await Promise.all([
  ctx.waitForEvent('page', { timeout: 15000 }),
  p.locator('.dev-item button', { hasText: 'Смотреть' }).first().click()
]);
await w.waitForLoadState();
await w.waitForSelector('.watch-screen', { timeout: 15000 });
await w.waitForTimeout(800);
норм('окно наблюдения открылось');

await call('/show-document', { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ target: 'device:' + t.id, fields: {} }) });
await t.page.waitForSelector('.check', { timeout: 8000 });
await w.waitForTimeout(1200);

// 1. Планшет переподключился, пока за ним смотрят: продолжает ли он рассказывать о себе.
await t.page.reload();
await t.page.waitForSelector('.check', { timeout: 12000 });
await w.waitForTimeout(1500);
console.log('ПЛАНШЕТ ПОСЛЕ ПЕРЕЗАГРУЗКИ: ' + (await t.page.evaluate(() =>
  document.body.textContent.replace(/\s+/g, ' ').trim().slice(0, 120))));
await t.page.evaluate(() => {
  const i = document.querySelector('.checks .check input');
  if (i) { i.checked = true; i.dispatchEvent(new Event('change', { bubbles: true })); }
});
await w.waitForTimeout(1500);
const послеПерезагрузки = await w.locator('.watch-check.on').count();
if (послеПерезагрузки === 0)
  баг('планшет переподключился, и наблюдение замолчало: оператор видит застывшую картинку и не знает об этом');
else норм('после переподключения планшета наблюдение продолжает работать');

// 2. Очистка подписи: пропадает ли она у наблюдателя.
console.log('ПЛАНШЕТ ПЕРЕД ПОДПИСЬЮ: ' + (await t.page.evaluate(() =>
  document.body.textContent.replace(/\s+/g, ' ').trim().slice(0, 140))));
if (!(await t.page.locator('.page-sign-wrap').count())) {
  баг('поле подписи внутри страницы исчезло после отметки чекбокса, хотя от неё не зависит');
} else {
const b = await t.page.locator('.page-sign-wrap').boundingBox();
await t.page.mouse.move(b.x + 20, b.y + b.height / 2);
await t.page.mouse.down();
await t.page.mouse.move(b.x + b.width - 30, b.y + b.height / 2 - 15, { steps: 10 });
await t.page.mouse.up();
await t.page.waitForTimeout(1200);
const естьПодпись = await w.locator('.watch-ink img').count();
await t.page.locator('.page-sign-clear').click();
await t.page.waitForTimeout(1500);
const послеОчистки = await w.locator('.watch-ink img').count();
if (естьПодпись > 0 && послеОчистки === естьПодпись)
  баг('клиент стёр подпись, а у наблюдателя она осталась: оператор видит подпись, которой уже нет');
else норм('очистка подписи доходит до наблюдателя: было ' + естьПодпись + ', стало ' + послеОчистки);
}

// 3. Планшет ушёл со связи: понимает ли это наблюдатель.
await t.page.close();
await w.waitForTimeout(4000);
const приОфлайне = await w.evaluate(() => (document.querySelector('.watch') || {}).textContent || '');
if (!/не на связи|офлайн|потеря/i.test(приОфлайне))
  баг('планшет ушёл со связи, а окно наблюдения об этом не говорит: картинка застыла, и понять причину нельзя');
else норм('об уходе планшета со связи сказано');

// 4. Планшет удалён, пока за ним смотрят.
await call('/devices/' + t.id, { method: 'DELETE' });
await w.waitForTimeout(2500);
const послеУдаления = await w.evaluate(() => ({
  текст: ((document.querySelector('.watch') || {}).textContent || '').slice(0, 120),
  экран: document.querySelectorAll('.watch-screen').length
}));
норм('после удаления планшета окно показывает: «' + послеУдаления.текст.replace(/\s+/g, ' ').slice(0, 80) + '»');

// 5. Кнопка «Закрыть» в отдельном окне.
const закрытие = await w.evaluate(() => {
  const b = Array.from(document.querySelectorAll('.watch button')).find(x => x.textContent.trim() === 'Закрыть');
  return !!b;
});
if (закрытие) {
  await w.locator('.watch button', { hasText: 'Закрыть' }).click();
  await w.waitForTimeout(700);
  const осталось = await w.evaluate(() => ({ закрыто: document.querySelectorAll('.watch-screen').length === 0,
    видноАдминку: !!document.querySelector('[data-panel="devices"]') }));
  if (осталось.закрыто && осталось.видноАдминку)
    норм('«Закрыть» убирает наблюдение и оставляет админку в том же окне');
  else баг('после «Закрыть» окно наблюдения в непонятном состоянии: ' + JSON.stringify(осталось));
}

// 6. Наблюдение за вторым планшетом из того же окна: не остаётся ли первое.
const t2 = await заведи('Второй');
const t3 = await заведи('Третий');
await w.goto(BASE + '/admin/#watch=' + t2.id);
await w.waitForSelector('.watch-screen', { timeout: 15000 });
await w.waitForTimeout(800);
const счёт1 = (await call('/devices')).body.length;
await w.evaluate(async (id) => { await window.__hubForTest.invoke('WatchDevice', id); }, t3.id).catch(() => {});
норм('планшетов в системе: ' + счёт1);

// 7. Наблюдение за офлайновым планшетом по прямой ссылке.
await t3.page.close();
await w.waitForTimeout(3000);
await w.goto(BASE + '/admin/#watch=' + t3.id);
await w.waitForTimeout(3000);
const заОфлайном = await w.evaluate(() => ({
  окно: document.querySelectorAll('.watch-screen').length,
  сообщение: (document.querySelector('.toast') || {}).textContent || ''
}));
if (заОфлайном.окно === 0 && !заОфлайном.сообщение)
  баг('ссылка на офлайновый планшет не открывает окно и ничего не объясняет');
else норм('за офлайновым планшетом: окон ' + заОфлайном.окно + ', сообщение «' + заОфлайном.сообщение.slice(0, 70) + '»');

if (ошибкиJS.length) баг('ошибки JavaScript: ' + JSON.stringify(ошибкиJS.slice(0, 3)));
else норм('ошибок JavaScript нет');

await browser.close();
console.log('\nИТОГО НАЙДЕНО: ' + найдено.length);
найдено.forEach((x, i) => console.log((i + 1) + '. ' + x));
if (найдено.length === 0) console.log('\nВСЁ ПРОЙДЕНО');
process.exit(найдено.length === 0 ? 0 : 1);
