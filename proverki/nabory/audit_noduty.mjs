// Что происходит, когда действие в принципе невозможно: планшетов нет, а кнопки активны.
import { chromium } from 'playwright';
const BASE = 'http://127.0.0.1:5080';
// Путь к браузеру берётся из окружения: на другой машине он другой, а зашитый путь
// превращал набор в неработающий у всех, кроме одной установки. Пусто значит
// «пусть Playwright возьмёт свой», как он и делает по умолчанию.
const EXE = process.env.SK_CHROME || undefined;
const browser = await chromium.launch({ executablePath: EXE, headless: true });
const p = await (await browser.newContext({ viewport: { width: 1400, height: 1000 } })).newPage();
const dialogs = []; p.on('dialog', d => { dialogs.push(d.message()); d.accept(); });
await p.goto(BASE + '/admin/');
await p.fill('#password', 'test123'); await p.click('#loginForm button[type=submit]');
await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });

await p.click('.tab[data-tab="document"]');
await p.waitForTimeout(500);
console.log('Документ, планшетов нет:');
for (const id of ['showDocument', 'showSlides', 'previewDoc', 'saveDocument']) {
  const b = p.locator('#' + id);
  if (await b.count()) console.log('  ' + id + ': выключена=' + await b.isDisabled() + ', подсказка=' + JSON.stringify(await b.getAttribute('title')));
}
// Кнопка выключена и объясняет, почему: нажать её нельзя, и это правильно. Диагностика
// не должна на этом падать, её дело показать состояние.
if (!(await p.locator('#showDocument').isDisabled())) {
  await p.click('#showDocument');
  await p.waitForTimeout(900);
} else {
  console.log('  «Отправить» выключена и объясняет причину: нажатие невозможно by design');
}
console.log('  после нажатия «Отправить»: ' + JSON.stringify(await p.evaluate(() => {
  const t = document.querySelector('.toast'); return { toast: t && t.textContent, модалка: !!document.querySelector('.modal, .sheet') };
})));

await p.click('.tab[data-tab="scan"]');
await p.waitForTimeout(500);
console.log('Сканирование, планшетов нет:');
for (const id of ['startScan', 'stopScan']) {
  const b = p.locator('#' + id);
  if (await b.count()) console.log('  ' + id + ': выключена=' + await b.isDisabled());
}
if (!(await p.locator('#startScan').isDisabled())) {
  await p.click('#startScan');
  await p.waitForTimeout(900);
  console.log('  после нажатия «Начать»: ' + JSON.stringify(await p.evaluate(() => {
    const t = document.querySelector('.toast'); return t && t.textContent;
  })));
} else {
  console.log('  «Начать» выключена: нажатие невозможно by design');
}
console.log('  диалоги: ' + JSON.stringify(dialogs));
await browser.close();
