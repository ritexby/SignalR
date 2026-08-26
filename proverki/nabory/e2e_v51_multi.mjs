// Выбор нескольких конкретных планшетов там, где это имеет смысл: реклама и расписание.
// Документ и сканирование остаются на один планшет намеренно, и это тоже проверяется.
import { chromium } from 'playwright';
// После перезагрузки редактор может предложить восстановить черновик. Эти проверки про другое,
// поэтому черновик отклоняется, если он предложен.
async function отказатьсяОтЧерновика(page) {
  // Окно появляется не сразу: черновик сравнивается с документом, а тот ещё едет с сервера.
  // Проверка «есть ли окно прямо сейчас» промахивалась, окно всплывало позже и перехватывало
  // нажатия, а набор падал на «кнопка недоступна», ничего не объясняя.
  const btn = page.locator('.modal button', { hasText: 'Отказаться от черновика' });
  try { await btn.waitFor({ state: 'visible', timeout: 2500 }); } catch { return; }
  await btn.click();
  await page.waitForTimeout(200);
}

const BASE = 'http://127.0.0.1:5080';
// Путь к браузеру берётся из окружения: на другой машине он другой, а зашитый путь
// превращал набор в неработающий у всех, кроме одной установки. Пусто значит
// «пусть Playwright возьмёт свой», как он и делает по умолчанию.
const EXE = process.env.SK_CHROME || undefined;
let fail = 0;
const ok = (c, m) => { if (c) console.log('PASS', m); else { console.error('FAIL', m); fail++; } };

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const p = await (await browser.newContext({ viewport: { width: 1600, height: 1100 } })).newPage();
const jsErr = []; p.on('pageerror', e => jsErr.push(e.message));
p.on('dialog', d => d.accept());
await p.goto(BASE + '/admin/');
await p.fill('#password', 'test123'); await p.click('#loginForm button[type=submit]');
await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
await отказатьсяОтЧерновика(p);
const call = (path, opts) => p.evaluate(async ([pa, o]) => {
  const r = await fetch('/api/admin' + pa, Object.assign({ credentials: 'same-origin' }, o || {}));
  let b = null; try { b = await r.json(); } catch {} return { status: r.status, body: b };
}, [path, opts]);

// Три планшета.
const ids = [];
for (const имя of ['Первый', 'Второй', 'Третий']) {
  const e = (await call('/devices/enroll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: имя }) })).body;
  const k = await (await browser.newContext()).newPage();
  await k.goto(BASE + '/?enroll=' + encodeURIComponent(e.code));
  await k.waitForFunction(() => !!localStorage.getItem('sk_device_token'), { timeout: 12000 });
  ids.push(await k.evaluate(() => localStorage.getItem('sk_device_token').split('.')[0]));
  await k.context().close();
}
ok(ids.length === 3, 'три планшета заведены');

// Картинка для рекламы.
await p.evaluate(async () => {
  const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='), c => c.charCodeAt(0));
  const fd = new FormData();
  fd.append('files', new Blob([png], { type: 'image/png' }), 'a.png');
  await fetch('/api/admin/images', { method: 'POST', credentials: 'same-origin', body: fd });
});
await p.reload(); await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
await отказатьсяОтЧерновика(p);

// ---------- Реклама на выбранные планшеты ----------
await p.selectOption('#slidesTarget', 'devices');
await p.waitForTimeout(300);
ok(await p.locator('#slidesDevices').isVisible(), 'появился выбор планшетов');
const отметки = p.locator('#slidesDevices input[data-device]');
ok(await отметки.count() === 3, 'перечислены все планшеты: ' + await отметки.count());
// Список сортируется по имени, поэтому какой планшет под каким номером, читаем из разметки.
const порядок = await отметки.evaluateAll(ns => ns.map(n => n.getAttribute('data-device')));
await отметки.nth(0).check();
await отметки.nth(2).check();
const отмеченные = [порядок[0], порядок[2]];
const неотмеченный = порядок[1];
await p.waitForTimeout(150);
ok(/Отмечено планшетов: 2/.test(await p.locator('#slidesDevices .sch-devices-count').textContent()),
  'счётчик показывает, сколько отмечено');

// Выбираем картинку и сохраняем.
await p.locator('#imageGrid .img-card, #imageGrid .card, #imageGrid > *').first().click();
await p.waitForTimeout(200);
await p.click('#saveSlides');
await p.waitForTimeout(900);

const режим = async (id) => ((await call('/playlist?target=device:' + id)).body || {}).imageIds || [];
ok((await режим(отмеченные[0])).length === 1, 'первому отмеченному реклама пришла');
ok((await режим(отмеченные[1])).length === 1, 'второму отмеченному тоже');
ok((await режим(неотмеченный)).length === 0, 'а неотмеченному нет');

// Пустой набор не должен уходить на сервер молча.
await p.evaluate(() => {
  document.querySelectorAll('#slidesDevices input[data-device]:checked').forEach(c => { c.checked = false; c.dispatchEvent(new Event('change', { bubbles: true })); });
});
await p.waitForTimeout(150);
await p.click('#saveSlides');
await p.waitForTimeout(500);
ok(/Отметьте хотя бы один/.test(await p.evaluate(() => (document.querySelector('.toast') || {}).textContent || '')),
  'пустой набор отклоняется с понятным текстом');

// ---------- Расписание на выбранные планшеты ----------
await p.click('.tab[data-tab="devices"]');
await p.waitForSelector('#scheduleList', { timeout: 5000 });
await p.click('#addSchedule');
await p.waitForTimeout(250);
const row = p.locator('[data-role="schrule"]').first();
await row.locator('[data-role="schtarget"]').selectOption('devices');
await p.waitForTimeout(200);
ok(await row.locator('[data-role="schdevices"]').isVisible(), 'в правиле появился выбор планшетов');
const вРасписании = await row.locator('[data-role="schdevices"] input[data-device]')
  .evaluateAll(ns => ns.map(n => n.getAttribute('data-device')));
await row.locator('[data-role="schdevices"] input[data-device]').nth(1).check();
await row.locator('[data-role="schaction"]').selectOption('return-slides');
await row.locator('[data-role="schbusy"]').uncheck();
await p.click('#saveSchedule');
await p.waitForTimeout(800);
const rules = ((await call('/schedule')).body || {}).rules || [];
ok(rules.length === 1 && rules[0].target === 'devices', 'правило сохранено с набором');
ok(JSON.stringify(rules[0].deviceIds) === JSON.stringify([вРасписании[1]]),
  'сохранён именно отмеченный планшет: ' + JSON.stringify(rules[0].deviceIds));

const run = await call('/schedule/' + rules[0].id + '/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
ok(/выполнено на 1/.test((run.body || {}).result || ''),
  'правило выполнилось ровно на одном отмеченном планшете: ' + JSON.stringify((run.body || {}).result));

// «Отметить все» отмечает и снимает.
await p.reload(); await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
await отказатьсяОтЧерновика(p);
await p.click('.tab[data-tab="devices"]');
await p.waitForSelector('[data-role="schrule"]', { timeout: 5000 });
const all = p.locator('[data-role="schdevices"] .sch-dev-all').first();
await all.click(); await p.waitForTimeout(200);
ok(await p.locator('[data-role="schdevices"] input[data-device]:checked').count() === 3, 'кнопка отметила все');
await all.click(); await p.waitForTimeout(200);
ok(await p.locator('[data-role="schdevices"] input[data-device]:checked').count() === 0, 'и сняла все');

// ---------- Документ и сканирование остаются на один планшет ----------
await p.click('.tab[data-tab="document"]');
await p.waitForTimeout(300);
const docOpts = await p.locator('#docTarget option').evaluateAll(ns => ns.map(n => n.value));
ok(docOpts.indexOf('devices') < 0 && docOpts.indexOf('all') < 0,
  'у документа выбор только из отдельных планшетов: ' + JSON.stringify(docOpts));
await p.click('.tab[data-tab="scan"]');
await p.waitForTimeout(300);
const scanOpts = await p.locator('#scanTarget option').evaluateAll(ns => ns.map(n => n.value));
ok(scanOpts.indexOf('devices') < 0 && scanOpts.indexOf('all') < 0,
  'у сканирования тоже: ' + JSON.stringify(scanOpts));

ok(jsErr.length === 0, 'ошибок JavaScript нет: ' + jsErr.join(' | '));
await browser.close();
console.log(fail === 0 ? '\nВСЁ ПРОЙДЕНО' : '\n' + fail + ' ПРОВЕРОК УПАЛО');
process.exit(fail === 0 ? 0 : 1);
