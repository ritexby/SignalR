// Информационный документ: показать клиенту то, что прислала внешняя система, и вернуться к
// рекламе. Ни экрана подписи, ни записи, ни PDF. Плюс признак «не в PDF» у страницы и блока
// подписного документа.
import { chromium } from 'playwright';
const BASE = 'http://127.0.0.1:5080';
// Путь к браузеру берётся из окружения: на другой машине он другой, а зашитый путь
// превращал набор в неработающий у всех, кроме одной установки. Пусто значит
// «пусть Playwright возьмёт свой», как он и делает по умолчанию.
const EXE = process.env.SK_CHROME || undefined;
let fail = 0;
const ok = (c, m) => { if (c) console.log('PASS', m); else { console.error('FAIL', m); fail++; } };
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const admin = await (await browser.newContext()).newPage();
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

const enr = (await post('/devices/enroll', { name: 'Планшет показа', ttlMinutes: 30 })).body;
const tok = await admin.evaluate(async (code) => (await fetch('/api/kiosk/enroll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) })).json(), enr.code);

// ---------- 1. Отказ сделать информационным при поле подписи ----------
const сПодписью = {
  kind: 'info', title: 'Показ', signPrompt: 'Подпись', thankYouText: 'Спасибо', idleReturnSec: 0,
  pages: [{ headingRuns: [{ text: 'Страница' }], blocks: [{ runs: [{ text: 'текст' }], ord: 0 }],
    signatures: [{ key: 'sig', label: 'Подпись', required: true, ord: 1 }], includeDynamic: false }]
};
const отказ = await put('/document', сПодписью);
ok(отказ.status === 400 && /поля подписи/.test((отказ.body || {}).error || ''),
  'информационным с полем подписи стать нельзя: ' + JSON.stringify(отказ.body).slice(0, 120));
ok(/страница 1/.test((отказ.body || {}).error || ''), 'и сказано, какая страница мешает');

// ---------- 2. Настоящий информационный документ ----------
const инфо = {
  kind: 'info', title: 'Ваш талон', signPrompt: '', thankYouText: 'Спасибо, подойдите к стойке',
  idleReturnSec: 0, thankYouSec: 3,
  pages: [
    { headingRuns: [{ text: 'Талон' }],
      blocks: [{ runs: [{ text: 'ВАШ НОМЕР В ОЧЕРЕДИ' }], ord: 0 }, { imageTag: 'КОД', imageWidth: 40, ord: 1 }],
      includeDynamic: false },
    { headingRuns: [{ text: 'Что дальше' }],
      blocks: [{ runs: [{ text: 'ДОЖДИТЕСЬ ВЫЗОВА' }], ord: 0 }], includeDynamic: false }
  ]
};
ok((await put('/document', инфо)).status === 200, 'информационный документ сохранён');
ok(((await call('/document')).body || {}).kind === 'info', 'вид документа сохранился');

const kiosk = await (await browser.newContext({ viewport: { width: 900, height: 1400 } })).newPage();
kiosk.on('pageerror', e => { console.error('FAIL ошибка на планшете: ' + e.message); fail++; });
await kiosk.goto(BASE + '/');
await kiosk.evaluate(t => localStorage.setItem('sk_device_token', t), tok.token);
await kiosk.reload();
await kiosk.waitForTimeout(1500);
ok((await post('/show-document', { target: 'device:' + tok.deviceId, fields: {}, images: { 'КОД': 'data:image/png;base64,' + PNG } })).status === 200,
  'информационный документ отправлен на планшет');
await kiosk.waitForSelector('text=ВАШ НОМЕР В ОЧЕРЕДИ', { timeout: 8000 });
ok(await kiosk.locator('#document .doc-image img').count() === 1, 'картинка из заказа показана');

// Шагов ровно два: экрана подписи нет.
const шаги = await kiosk.textContent('#docProgress');
ok(/из 2/.test(шаги || ''), 'шагов ровно два, экрана подписи нет: ' + шаги);

await kiosk.click('#btnNext');
await kiosk.waitForSelector('text=ДОЖДИТЕСЬ ВЫЗОВА', { timeout: 4000 });
const подпись = await kiosk.textContent('#btnNext');
ok(подпись.trim() === 'Готово', 'на последней странице кнопка «Готово», а не «Далее»: ' + подпись.trim());
ok(await kiosk.locator('#document canvas').count() === 0, 'поля для росчерка на экране нет');

await kiosk.click('#btnNext');
await kiosk.waitForSelector('#document .thankyou', { timeout: 4000 });
ok(/подойдите к стойке/i.test(await kiosk.textContent('#document')), 'показано прощание');

// Планшет сам вернулся к рекламе, данные клиента стёрты.
await kiosk.waitForSelector('#slideshow:not(.hidden)', { timeout: 12000 });
ok(true, 'планшет сам вернулся к рекламе');
const состояние = ((await call('/devices')).body || []).find(d => d.id === tok.deviceId);
ok(состояние && состояние.screen === 'slides', 'сервер тоже считает планшет вернувшимся: ' + (состояние || {}).screen);
ok(((await call('/signatures')).body || []).length === 0, 'записи не появилось: подписывать было нечего');

// ---------- 3. Подписать информационный документ нельзя даже в обход ----------
await post('/show-document', { target: 'device:' + tok.deviceId, fields: {}, images: { 'КОД': 'data:image/png;base64,' + PNG } });
await kiosk.waitForSelector('text=ВАШ НОМЕР В ОЧЕРЕДИ', { timeout: 8000 });
const обход = await kiosk.evaluate(async (пиксель) => {
  const r = await fetch('/api/sign', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + localStorage.getItem('sk_device_token') },
    body: JSON.stringify({ items: [], groups: [], signatures: [], scans: [], signature: пиксель, submissionId: 'обход-инфо' }) });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, body: j };
}, 'data:image/png;base64,' + PNG);
ok(обход.status === 400 && /информационный/.test((обход.body || {}).error || ''),
  'запись по информационному документу отклонена: ' + JSON.stringify(обход.body));
ok(((await call('/signatures')).body || []).length === 0, 'и записи по-прежнему нет');

// ---------- 4. Признак «не в PDF» у подписного документа ----------
const подписной = {
  title: 'Согласие', signPrompt: 'Распишитесь', thankYouText: 'Спасибо', idleReturnSec: 0,
  pages: [
    { headingRuns: [{ text: 'ВСТУПЛЕНИЕ' }], inPdf: false,
      blocks: [{ runs: [{ text: 'ВНИМАТЕЛЬНО ПРОЧИТАЙТЕ' }], ord: 0 }], includeDynamic: false },
    { headingRuns: [{ text: 'Согласие' }],
      blocks: [
        { runs: [{ text: 'ГЛАВНЫЙ ТЕКСТ' }], ord: 0 },
        { runs: [{ text: 'ПОЯСНЕНИЕ ДЛЯ ЭКРАНА' }], inPdf: false, ord: 1 }
      ],
      checkboxes: [{ key: 'ok', label: 'Согласен', required: true, ord: 2 }], includeDynamic: false }
  ]
};
ok((await put('/document', подписной)).status === 200, 'подписной документ с исключениями сохранён');
const сохр = (await call('/document')).body;
ok(сохр.pages[0].inPdf === false, 'страница помечена «не в PDF»');
ok(сохр.pages[1].inPdf === true, 'страница с чекбоксом исключить не дали: признак вернулся на место');
ok(сохр.pages[1].blocks[1].inPdf === false, 'а блок внутри неё исключить можно');

await post('/show-document', { target: 'device:' + tok.deviceId, fields: {} });
await kiosk.waitForSelector('text=ВНИМАТЕЛЬНО ПРОЧИТАЙТЕ', { timeout: 8000 });
ok(true, 'исключённая страница клиенту всё равно показана');
for (let шаг = 0; шаг < 8; шаг++) {
  if (await kiosk.$('#btnSign')) {
    const box = await kiosk.locator('#document canvas').boundingBox();
    await kiosk.mouse.move(box.x + 40, box.y + 40); await kiosk.mouse.down();
    await kiosk.mouse.move(box.x + 200, box.y + 80, { steps: 8 }); await kiosk.mouse.up();
    await kiosk.waitForSelector('#btnSign:not([disabled])', { timeout: 3000 });
    await kiosk.click('#btnSign'); break;
  } else if (await kiosk.$('#btnNext')) {
    for (const b of await kiosk.$$('#document .check input')) if (!(await b.isChecked())) await b.click();
    await kiosk.waitForSelector('#btnNext:not([disabled])', { timeout: 3000 });
    await kiosk.click('#btnNext'); await kiosk.waitForTimeout(120);
  } else break;
}
await kiosk.waitForSelector('#document .thankyou', { timeout: 8000 });
await admin.waitForTimeout(700);

const { readdirSync, readFileSync } = await import('node:fs');
const SIGDIR = '' + (process.env.SK_RABOTA || '.') + '/data_v3/signatures';
const папка = readdirSync(SIGDIR).sort().reverse()[0];
const запись = JSON.stringify(JSON.parse(readFileSync(SIGDIR + '/' + папка + '/document.json', 'utf8')));
ok(/ВНИМАТЕЛЬНО ПРОЧИТАЙТЕ/.test(запись), 'в записи исключённая страница ЕСТЬ: запись это правда о том, что видел клиент');
ok(/ПОЯСНЕНИЕ ДЛЯ ЭКРАНА/.test(запись), 'и исключённый блок в записи тоже есть');

const записи = (await call('/signatures')).body;
const pdf = await admin.request.get(BASE + '/api/admin/signatures/' + записи[0].id + '/pdf');
const байты = (await pdf.body()).toString('latin1');
ok(pdf.status() === 200, 'PDF собран');
// В PDF текст лежит закодированным, поэтому судим по числу страниц и по раскладке.
const раскладка = await post('/document/pdf-layout', { fields: {} });
const тексты = ((раскладка.body || {}).items || []).map(i => i.text || '').join(' ');
ok(/ГЛАВНЫЙ ТЕКСТ/.test(тексты), 'в PDF попал главный текст');
ok(!/ВНИМАТЕЛЬНО ПРОЧИТАЙТЕ/.test(тексты), 'исключённой страницы в PDF нет');
ok(!/ПОЯСНЕНИЕ ДЛЯ ЭКРАНА/.test(тексты), 'исключённого блока в PDF нет');
ok(/Согласен/.test(тексты), 'а отметка клиента в PDF на месте');

// ---------- 5. Редактор: переключатель вида и признаки «в PDF» ----------
await admin.reload();
await admin.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
const отказЧерн = admin.locator('.modal button', { hasText: 'Отказаться от черновика' });
try { await отказЧерн.waitFor({ state: 'visible', timeout: 2500 }); await отказЧерн.click(); } catch {}
await admin.click('.tab[data-tab="document"]');
await admin.waitForSelector('[data-panel="document"]:not(.hidden)', { timeout: 4000 });
await admin.waitForSelector('[data-role="doctab"]', { timeout: 5000 });
await admin.waitForTimeout(500);

ok((await admin.textContent('#docHeading')) === 'Документ для подписанта', 'открыт подписной документ');
const флаги = admin.locator('[data-role="pageinpdf"]');
ok(await флаги.count() === 2, 'у каждой страницы есть переключатель «в PDF»');
ok(await флаги.nth(0).isChecked() === false, 'у вступительной страницы он снят');
ok(await флаги.nth(1).isChecked() === true, 'у страницы с чекбоксом он стоит');
ok(await флаги.nth(1).isDisabled() === true, 'и недоступен: там клиент подтверждает');
// Подсказка берётся у той самой недоступной пометки, а не у первой попавшейся: пометки
// «в PDF» есть и у страниц, и у блоков, и по порядку в разметке они перемешаны.
const подсказка = await admin.evaluate(() => {
  const i = document.querySelector('[data-role="pageinpdf"]:disabled');
  return i ? i.closest('.pdf-flag').getAttribute('title') : '';
});
ok(/подтверждает/.test(подсказка || ''), 'подсказка объясняет, почему нельзя: ' + (подсказка || '').slice(0, 60));
ok(await admin.locator('[data-role="blockinpdf"]').count() >= 3, 'у блоков переключатель тоже есть');

// Переключение вида на информационный отказывается, когда есть поле подписи.
await admin.evaluate(async () => {
  await fetch('/api/admin/document', { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'С подписью', signPrompt: 'x', thankYouText: 'x', idleReturnSec: 0,
      pages: [{ headingRuns: [{ text: 'Стр' }], blocks: [{ runs: [{ text: 'т' }], ord: 0 }],
        signatures: [{ key: 'sig', label: 'Подпись', required: true, ord: 1 }], includeDynamic: false }] }) });
});
await admin.reload();
await admin.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
try { await отказЧерн.waitFor({ state: 'visible', timeout: 2500 }); await отказЧерн.click(); } catch {}
await admin.click('.tab[data-tab="document"]');
await admin.waitForSelector('[data-role="doctab"]', { timeout: 5000 });
await admin.waitForTimeout(500);
// Вид меняется из меню закладки: там же, где всё остальное про сам документ.
await admin.locator('.doc-tab.on .doc-tab-menu').click();
await admin.waitForSelector('[data-role="docmenu"]', { timeout: 3000 });
await admin.locator('.doc-menu .btn', { hasText: 'показ' }).click();
await admin.waitForTimeout(1400);
ok((await admin.textContent('#docHeading')) === 'Документ для подписанта',
  'отказ сервера оставил документ подписным, а не показал ложную смену вида');
ok(((await call('/document')).body || {}).kind !== 'info', 'и документ информационным не стал');

await browser.close();
if (fail === 0) console.log('\nВСЁ ПРОЙДЕНО');
process.exit(fail ? 1 : 0);
