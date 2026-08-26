// Блок для законных представителей: показывается только девочкам младше 14. Проверяется то,
// что реально дойдёт до планшета, а не то, что нарисовано в редакторе.
import { chromium } from 'playwright';
const BASE = 'http://127.0.0.1:5080';
// Путь к браузеру берётся из окружения: на другой машине он другой, а зашитый путь
// превращал набор в неработающий у всех, кроме одной установки. Пусто значит
// «пусть Playwright возьмёт свой», как он и делает по умолчанию.
const EXE = process.env.SK_CHROME || undefined;
let fail = 0;
const ok = (c, m) => { if (c) console.log('PASS', m); else { console.error('FAIL', m); fail++; } };

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const p = await (await browser.newContext()).newPage();
await p.goto(BASE + '/admin/');
await p.fill('#password', 'test123'); await p.click('#loginForm button[type=submit]');
await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
const call = (path, opts) => p.evaluate(async ([pa, o]) => {
  const r = await fetch('/api/admin' + pa, Object.assign({ credentials: 'same-origin' }, o || {}));
  let b = null; try { b = await r.json(); } catch {} return { status: r.status, body: b };
}, [path, opts]);

const ПРЕДСТАВИТЕЛЬ = 'Являясь законным представителем, подтверждаю.';
await call('/document', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
  title: 'СОГЛАСИЕ', signPrompt: 'Распишитесь', thankYouText: 'Спасибо', idleReturnSec: 0,
  pages: [{ headingRuns: [{ text: 'Условия' }], blocks: [
      { runs: [{ text: 'Общий текст для всех.' }], ord: 0 },
      { runs: [{ text: ПРЕДСТАВИТЕЛЬ }], ord: 1,
        visibleWhen: { field: 'Пол', op: 'eq', value: 'F', and: [{ field: 'ДР', op: 'agelt', value: '14' }] } }],
    checkboxes: [], groups: [], signatures: [], scans: [] }],
  signBlocks: [], signBlocksBelow: [] }) });

const текстДля = async (fields) => {
  const r = await call('/document/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: fields }) });
  return { status: r.status, text: JSON.stringify(r.body) };
};

const девочка10 = await текстДля({ 'Пол': 'F', 'ДР': '01.01.2016' });
ok(девочка10.text.includes(ПРЕДСТАВИТЕЛЬ), 'девочке 10 лет блок показывается');

const девушка20 = await текстДля({ 'Пол': 'F', 'ДР': '01.01.2000' });
ok(!девушка20.text.includes(ПРЕДСТАВИТЕЛЬ), 'женщине 20 лет не показывается');

const мальчик10 = await текстДля({ 'Пол': 'M', 'ДР': '01.01.2016' });
ok(!мальчик10.text.includes(ПРЕДСТАВИТЕЛЬ), 'мальчику 10 лет не показывается: второе условие тоже должно совпасть');

// Ровно 14 лет это уже не «меньше 14».
const сегодня = new Date();
const ровно14 = String(сегодня.getDate()).padStart(2, '0') + '.' +
  String(сегодня.getMonth() + 1).padStart(2, '0') + '.' + (сегодня.getFullYear() - 14);
const вДень14 = await текстДля({ 'Пол': 'F', 'ДР': ровно14 });
ok(!вДень14.text.includes(ПРЕДСТАВИТЕЛЬ), 'в день четырнадцатилетия уже не показывается: ' + ровно14);
const заДень = new Date(сегодня.getFullYear() - 14, сегодня.getMonth(), сегодня.getDate() + 1);
const почти14 = String(заДень.getDate()).padStart(2, '0') + '.' +
  String(заДень.getMonth() + 1).padStart(2, '0') + '.' + заДень.getFullYear();
const заДеньДо = await текстДля({ 'Пол': 'F', 'ДР': почти14 });
ok(заДеньДо.text.includes(ПРЕДСТАВИТЕЛЬ), 'за день до четырнадцатилетия ещё показывается: ' + почти14);

// Дата в другом формате понимается так же.
const другойФормат = await текстДля({ 'Пол': 'F', 'ДР': '2016-01-01' });
ok(другойФормат.text.includes(ПРЕДСТАВИТЕЛЬ), 'формат 2016-01-01 понимается тоже');

// Регистр имени тега не важен: сервер сравнивает без учёта регистра.
const другойРегистр = await текстДля({ 'пол': 'F', 'др': '01.01.2016' });
ok(другойРегистр.text.includes(ПРЕДСТАВИТЕЛЬ), 'регистр имён тегов не важен');

// Дата, которую нельзя разобрать, не должна молча прятать блок: приходит понятная ошибка.
const кривая = await текстДля({ 'Пол': 'F', 'ДР': 'вчера' });
ok(кривая.status === 400 && /ДР|дата/i.test(кривая.text), 'непонятная дата даёт ошибку, а не молчаливо скрытый блок: ' + кривая.text.slice(0, 140));

// Даты нет вообще: блок просто не показывается, ошибки нет.
const безДаты = await текстДля({ 'Пол': 'F' });
ok(безДаты.status === 200 && !безДаты.text.includes(ПРЕДСТАВИТЕЛЬ), 'без даты рождения блок не показывается, но документ работает');

// И то же самое на настоящем планшете, а не только в предпросмотре.
const code = (await call('/devices/enroll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"name":"Планшет"}' })).body.code;
const kiosk = await (await browser.newContext({ viewport: { width: 800, height: 1200 } })).newPage();
await kiosk.goto(BASE + '/?enroll=' + encodeURIComponent(code));
await kiosk.waitForFunction(() => !!localStorage.getItem('sk_device_token'), { timeout: 12000 });
let id = null;
for (let i = 0; i < 40; i++) {
  const d = (await call('/devices')).body || []; const on = d.find(x => x.online);
  if (on) { id = on.id; break; }
  await kiosk.waitForTimeout(250);
}
await call('/show-document', { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ target: 'device:' + id, fields: { 'Пол': 'F', 'ДР': '01.01.2016' } }) });
await kiosk.waitForTimeout(1200);
ok((await kiosk.textContent('body')).includes(ПРЕДСТАВИТЕЛЬ), 'на планшете девочке 10 лет блок виден');

await call('/show-document', { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ target: 'device:' + id, fields: { 'Пол': 'F', 'ДР': '01.01.1990' } }) });
await kiosk.waitForTimeout(1200);
ok(!(await kiosk.textContent('body')).includes(ПРЕДСТАВИТЕЛЬ), 'а взрослой женщине на планшете не виден');

await browser.close();
console.log(fail === 0 ? '\nВСЁ ПРОЙДЕНО' : '\n' + fail + ' ПРОВЕРОК УПАЛО');
process.exit(fail === 0 ? 0 : 1);
