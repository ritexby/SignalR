// Окно наблюдения, открытое ссылкой #watch=. Оператор нажал «смотреть экран планшета» и в новом
// окне ждёт экран планшета. Раньше там открывалась вкладка «Планшеты», а наблюдение всплывало
// поверх неё окошком; если планшет был не на связи, окошко не появлялось вовсе, и оператор
// получал новое окно со списком планшетов и не понимал, почему экрана нет.
import { chromium } from 'playwright';
const BASE = 'http://127.0.0.1:5080';
// Путь к браузеру берётся из окружения: на другой машине он другой, а зашитый путь
// превращал набор в неработающий у всех, кроме одной установки. Пусто значит
// «пусть Playwright возьмёт свой», как он и делает по умолчанию.
const EXE = process.env.SK_CHROME || undefined;
let fail = 0;
const ok = (c, m) => { if (c) console.log('PASS', m); else { console.error('FAIL', m); fail++; } };

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const ctx = await browser.newContext({ viewport: { width: 1200, height: 980 } });
const admin = await ctx.newPage();
admin.on('pageerror', e => { console.error('FAIL ошибка в админке: ' + e.message); fail++; });
await admin.goto(BASE + '/admin/');
await admin.fill('#password', 'test123');
await admin.click('#loginForm button[type=submit]');
await admin.waitForSelector('#app:not(.hidden)', { timeout: 8000 });

const call = (path, opts) => admin.evaluate(async ([pa, o]) => {
  const r = await fetch('/api/admin' + pa, Object.assign({ credentials: 'same-origin' }, o || {}));
  let body = null; try { body = await r.json(); } catch { body = null; }
  return { status: r.status, body };
}, [path, opts]);
const post = (path, obj) => call(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });
const put = (path, obj) => call(path, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });

const ws = (await post('/workstations', { externalId: 'WS-WIN', name: 'Окно', location: '' })).body;
const enr = (await post('/devices/enroll', { name: 'Планшет окна', workstationId: ws.id, ttlMinutes: 30 })).body;
const tok = await admin.evaluate(async (code) => (await fetch('/api/kiosk/enroll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) })).json(), enr.code);

await put('/document', {
  title: 'Согласие', signPrompt: 'Подпись', thankYouText: 'Спасибо', idleReturnSec: 0,
  pages: [{
    headingRuns: [{ text: 'Первая страница' }],
    blocks: [{ runs: [{ text: 'текст соглашения' }] }],
    checkboxes: [{ key: 'ok', label: 'Согласен', required: true }],
    includeDynamic: false
  }]
});

// ---------- 1. Планшет НЕ на связи: окно должно объяснить это само ----------
const окно = await ctx.newPage();
окно.on('pageerror', e => { console.error('FAIL ошибка в окне наблюдения: ' + e.message); fail++; });
await окно.goto(BASE + '/admin/#watch=' + tok.deviceId);
await окно.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
await окно.waitForSelector('.watch-solo-page', { timeout: 8000 });
ok(true, 'окно открылось сразу экраном планшета, а не списком планшетов');

// Вкладки и панели админки в этом окне не нужны: оператор пришёл смотреть за планшетом.
const вкладкиВидны = await окно.locator('.tabs').isVisible();
ok(!вкладкиВидны, 'вкладки админки в окне наблюдения скрыты');
// Считается именно видимость, а не пометка в разметке: панель может быть скрыта и правилом
// оформления, и тогда пометка ничего не говорит.
let видимых = 0;
for (const п of await окно.locator('.content > .panel').all()) if (await п.isVisible()) видимых++;
ok(видимых === 0, 'ни одна панель админки в окне не видна (' + видимых + ')');
const открытых = await окно.locator('.content > .panel:not(.hidden)').count();
ok(открытых === 0, 'и в разметке они тоже закрыты (' + открытых + ')');

await окно.waitForTimeout(1500);
let текст = await окно.locator('.watch-screen').textContent();
ok(/не на связи/.test(текст), 'окно прямо говорит, что планшет не на связи: ' + текст.trim().slice(0, 80));
ok(/появится сам/.test(текст), 'и обещает показать экран, когда планшет отзовётся');
ok(/не на связи/.test(await окно.locator('.watch-live').textContent()), 'метка в шапке говорит то же самое');

// ---------- 2. Планшет вышел на связь: экран должен появиться сам ----------
const kiosk = await (await browser.newContext({ viewport: { width: 900, height: 1400 } })).newPage();
kiosk.on('pageerror', e => { console.error('FAIL ошибка на планшете: ' + e.message); fail++; });
await kiosk.goto(BASE + '/');
await kiosk.evaluate(t => localStorage.setItem('sk_device_token', t), tok.token);
await kiosk.reload();
await kiosk.waitForTimeout(1500);
await post('/show-document', { target: 'device:' + tok.deviceId, fields: {} });
await kiosk.waitForSelector('text=текст соглашения', { timeout: 8000 });

// Окно ничего не спрашивало и не перезагружалось: оно само дождалось планшета.
await окно.waitForSelector('.watch-doc, .watch-page, .watch-screen .doc-text', { timeout: 15000 }).catch(() => {});
await окно.waitForTimeout(1200);
текст = await окно.locator('.watch-screen').textContent();
ok(/текст соглашения/.test(текст), 'экран планшета появился в окне сам, без перезагрузки: ' + текст.trim().slice(0, 80));
ok(/наблюдение/.test(await окно.locator('.watch-live').textContent()), 'метка в шапке сменилась на «наблюдение»');

// ---------- 3. Клиент отмечает пункт: это видно в окне ----------
await kiosk.locator('label', { hasText: 'Согласен' }).click();
await окно.waitForTimeout(1200);
const отмечено = await окно.locator('.watch-check.on').count();
ok(отмечено === 1, 'отмеченный клиентом пункт виден в окне (' + отмечено + ')');

// ---------- 4. Ссылка на несуществующий планшет ----------
const чужое = await ctx.newPage();
чужое.on('pageerror', e => { console.error('FAIL ошибка в окне: ' + e.message); fail++; });
await чужое.goto(BASE + '/admin/#watch=dev-которого-нет');
await чужое.waitForSelector('.watch-solo-page', { timeout: 8000 });
await чужое.waitForTimeout(1500);
const чужойТекст = await чужое.locator('.watch-screen').textContent();
ok(/не найден/.test(чужойТекст), 'ссылка на несуществующий планшет объясняется словами: ' + чужойТекст.trim().slice(0, 80));

// ---------- 5. Обычная админка осталась обычной ----------
await admin.reload();
await admin.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
ok(await admin.locator('.tabs').isVisible(), 'в обычной админке вкладки на месте');
ok(await admin.locator('.watch-solo-page').count() === 0, 'и окна наблюдения в ней нет');

await browser.close();
if (fail === 0) console.log('\nВСЁ ПРОЙДЕНО');
process.exit(fail ? 1 : 0);
