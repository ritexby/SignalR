import { chromium } from 'playwright';
const BASE = 'http://127.0.0.1:5080';
// Путь к браузеру берётся из окружения: на другой машине он другой, а зашитый путь
// превращал набор в неработающий у всех, кроме одной установки. Пусто значит
// «пусть Playwright возьмёт свой», как он и делает по умолчанию.
const EXE = process.env.SK_CHROME || undefined;
const OUT = '' + (process.env.SK_RABOTA || '.') + '/';

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 }, deviceScaleFactor: 1 });
const p = await ctx.newPage();
await p.goto(BASE + '/admin/');
await p.fill('#password', 'test123');
await p.click('#loginForm button[type=submit]');
await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
await p.waitForTimeout(500);

async function shot(tab, name, width) {
  await p.setViewportSize({ width, height: 900 });
  await p.click('.tab[data-tab="' + tab + '"]');
  await p.waitForSelector('[data-panel="' + tab + '"]:not(.hidden)', { timeout: 4000 });
  await p.waitForTimeout(300);
  await p.screenshot({ path: OUT + name });
  console.log('shot', name, width);
}

await shot('document', 'shot_document_1200.png', 1200);
await shot('document', 'shot_document_820.png', 820);
await shot('slides', 'shot_slides_1200.png', 1200);
await shot('devices', 'shot_devices_1200.png', 1200);

await browser.close();
console.log('done');
