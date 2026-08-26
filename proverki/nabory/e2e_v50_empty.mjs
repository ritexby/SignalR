// Действие, для которого нужен планшет, а планшетов нет. Кнопка не должна предлагать выбрать
// то, чего не существует: она выключена и объясняет, что сделать раньше. Как только планшет
// появляется, всё включается само.
import { chromium } from 'playwright';
const BASE = 'http://127.0.0.1:5080';
// Путь к браузеру берётся из окружения: на другой машине он другой, а зашитый путь
// превращал набор в неработающий у всех, кроме одной установки. Пусто значит
// «пусть Playwright возьмёт свой», как он и делает по умолчанию.
const EXE = process.env.SK_CHROME || undefined;
let fail = 0;
const ok = (c, m) => { if (c) console.log('PASS', m); else { console.error('FAIL', m); fail++; } };

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const p = await (await browser.newContext({ viewport: { width: 1400, height: 1000 } })).newPage();
const jsErr = []; p.on('pageerror', e => jsErr.push(e.message));
await p.goto(BASE + '/admin/');
await p.fill('#password', 'test123'); await p.click('#loginForm button[type=submit]');
await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
const call = (path, opts) => p.evaluate(async ([pa, o]) => {
  const r = await fetch('/api/admin' + pa, Object.assign({ credentials: 'same-origin' }, o || {}));
  let b = null; try { b = await r.json(); } catch {} return { status: r.status, body: b };
}, [path, opts]);

await p.click('.tab[data-tab="document"]');
await p.waitForTimeout(400);
for (const id of ['showDocument', 'showSlides']) {
  ok(await p.locator('#' + id).isDisabled(), id + ': кнопка выключена, пока планшетов нет');
  ok(/Планшеты/.test(await p.locator('#' + id).getAttribute('title') || ''),
    id + ': подсказка говорит, куда идти');
}
ok(await p.locator('#docNoDevices').isVisible(), 'на вкладке видно объяснение, а не пустота');
ok(!(await p.locator('#previewDoc').isDisabled()), 'предпросмотр доступен и без планшетов: документ можно готовить заранее');
ok(!(await p.locator('#saveDocument').isDisabled()), 'сохранить документ тоже можно');

await p.click('.tab[data-tab="scan"]');
await p.waitForTimeout(400);
ok(await p.locator('#startScan').isDisabled(), 'сканирование выключено: сканирует камера планшета');
ok(await p.locator('#scanNoDevices').isVisible(), 'и объяснено почему');

// Появился планшет: всё включается само, без перезагрузки страницы.
const code = (await call('/devices/enroll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"name":"Первый"}' })).body.code;
const kiosk = await (await browser.newContext()).newPage();
await kiosk.goto(BASE + '/?enroll=' + encodeURIComponent(code));
await kiosk.waitForFunction(() => !!localStorage.getItem('sk_device_token'), { timeout: 12000 });
await p.waitForFunction(() => !document.getElementById('startScan').disabled, { timeout: 10000 });
ok(!(await p.locator('#startScan').isDisabled()), 'планшет появился: сканирование включилось само');
ok(!(await p.locator('#scanNoDevices').isVisible()), 'объяснение убралось');
await p.click('.tab[data-tab="document"]');
await p.waitForTimeout(300);
ok(!(await p.locator('#showDocument').isDisabled()), 'отправка документа включилась');
ok(!(await p.locator('#docNoDevices').isVisible()), 'объяснение на вкладке документа убралось');

ok(jsErr.length === 0, 'ошибок JavaScript нет: ' + jsErr.join(' | '));
await browser.close();
console.log(fail === 0 ? '\nВСЁ ПРОЙДЕНО' : '\n' + fail + ' ПРОВЕРОК УПАЛО');
process.exit(fail === 0 ? 0 : 1);
