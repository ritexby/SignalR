// Условия по сроку: до даты или до её годовщины осталось не больше N дней.
import { chromium } from 'playwright';
const BASE = 'http://127.0.0.1:5080';
// Путь к браузеру берётся из окружения: на другой машине он другой, а зашитый путь
// превращал набор в неработающий у всех, кроме одной установки. Пусто значит
// «пусть Playwright возьмёт свой», как он и делает по умолчанию.
const EXE = process.env.SK_CHROME || undefined;
let fail = 0;
const ok = (c, m) => { if (c) console.log('PASS', m); else { console.error('FAIL', m); fail++; } };
const дата = (сдвигДней, год) => {
  const d = new Date();
  d.setDate(d.getDate() + сдвигДней);
  const y = год != null ? год : d.getFullYear();
  return String(d.getDate()).padStart(2, '0') + '.' + String(d.getMonth() + 1).padStart(2, '0') + '.' + y;
};

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const p = await (await browser.newContext()).newPage();
await p.goto(BASE + '/admin/');
await p.fill('#password', 'test123'); await p.click('#loginForm button[type=submit]');
await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
const call = (path, opts) => p.evaluate(async ([pa, o]) => {
  const r = await fetch('/api/admin' + pa, Object.assign({ credentials: 'same-origin' }, o || {}));
  let b = null; try { b = await r.json(); } catch {} return { status: r.status, body: b };
}, [path, opts]);

const ПОЗДРАВЛЕНИЕ = 'Поздравляем вас с днём рождения!';
const НАПОМИНАНИЕ = 'Ваш приём уже совсем скоро.';
await call('/document', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
  title: 'АНКЕТА', signPrompt: 'x', thankYouText: 'x', idleReturnSec: 0,
  pages: [{ headingRuns: [{ text: 'Общее' }], checkboxes: [], groups: [], signatures: [], scans: [],
    blocks: [
      { runs: [{ text: 'Общий текст.' }], ord: 0 },
      { runs: [{ text: ПОЗДРАВЛЕНИЕ }], ord: 1, visibleWhen: { field: 'ДР', op: 'annivwithin', value: '7' } },
      { runs: [{ text: НАПОМИНАНИЕ }], ord: 2, visibleWhen: { field: 'date', op: 'annivwithin', value: '3' } }] }],
  signBlocks: [], signBlocksBelow: [] }) });

const текст = async (fields) => {
  const r = await call('/document/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: fields }) });
  return { status: r.status, text: JSON.stringify(r.body) };
};

// Годовщина: день рождения в пределах недели, в обе стороны.
ok((await текст({ 'ДР': дата(0, 1985) })).text.includes(ПОЗДРАВЛЕНИЕ), 'в сам день рождения показывается');
ok((await текст({ 'ДР': дата(3, 1985) })).text.includes(ПОЗДРАВЛЕНИЕ), 'за три дня до тоже');
ok((await текст({ 'ДР': дата(-3, 1985) })).text.includes(ПОЗДРАВЛЕНИЕ), 'и через три дня после');
ok((await текст({ 'ДР': дата(7, 1985) })).text.includes(ПОЗДРАВЛЕНИЕ), 'ровно на седьмой день ещё да');
ok(!(await текст({ 'ДР': дата(8, 1985) })).text.includes(ПОЗДРАВЛЕНИЕ), 'на восьмой уже нет');
ok(!(await текст({ 'ДР': дата(-30, 1985) })).text.includes(ПОЗДРАВЛЕНИЕ), 'и месяц спустя нет');
ok((await текст({ 'ДР': дата(0, 2020) })).text.includes(ПОЗДРАВЛЕНИЕ), 'год рождения не важен');

// Второе условие на другом теге работает так же: считается день и месяц.
ok((await текст({ 'date': дата(2) })).text.includes(НАПОМИНАНИЕ), 'через два дня: показывается');
ok((await текст({ 'date': дата(-2) })).text.includes(НАПОМИНАНИЕ), 'и два дня назад тоже');
ok(!(await текст({ 'date': дата(5) })).text.includes(НАПОМИНАНИЕ), 'через пять дней уже нет');
ok((await текст({ 'date': дата(0, new Date().getFullYear() - 5) })).text.includes(НАПОМИНАНИЕ),
  'год не важен: годовщина считается по дню и месяцу');


// Нет даты или она непонятна.
ok(!(await текст({})).text.includes(ПОЗДРАВЛЕНИЕ), 'без даты условие не выполняется');
const кривая = await текст({ 'ДР': 'скоро' });
ok(кривая.status === 400 && /ДР/.test(кривая.text), 'непонятная дата даёт ошибку с именем тега: ' + кривая.text.slice(0, 120));

// Оба формата даты понимаются.
const iso = new Date(); iso.setDate(iso.getDate() + 2);
const isoStr = iso.getFullYear() + '-' + String(iso.getMonth() + 1).padStart(2, '0') + '-' + String(iso.getDate()).padStart(2, '0');
ok((await текст({ 'date': isoStr })).text.includes(НАПОМИНАНИЕ), 'формат 2026-08-23 понимается: ' + isoStr);

// 29 февраля: в невисокосный год празднуется 28-го, иначе условие не сработало бы никогда.
await call('/document', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
  title: 'АНКЕТА', signPrompt: 'x', thankYouText: 'x', idleReturnSec: 0,
  pages: [{ headingRuns: [{ text: 'Общее' }], checkboxes: [], groups: [], signatures: [], scans: [],
    blocks: [{ runs: [{ text: ПОЗДРАВЛЕНИЕ }], ord: 0, visibleWhen: { field: 'ДР', op: 'annivwithin', value: '400' } }] }],
  signBlocks: [], signBlocksBelow: [] }) });
ok((await текст({ 'ДР': '29.02.2000' })).text.includes(ПОЗДРАВЛЕНИЕ), '29 февраля разбирается и считается');

// Редактор: операции есть в списке и просят число дней.
await p.click('[data-tab="document"]'); await p.waitForTimeout(500);
const btn = p.locator('.modal button', { hasText: 'Отказаться от черновика' });
if (await btn.count()) { await btn.click(); await p.waitForTimeout(200); }
const операции = await p.evaluate(() => {
  const s = document.createElement('div');
  return null;
});
const список = await p.evaluate(async () => {
  const t = await (await fetch('/admin/admin.js')).text();
  const m = t.match(/var COND_OPS = \[([\s\S]{0,600}?)\];/);
  return m ? m[1].replace(/\s+/g, ' ') : '';
});
ok(/annivwithin/.test(список), 'условие по годовщине есть в редакторе');
ok(!/datewithin/.test(список), 'а условия по полной дате в редакторе нет');
ok(/до годовщины не больше, дней/.test(список), 'и названо по-человечески');

// Условие по полной дате убрано: такая операция больше не принимается и не сохраняется.
await call('/document', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
  title: 'АНКЕТА', signPrompt: 'x', thankYouText: 'x', idleReturnSec: 0,
  pages: [{ headingRuns: [{ text: 'Общее' }], checkboxes: [], groups: [], signatures: [], scans: [],
    blocks: [{ runs: [{ text: 'Текст.' }], ord: 0, visibleWhen: { field: 'date', op: 'datewithin', value: '3' } }] }],
  signBlocks: [], signBlocksBelow: [] }) });
const убрано = (await call('/document')).body.pages[0].blocks[0].visibleWhen;
ok(убрано.op !== 'datewithin', 'условие по полной дате не сохраняется: стало «' + убрано.op + '»');

// Раздельное окно: дней до и дней после задаются отдельно.
await call('/document', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
  title: 'АНКЕТА', signPrompt: 'x', thankYouText: 'x', idleReturnSec: 0,
  pages: [{ headingRuns: [{ text: 'Общее' }], checkboxes: [], groups: [], signatures: [], scans: [],
    blocks: [{ runs: [{ text: ПОЗДРАВЛЕНИЕ }], ord: 0,
      visibleWhen: { field: 'ДР', op: 'annivwithin', value: '14/1' } }] }],
  signBlocks: [], signBlocksBelow: [] }) });
ok((await текст({ 'ДР': дата(10, 1985) })).text.includes(ПОЗДРАВЛЕНИЕ), 'за десять дней до: показывается (окно 14 до)');
ok((await текст({ 'ДР': дата(14, 1985) })).text.includes(ПОЗДРАВЛЕНИЕ), 'ровно за четырнадцать: ещё да');
ok(!(await текст({ 'ДР': дата(15, 1985) })).text.includes(ПОЗДРАВЛЕНИЕ), 'за пятнадцать: уже нет');
ok((await текст({ 'ДР': дата(-1, 1985) })).text.includes(ПОЗДРАВЛЕНИЕ), 'через день после: ещё да (окно 1 после)');
ok(!(await текст({ 'ДР': дата(-2, 1985) })).text.includes(ПОЗДРАВЛЕНИЕ), 'через два дня после: уже нет');

// Только после: до даты ничего не показывается.
await call('/document', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
  title: 'АНКЕТА', signPrompt: 'x', thankYouText: 'x', idleReturnSec: 0,
  pages: [{ headingRuns: [{ text: 'Общее' }], checkboxes: [], groups: [], signatures: [], scans: [],
    blocks: [{ runs: [{ text: ПОЗДРАВЛЕНИЕ }], ord: 0,
      visibleWhen: { field: 'ДР', op: 'annivwithin', value: '0/30' } }] }],
  signBlocks: [], signBlocksBelow: [] }) });
ok(!(await текст({ 'ДР': дата(1, 1985) })).text.includes(ПОЗДРАВЛЕНИЕ), 'за день до: скрыт (окно 0 до)');
ok((await текст({ 'ДР': дата(0, 1985) })).text.includes(ПОЗДРАВЛЕНИЕ), 'в сам день: показан');
ok((await текст({ 'ДР': дата(-20, 1985) })).text.includes(ПОЗДРАВЛЕНИЕ), 'через двадцать дней после: показан');
ok(!(await текст({ 'ДР': дата(-31, 1985) })).text.includes(ПОЗДРАВЛЕНИЕ), 'через тридцать один: скрыт');

// Запись окна приводится к одному виду и не портится.
const сохранено = (await call('/document')).body.pages[0].blocks[0].visibleWhen;
ok(сохранено.value === '0/30', 'окно сохранено как есть: ' + сохранено.value);

await browser.close();
console.log(fail === 0 ? '\nВСЁ ПРОЙДЕНО' : '\n' + fail + ' ПРОВЕРОК УПАЛО');
process.exit(fail === 0 ? 0 : 1);
