// Снимок сессии подписания. Три правила, каждое из которых раньше нарушалось:
// 1) правка шаблона, пока клиент подписывает, не меняет ни его экран, ни итоговую запись;
// 2) обрыв связи не сбрасывает клиента на первую страницу и не стирает отмеченное;
// 3) сервер не принимает запись без обязательных пунктов, даже минуя страницу планшета,
//    и такой отказ не стирает живую сессию клиента.
import { chromium } from 'playwright';
const BASE = 'http://127.0.0.1:5080';
// Путь к браузеру берётся из окружения: на другой машине он другой, а зашитый путь
// превращал набор в неработающий у всех, кроме одной установки. Пусто значит
// «пусть Playwright возьмёт свой», как он и делает по умолчанию.
const EXE = process.env.SK_CHROME || undefined;
let fail = 0;
const ok = (c, m) => { if (c) console.log('PASS', m); else { console.error('FAIL', m); fail++; } };

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

const enr = (await post('/devices/enroll', { name: 'Планшет снимка', ttlMinutes: 30 })).body;
const tok = await admin.evaluate(async (code) => (await fetch('/api/kiosk/enroll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) })).json(), enr.code);

const ДОК_А = {
  title: 'Согласие', signPrompt: 'Распишитесь', thankYouText: 'Спасибо', idleReturnSec: 0,
  pages: [
    { headingRuns: [{ text: 'Шаг 1' }],
      blocks: [{ runs: [{ text: 'СТАРЫЙ ТЕКСТ соглашения для {{ФИО}}' }], ord: 0 }],
      checkboxes: [{ key: 'soglasie', label: 'Я согласен', required: true, ord: 1 }],
      includeDynamic: false },
    { headingRuns: [{ text: 'Шаг 2' }],
      blocks: [{ runs: [{ text: 'Вторая страница СТАРАЯ' }] }],
      includeDynamic: false }
  ]
};
ok((await put('/document', ДОК_А)).status === 200, 'шаблон А сохранён');

const kiosk = await (await browser.newContext({ viewport: { width: 900, height: 1400 } })).newPage();
kiosk.on('pageerror', e => { console.error('FAIL ошибка на планшете: ' + e.message); fail++; });
await kiosk.goto(BASE + '/');
await kiosk.evaluate(t => localStorage.setItem('sk_device_token', t), tok.token);
await kiosk.reload();
await kiosk.waitForTimeout(1500);
ok((await post('/show-document', { target: 'device:' + tok.deviceId, fields: { 'ФИО': 'Иванов Пётр' } })).status === 200,
  'документ отправлен на планшет');
await kiosk.waitForSelector('text=СТАРЫЙ ТЕКСТ', { timeout: 8000 });

// Клиент отмечает обязательный пункт и уходит на вторую страницу.
await kiosk.locator('label', { hasText: 'Я согласен' }).click();
await kiosk.waitForSelector('#btnNext:not([disabled])', { timeout: 4000 });
await kiosk.click('#btnNext');
await kiosk.waitForSelector('text=Вторая страница СТАРАЯ', { timeout: 4000 });

// ---------- 1. Оператор правит шаблон, пока клиент подписывает ----------
const ДОК_Б = JSON.parse(JSON.stringify(ДОК_А));
ДОК_Б.pages[0].blocks[0].runs[0].text = 'НОВЫЙ ТЕКСТ соглашения для {{ФИО}}';
ДОК_Б.pages[1].blocks[0].runs[0].text = 'Вторая страница НОВАЯ';
ok((await put('/document', ДОК_Б)).status === 200, 'оператор сохранил шаблон Б посреди подписания');
await kiosk.waitForTimeout(800);
ok((await kiosk.textContent('#document')).indexOf('СТАРАЯ') >= 0,
  'экран клиента не изменился: он подписывает то, что ему показали');

// ---------- 2. Обрыв связи ----------
await kiosk.evaluate(() => window.__sk_test_drop());
await kiosk.waitForTimeout(5500);
const послеОбрыва = await kiosk.textContent('#document');
ok(послеОбрыва.indexOf('Вторая страница СТАРАЯ') >= 0,
  'после переподключения клиент там же, где был: на второй странице СТАРОГО документа');
ok(послеОбрыва.indexOf('НОВАЯ') < 0, 'новый шаблон на экран не пролез и после переподключения');
// Отметка не пропала: возвращаемся и смотрим.
await kiosk.locator('#docFooter button', { hasText: 'Назад' }).click();
await kiosk.waitForTimeout(300);
ok(await kiosk.locator('.check input:checked').count() === 1, 'отмеченный пункт пережил обрыв связи');
await kiosk.click('#btnNext');
await kiosk.waitForTimeout(300);

// ---------- 3. Обход страницы: запись без обязательного пункта ----------
const ПИКСЕЛЬ = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const обход = await kiosk.evaluate(async (пиксель) => {
  const r = await fetch('/api/sign', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + localStorage.getItem('sk_device_token') },
    body: JSON.stringify({ items: [{ key: 'soglasie', label: 'Я согласен', checked: false }], groups: [], signatures: [], scans: [], signature: пиксель, submissionId: 'обход-1' })
  });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, body: j };
}, ПИКСЕЛЬ);
ok(обход.status === 400 && /обязательное/i.test((обход.body || {}).error || ''),
  'запись без обязательного пункта отклонена сервером: ' + JSON.stringify(обход.body));
await kiosk.waitForTimeout(500);
ok((await kiosk.textContent('#document')).indexOf('СТАРАЯ') >= 0,
  'отказ не стёр сессию: клиент продолжает подписывать');

// ---------- 4. Честное подписание доходит до конца и хранит СТАРЫЙ документ ----------
await kiosk.waitForSelector('#btnNext:not([disabled])', { timeout: 4000 });
await kiosk.click('#btnNext');
await kiosk.waitForSelector('#btnSign', { timeout: 4000 });
const box = await kiosk.locator('#document canvas').boundingBox();
await kiosk.mouse.move(box.x + 40, box.y + 40); await kiosk.mouse.down();
await kiosk.mouse.move(box.x + 200, box.y + 80, { steps: 8 }); await kiosk.mouse.up();
await kiosk.waitForSelector('#btnSign:not([disabled])', { timeout: 3000 });
await kiosk.click('#btnSign');
await kiosk.waitForSelector('#document .thankyou', { timeout: 8000 });
await admin.waitForTimeout(600);

const записи = (await call('/signatures')).body;
const запись = (await call('/signatures/' + записи[0].id)).body;
// Первоисточник это document.json рядом с записью: из него собирается PDF. Ответ API отдаёт
// сводку записи без тела документа, и по нему судить о содержимом нельзя.
const { readdirSync, readFileSync } = await import('node:fs');
const SIGDIR = '' + (process.env.SK_RABOTA || '.') + '/data_v3/signatures';
const папка = readdirSync(SIGDIR).sort().reverse()[0];
// Файл хранит кириллицу в виде \u-последовательностей: сравнивать можно только разобранный
// JSON, по сырому тексту искать русские слова бессмысленно.
const хранимое = JSON.stringify(JSON.parse(readFileSync(SIGDIR + '/' + папка + '/document.json', 'utf8'))) + JSON.stringify(запись);
ok(хранимое.indexOf('СТАРЫЙ ТЕКСТ') >= 0, 'в записи лежит СТАРЫЙ документ, который человек видел');
ok(хранимое.indexOf('НОВЫЙ ТЕКСТ') < 0, 'нового шаблона в записи нет');
ok(хранимое.indexOf('Иванов Пётр') >= 0, 'данные подписанта в записи на месте');
const pdf = await admin.request.get(BASE + '/api/admin/signatures/' + записи[0].id + '/pdf');
ok(pdf.status() === 200, 'PDF собран');

// ---------- 5. Снимок сессии не остаётся лежать после подписания ----------
// Снимок это данные подписанта на диске. После подписания сессии нет, значит и его быть не
// должно: иначе данные клиента лежали бы там до следующего показа.
const снимки = readdirSync('' + (process.env.SK_RABOTA || '.') + '/data_v3/sessions').length;
ok(снимки === 0, 'снимок сессии удалён вместе с данными подписанта (осталось ' + снимки + ')');

// ---------- 6. Подпись по условию на чекбокс появляется без перелистывания ----------
await put('/document', {
  title: 'Согласие', signPrompt: 'Распишитесь', thankYouText: 'Спасибо', idleReturnSec: 0,
  pages: [{
    headingRuns: [{ text: 'Представитель' }],
    blocks: [{ runs: [{ text: 'основной текст' }], ord: 0 }],
    checkboxes: [{ key: 'predst', label: 'Подписывает представитель', required: false, ord: 1 }],
    signatures: [{ key: 'sig-predst', label: 'Подпись представителя', required: false, ord: 2,
      visibleWhen: { field: 'predst', op: 'eq', value: 'true' } }],
    includeDynamic: false
  }]
});
await post('/show-document', { target: 'device:' + tok.deviceId, fields: {} });
await kiosk.waitForSelector('text=основной текст', { timeout: 8000 });
ok(await kiosk.locator('text=Подпись представителя').count() === 0, 'поле подписи скрыто, пока пункт не отмечен');
await kiosk.locator('label', { hasText: 'Подписывает представитель' }).click();
await kiosk.waitForTimeout(400);
ok(await kiosk.locator('text=Подпись представителя').count() === 1,
  'поле подписи появилось сразу при отметке, без перелистывания');

await browser.close();
if (fail === 0) console.log('\nВСЁ ПРОЙДЕНО');
process.exit(fail ? 1 : 0);
