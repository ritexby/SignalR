// Проверка видимости: не на глаз, а числами. Для каждого видимого куска текста считается
// отношение контраста к его настоящему фону, а для рамок и плашек то, отличаются ли они от
// фона под ними вообще. Порог для обычного текста 4.5, для крупного 3, для рамок 1.25:
// граница, которую не видно, это граница, которой нет.
import { chromium } from 'playwright';
import { ПРОВЕРКА } from './contrast_lib.mjs';
const BASE = 'http://127.0.0.1:5080';
// Путь к браузеру берётся из окружения: на другой машине он другой, а зашитый путь
// превращал набор в неработающий у всех, кроме одной установки. Пусто значит
// «пусть Playwright возьмёт свой», как он и делает по умолчанию.
const EXE = process.env.SK_CHROME || undefined;
let найдено = [];
const баг = (что) => { найдено.push(что); console.log('FAIL ' + что); };

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const p = await (await browser.newContext({ viewport: { width: 1500, height: 1000 } })).newPage();
p.on('dialog', d => d.accept());
await p.goto(BASE + '/admin/');
await p.fill('#password', 'test123');
await p.click('#loginForm button[type=submit]');
await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
const отказ = p.locator('.modal button', { hasText: 'Отказаться от черновика' });
try { await отказ.waitFor({ state: 'visible', timeout: 2000 }); await отказ.click(); } catch {}

const вкладки = await p.locator('.tab').evaluateAll(n => n.map(x => x.getAttribute('data-tab')));
for (const имя of вкладки) {
  await p.click('.tab[data-tab="' + имя + '"]');
  await p.waitForTimeout(900);
  await p.evaluate(() => { var d = document.querySelector('.tags-box'); if (d) d.open = true; });
  await p.waitForTimeout(200);
  const r = await p.evaluate(ПРОВЕРКА);
  r.текстовые.forEach(x => баг('вкладка «' + имя + '»: текст «' + x.текст + '» контраст ' + x.контраст + ' при пороге ' + x.порог + ' (' + x.где + ')'));
  (r.значки || []).forEach(x => баг('вкладка «' + имя + '»: значок не виден, контраст ' + x.контраст + ' (' + x.где + ')'));
  r.коробки.forEach(x => баг('вкладка «' + имя + '»: ' + x.вид + ', контраст ' + x.контраст + (x.порог ? ' при пороге ' + x.порог : '') + ' (' + x.где + ')'));
  console.log('вкладка «' + имя + '»: проверена');
}

// Страница планшета: там читает клиент, и там контраст важнее всего.
const kiosk = await (await browser.newContext({ viewport: { width: 900, height: 1400 } })).newPage();
await kiosk.goto(BASE + '/');
await kiosk.waitForTimeout(1200);
const rk = await kiosk.evaluate(ПРОВЕРКА);
rk.текстовые.forEach(x => баг('планшет: текст «' + x.текст + '» контраст ' + x.контраст + ' при пороге ' + x.порог + ' (' + x.где + ')'));
(rk.значки || []).forEach(x => баг('планшет: значок не виден, контраст ' + x.контраст + ' (' + x.где + ')'));
rk.коробки.forEach(x => баг('планшет: ' + x.вид + ', контраст ' + x.контраст + (x.порог ? ' при пороге ' + x.порог : '') + ' (' + x.где + ')'));
console.log('страница планшета: проверена');

await browser.close();
console.log('\nИТОГО НАЙДЕНО: ' + найдено.length);
if (найдено.length === 0) console.log('\nВСЁ ПРОЙДЕНО');
process.exit(найдено.length === 0 ? 0 : 1);
