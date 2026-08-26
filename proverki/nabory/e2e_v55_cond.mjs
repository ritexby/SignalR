// Условие по возрасту и пример запроса для чекбоксов из API.
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
p.on('pageerror', e => console.log('ОШИБКА СТРАНИЦЫ:', e.message));
await p.goto(BASE + '/admin/');
await p.fill('#password', 'test123'); await p.click('#loginForm button[type=submit]');
await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
const call = (path, opts) => p.evaluate(async ([pa, o]) => {
  const r = await fetch('/api/admin' + pa, Object.assign({ credentials: 'same-origin' }, o || {}));
  let b = null; try { b = await r.json(); } catch {} return { status: r.status, body: b };
}, [path, opts]);

await call('/document', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
  title: 'СОГЛАСИЕ', signPrompt: 'Распишитесь', thankYouText: 'Спасибо', idleReturnSec: 0,
  pages: [{ headingRuns: [{ text: 'Условия' }],
    blocks: [{ runs: [{ text: 'Являясь законным представителем {{ФИО}}, {{ДР}}, подтверждаю.' }], ord: 0 }],
    checkboxes: [{ key: 'ok', label: 'Согласен', required: true, ord: 1 }], groups: [], signatures: [], scans: [] }],
  signBlocks: [], signBlocksBelow: [] }) });
await p.evaluate(() => Object.keys(localStorage).filter(k => k.indexOf('sk_doc_draft') === 0).forEach(k => localStorage.removeItem(k)));
await p.reload(); await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
await p.click('[data-tab="document"]'); await p.waitForTimeout(600);
await отказатьсяОтЧерновика(p);

// Условие показа блока: выбираем операцию по возрасту и ничего больше не трогаем.
await p.locator('[data-role="blockcond"] .cond-add, [data-role="blockcond"] button', { hasText: 'условие показа' }).first().click();
await p.waitForTimeout(300);
const mode = p.locator('[data-role="blockcond"] .cond-mode').first();
if (await mode.count()) { await mode.selectOption('cond'); await p.waitForTimeout(200); }
const строка = p.locator('[data-role="blockcond"] [data-role="crow"]').first();
ok(await строка.count() === 1, 'строка условия появилась');
ok(await строка.evaluate(r => r.classList.contains('cond-bad')), 'пустая строка помечена красным');
ok((await строка.locator('.cond-hint').textContent()).includes('не сохранится'), 'и объясняет, почему');

await строка.locator('[data-role="cop"]').selectOption('agelt');
await p.waitForTimeout(250);
const тег = await строка.locator('[data-role="cfieldsel"]').inputValue();
ok(тег === 'ДР', 'тег с датой рождения подставился сам: ' + тег);
ok(!(await строка.evaluate(r => r.classList.contains('cond-bad'))), 'пометка снялась');
ok((await строка.locator('.cond-hint').textContent()).includes('даты рождения'), 'подсказка объясняет, откуда возраст');
await строка.locator('[data-role="cval"]').fill('14');
await p.waitForTimeout(200);

await p.click('#saveDocument'); await p.waitForTimeout(700);
const сохр = (await call('/document')).body;
const усл = сохр.pages[0].blocks[0].visibleWhen;
ok(!!усл, 'условие сохранилось: ' + JSON.stringify(усл));
ok(усл.field === 'ДР' && усл.op === 'agelt' && усл.value === '14', 'и сохранилось верно');

// Условие без тега не должно исчезать молча.
await p.locator('[data-role="blockcond"] button', { hasText: 'и ещё условие' }).first().click();
await p.waitForTimeout(300);
const вторая = p.locator('[data-role="blockcond"] [data-role="crow"]').nth(1);
ok(await вторая.evaluate(r => r.classList.contains('cond-bad')), 'вторая строка тоже помечена');
await p.click('#checkDoc'); await p.waitForTimeout(500);
const текстПроверки = await p.locator('.modal').textContent();
ok(/Условий без выбранного тега: 1/.test(текстПроверки), 'проверка документа называет число незаполненных условий');
await p.locator('.modal button').last().click(); await p.waitForTimeout(300);

// Пример запроса в предпросмотре.
await p.click('#previewDoc'); await p.waitForSelector('.preview-setup', { timeout: 8000 });
const детали = p.locator('.pv-json');
ok(await детали.count() === 1, 'блок с примером запроса есть');
await детали.locator('summary').click();
await p.waitForTimeout(200);
let код = await детали.locator('.api-code').textContent();
ok(/"workstationExternalId"/.test(код) && /"fields"/.test(код), 'пример показывает тело запроса');
ok(!/dev-/.test(код), 'пример адресует рабочее место, а не внутренний ID планшета');
ok(/"checkboxes"/.test(код) && /"groups"/.test(код), 'массивы видны сразу, до набора: ' + код.replace(/\s+/g, ' ').slice(0, 120));
const area = p.locator('.preview-setup textarea').first();
await area.fill('+Согласен на рассылку\nДополнительное согласие');
await p.waitForTimeout(300);
код = await детали.locator('.api-code').textContent();
ok(/Согласен на рассылку/.test(код), 'набранные чекбоксы попали в пример');
ok(/"label": "Согласен на рассылку"/.test(код) && /"checked": true/.test(код), 'знак + означает отмеченный: ' + код.replace(/\s+/g, ' ').slice(0, 200));
ok(/"label": "Дополнительное согласие"/.test(код), 'вторая строка тоже');
const разбор = JSON.parse(код);
ok(разбор.workstationExternalId === 'WS-204', 'цель это код рабочего места: ' + разбор.workstationExternalId);
ok(разбор.deviceId === undefined, 'внутреннего ID планшета в примере нет');
ok(разбор.checkboxes.length === 3, 'чекбокс документа и два присланных: ' + разбор.checkboxes.length);
ok(разбор.checkboxes.some(c => c.key === 'ok'), 'именованный чекбокс документа задан по имени');
ok(разбор.checkboxes.filter(c => !c.key).length === 2, 'а присланные идут без имени, только с текстом');

await browser.close();
console.log(fail === 0 ? '\nВСЁ ПРОЙДЕНО' : '\n' + fail + ' ПРОВЕРОК УПАЛО');
process.exit(fail === 0 ? 0 : 1);
