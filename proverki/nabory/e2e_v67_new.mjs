// Новые возможности конструктора: поля ввода, списки, таблицы, оформление блока, широкие
// условия, правила отметок, вёрстка PDF. Проверяется весь путь: сервер разбирает, планшет
// показывает и считает, запись хранит, PDF собирается.
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

const enr = (await post('/devices/enroll', { name: 'Планшет нового', ttlMinutes: 30 })).body;
const tok = await admin.evaluate(async (code) => (await fetch('/api/kiosk/enroll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) })).json(), enr.code);

const ДОК = {
  title: 'Анкета', signPrompt: 'Распишитесь', thankYouText: 'Спасибо', idleReturnSec: 0,
  pdfPageNumbers: true, pdfFooterTitle: true, pdfFooterRecordId: true, pdfFooterBarcode: true,
  pages: [{
    headingRuns: [{ text: 'Данные' }],
    blocks: [
      { runs: [{ text: 'Первый пункт\nВторой пункт\nТретий пункт' }], list: 'bullet', ord: 0 },
      { runs: [{ text: 'ВНИМАНИЕ: важное предупреждение' }], bg: '#fef3c7', borderColor: '#f59e0b', pad: 10, ord: 1 },
      { kind: 'divider', ord: 2 },
      { table: { headerRow: true, widths: [40, 60], rows: [['Услуга', 'Цена'], ['Приём', '2000'], ['Анализ', '850']] }, ord: 3 },
      { runs: [{ text: 'Выделено маркером', mark: '#fde68a' }, { text: ' и своим размером', sizePt: 16 }], ord: 4 },
      { kind: 'pagebreak', ord: 5 },
      { runs: [{ text: 'Текст после разрыва страницы' }], ord: 6 }
    ],
    inputs: [
      { key: 'tel', label: 'Телефон', type: 'phone', required: true, placeholder: '+375 29 000-00-00', ord: 7 },
      { key: 'summa', label: 'Сумма', type: 'number', required: false, ord: 8 }
    ],
    checkboxes: [
      { key: 'soglasen', label: 'Согласен', required: false, ord: 9 },
      { key: 'otkaz', label: 'Отказываюсь', required: false, ord: 10 },
      { key: 'a1', label: 'Пункт А', required: false, ord: 11 },
      { key: 'a2', label: 'Пункт Б', required: false, ord: 12 }
    ],
    checkRules: [
      { kind: 'exclusive', keys: ['soglasen', 'otkaz'] },
      { kind: 'minchecked', keys: ['a1', 'a2'], n: 1 }
    ],
    showCheckAll: true,
    includeDynamic: false
  }, {
    headingRuns: [{ text: 'Для крупных сумм' }],
    blocks: [{ runs: [{ text: 'БЛОК ДЛЯ БОЛЬШОЙ СУММЫ' }], ord: 0 }],
    visibleWhen: { field: 'summa', op: 'numge', value: '5000' },
    includeDynamic: false
  }]
};
ok((await put('/document', ДОК)).status === 200, 'документ с новыми возможностями сохранён');

// ---------- 1. Хранение переживает круг ----------
const сохр = (await call('/document')).body;
const стр = сохр.pages[0];
ok((стр.blocks[0] || {}).list === 'bullet', 'список сохранился');
ok((стр.blocks[3] || {}).table && стр.blocks[3].table.rows.length === 3, 'таблица сохранилась: 3 строки');
ok((стр.blocks[1] || {}).bg === '#fef3c7' && стр.blocks[1].pad === 10, 'плашка и отступ сохранились');
ok((стр.blocks[2] || {}).kind === 'divider' && (стр.blocks[5] || {}).kind === 'pagebreak', 'черта и разрыв сохранились');
ok((стр.inputs || []).length === 2 && стр.inputs[0].type === 'phone', 'поля ввода сохранились');
ok((стр.checkRules || []).length === 2, 'правила отметок сохранились');
ok(стр.showCheckAll === true, 'кнопка «отметить всё» сохранилась');
const маркер = (стр.blocks[4].runs || []).find(r => r.mark);
ok(маркер && маркер.mark === '#fde68a', 'выделение маркером сохранилось');
ok((стр.blocks[4].runs || []).some(r => r.sizePt === 16), 'свой размер шрифта сохранился');

// ---------- 2. Условие по числу ----------
const пред = async (fields) => {
  const r = await post('/document/preview', { document: ДОК, fields: fields || {} });
  return r.status === 200 ? JSON.stringify(r.body.document) : 'ОШИБКА ' + r.status;
};
// Условие на поле ввода живое: его вычисляет планшет, пока клиент печатает, поэтому страница
// доезжает до него вместе с условием. Это проверяется ниже, на самом планшете.
const живое = await пред({});
ok(/"op":"numge"/.test(живое), 'условие по числу на поле ввода уехало на планшет как живое');

// Условие по числу на обычном теге решается сервером до отправки.
const ДОК_ТЕГ = JSON.parse(JSON.stringify(ДОК));
ДОК_ТЕГ.pages[1].visibleWhen = { field: 'Баланс', op: 'numge', value: '5000' };
const предТег = async (fields) => {
  const r = await post('/document/preview', { document: ДОК_ТЕГ, fields: fields || {} });
  return r.status === 200 ? JSON.stringify(r.body.document) : 'ОШИБКА ' + r.status;
};
ok(/БЛОК ДЛЯ БОЛЬШОЙ СУММЫ/.test(await предТег({ 'Баланс': '9000' })), 'условие «число от 5000»: 9000 показывает блок');
ok(!/БЛОК ДЛЯ БОЛЬШОЙ СУММЫ/.test(await предТег({ 'Баланс': '900' })), 'а 900 не показывает');
ok(!/БЛОК ДЛЯ БОЛЬШОЙ СУММЫ/.test(await предТег({})), 'без значения тоже не показывает');
// Строковое сравнение дало бы обратное: «900» больше «5000» как текст.
ok(/БЛОК ДЛЯ БОЛЬШОЙ СУММЫ/.test(await предТег({ 'Баланс': '10000' })), 'числа сравниваются как числа, а не как строки');
ok(!/БЛОК ДЛЯ БОЛЬШОЙ СУММЫ/.test(await предТег({ 'Баланс': 'не число' })), 'не число значит условие не выполнено');

// ---------- 3. Планшет ----------
const kiosk = await (await browser.newContext({ viewport: { width: 900, height: 1500 } })).newPage();
kiosk.on('pageerror', e => { console.error('FAIL ошибка на планшете: ' + e.message); fail++; });
await kiosk.goto(BASE + '/');
await kiosk.evaluate(t => localStorage.setItem('sk_device_token', t), tok.token);
await kiosk.reload();
await kiosk.waitForTimeout(1500);
await post('/show-document', { target: 'device:' + tok.deviceId, fields: {} });
await kiosk.waitForSelector('.doc-list', { timeout: 8000 });

ok(await kiosk.locator('.doc-list li').count() === 3, 'на планшете список из трёх пунктов');
ok(await kiosk.locator('.doc-table th').count() === 2, 'таблица с шапкой из двух столбцов');
ok(await kiosk.locator('.doc-table td').count() === 4, 'и четырьмя обычными ячейками');
ok(await kiosk.locator('.doc-divider').count() === 1, 'горизонтальная черта нарисована');
const плашка = await kiosk.evaluate(() => {
  const el = Array.from(document.querySelectorAll('.doc-text')).find(e => /ВНИМАНИЕ/.test(e.textContent));
  if (!el) return null;
  const cs = getComputedStyle(el);
  return { bg: cs.backgroundColor, border: cs.borderTopWidth, pad: cs.paddingTop };
});
ok(плашка && плашка.bg === 'rgb(254, 243, 199)' && плашка.pad === '10px', 'плашка с фоном и отступом: ' + JSON.stringify(плашка));
ok(await kiosk.locator('.page-input-field').count() === 2, 'два поля ввода на экране');
ok(await kiosk.locator('.check-all').count() === 1, 'кнопка «отметить всё» показана');

// Обязательное поле держит «Далее».
await kiosk.click('#btnNext');
await kiosk.waitForTimeout(400);
ok(await kiosk.locator('.page-input.miss').count() >= 1, 'пустой обязательный телефон подсвечен');

// Неверный телефон объясняется словами.
await kiosk.locator('.page-input-field').first().fill('12');
await kiosk.waitForTimeout(300);
ok(/не похоже на номер/.test(await kiosk.locator('.page-input-hint').first().textContent()),
  'неверный телефон объяснён словами');
await kiosk.locator('.page-input-field').first().fill('+375 29 1234567');
await kiosk.waitForTimeout(300);
ok((await kiosk.locator('.page-input-hint').first().textContent()).trim() === '', 'верный телефон принят');

// Взаимоисключающие пункты.
await kiosk.locator('label.check', { hasText: 'Согласен' }).click();
await kiosk.waitForTimeout(300);
await kiosk.locator('label.check', { hasText: 'Отказываюсь' }).click();
await kiosk.waitForTimeout(300);
const отмечено = await kiosk.evaluate(() => Array.from(document.querySelectorAll('label.check'))
  .filter(l => l.querySelector('input').checked).map(l => l.textContent.trim()));
ok(отмечено.indexOf('Согласен') < 0 && отмечено.some(t => /Отказываюсь/.test(t)),
  'взаимоисключающие: отметка второго сняла первый (' + отмечено.join(', ') + ')');

// Правило «не менее одного».
await kiosk.click('#btnNext');
await kiosk.waitForTimeout(400);
ok(await kiosk.locator('.check.miss').count() >= 1, 'правило «не менее одного» держит и подсвечивает');
await kiosk.locator('label.check', { hasText: 'Пункт А' }).click();
await kiosk.waitForTimeout(300);

// Условие по числу считается прямо на планшете, пока клиент печатает.
await kiosk.locator('.page-input-field').nth(1).fill('9000');
await kiosk.waitForTimeout(500);
await kiosk.click('#btnNext');
await kiosk.waitForTimeout(600);
ok(/БЛОК ДЛЯ БОЛЬШОЙ СУММЫ/.test(await kiosk.textContent('#document')),
  'страница по условию «сумма от 5000» появилась от введённого клиентом значения');

// ---------- 4. Подписание, запись и PDF ----------
await kiosk.click('#btnNext');
await kiosk.waitForSelector('#btnSign', { timeout: 6000 });
const box = await kiosk.locator('#document canvas').boundingBox();
await kiosk.mouse.move(box.x + 40, box.y + 40); await kiosk.mouse.down();
await kiosk.mouse.move(box.x + 200, box.y + 80, { steps: 8 }); await kiosk.mouse.up();
await kiosk.waitForSelector('#btnSign:not([disabled])', { timeout: 3000 });
await kiosk.click('#btnSign');
await kiosk.waitForSelector('#document .thankyou', { timeout: 8000 });
await admin.waitForTimeout(700);

const записи = (await call('/signatures')).body;
const запись = (await call('/signatures/' + записи[0].id)).body;
const введено = (запись.inputs || []);
ok(введено.some(i => i.key === 'tel' && /1234567/.test(i.value)), 'телефон попал в запись: ' + JSON.stringify(введено));
ok(введено.some(i => i.key === 'summa' && i.value === '9000'), 'сумма попала в запись');
const pdf = await admin.request.get(BASE + '/api/admin/signatures/' + записи[0].id + '/pdf');
const байты = await pdf.body();
ok(pdf.status() === 200 && байты.slice(0, 4).toString('latin1') === '%PDF', 'PDF собран');
ok(байты.length > 3000, 'PDF не пустой: ' + байты.length + ' байт');

// Разрыв страницы и колонтитул означают минимум две страницы.
const страниц = (байты.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
ok(страниц >= 2, 'разрыв страницы дал минимум два листа (' + страниц + ')');

// ---------- 5. Обход страницы: сервер сам не примет ----------
await post('/show-document', { target: 'device:' + tok.deviceId, fields: {} });
await kiosk.waitForSelector('.doc-list', { timeout: 8000 });
const ПИКСЕЛЬ = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const обход = await kiosk.evaluate(async (пиксель) => {
  const r = await fetch('/api/sign', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + localStorage.getItem('sk_device_token') },
    body: JSON.stringify({ items: [{ key: 'a1', label: 'Пункт А', checked: true }], groups: [], signatures: [], scans: [], inputs: [], signature: пиксель, submissionId: 'обход-ввод' })
  });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, body: j };
}, ПИКСЕЛЬ);
ok(обход.status === 400 && /Телефон/.test((обход.body || {}).error || ''),
  'сервер не принял запись с пустым обязательным полем: ' + JSON.stringify(обход.body));

const обход2 = await kiosk.evaluate(async (пиксель) => {
  const r = await fetch('/api/sign', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + localStorage.getItem('sk_device_token') },
    body: JSON.stringify({ items: [{ key: 'soglasen', label: 'Согласен', checked: true }, { key: 'otkaz', label: 'Отказываюсь', checked: true }, { key: 'a1', label: 'Пункт А', checked: true }], groups: [], signatures: [], scans: [], inputs: [{ key: 'tel', label: 'Телефон', value: '+375291234567' }], signature: пиксель, submissionId: 'обход-правило' })
  });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, body: j };
}, ПИКСЕЛЬ);
ok(обход2.status === 400 && /взаимоисключающ/.test((обход2.body || {}).error || ''),
  'сервер не принял два взаимоисключающих пункта: ' + JSON.stringify(обход2.body));

await browser.close();
if (fail === 0) console.log('\nВСЁ ПРОЙДЕНО');
process.exit(fail ? 1 : 0);
