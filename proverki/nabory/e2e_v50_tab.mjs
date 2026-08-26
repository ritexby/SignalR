// Открытая вкладка должна переживать обновление страницы. Раньше обновление во время работы
// над документом выбрасывало на «Слайды», а во время работы это происходит постоянно.
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
const p = await (await browser.newContext({ viewport: { width: 1400, height: 1000 } })).newPage();
const jsErr = []; p.on('pageerror', e => jsErr.push(e.message));
await p.goto(BASE + '/admin/');
await p.fill('#password', 'test123'); await p.click('#loginForm button[type=submit]');
await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
await отказатьсяОтЧерновика(p);

const активная = () => p.evaluate(() => (document.querySelector('.tab.active') || {}).dataset.tab);
const видимая = () => p.evaluate(() => (document.querySelector('.panel:not(.hidden)') || {}).dataset.panel);

ok(await активная() === 'slides', 'по умолчанию открыты «Слайды»');

await p.click('.tab[data-tab="document"]');
await p.waitForTimeout(300);
ok(await активная() === 'document' && await видимая() === 'document', 'вкладка «Документ» открылась');
ok(/#document$/.test(p.url()), 'адрес отражает вкладку: ' + p.url());

await p.reload();
await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
await отказатьсяОтЧерновика(p);
await p.waitForTimeout(500);
ok(await активная() === 'document', 'после обновления мы всё ещё на «Документе»');
ok(await видимая() === 'document', 'и видна именно его панель');
ok(await p.locator('[data-role="itemlist"], #pagesEditor').count() > 0, 'редактор загрузился, а не остался пустым');

// Ссылка на вкладку работает с чистого открытия.
const p2 = await (await browser.newContext()).newPage();
await p2.goto(BASE + '/admin/#logs');
await p2.waitForSelector('#app:not(.hidden)', { timeout: 8000 }).catch(() => {});
if (await p2.locator('#login:not(.hidden)').count()) {
  await p2.fill('#password', 'test123'); await p2.click('#loginForm button[type=submit]');
  await p2.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
}
await p2.waitForTimeout(500);
ok(await p2.evaluate(() => (document.querySelector('.tab.active') || {}).dataset.tab) === 'logs',
  'ссылка на вкладку открывает именно её');
await p2.context().close();

// Мусор в адресе не должен ломать открытие.
await p.goto(BASE + '/admin/#такойвкладкинет');
await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
await отказатьсяОтЧерновика(p);
await p.waitForTimeout(500);
ok(await активная() === 'slides', 'неизвестная вкладка в адресе открывает «Слайды», а не пустоту');
ok(await видимая() === 'slides', 'и панель показана');

// Кнопка «назад» в браузере не должна копить каждое переключение.
await p.click('.tab[data-tab="devices"]');
await p.waitForTimeout(200);
await p.click('.tab[data-tab="groups"]');
await p.waitForTimeout(200);
await p.goBack();
await p.waitForTimeout(500);
ok(await активная() !== 'groups', 'один шаг назад уводит с последней вкладки, а не листает по одной');

ok(jsErr.length === 0, 'ошибок JavaScript нет: ' + jsErr.join(' | '));
await browser.close();
console.log(fail === 0 ? '\nВСЁ ПРОЙДЕНО' : '\n' + fail + ' ПРОВЕРОК УПАЛО');
process.exit(fail === 0 ? 0 : 1);
