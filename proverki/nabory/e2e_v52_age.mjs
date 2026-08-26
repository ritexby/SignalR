// Условие по возрасту. Внешняя система присылает только дату рождения, а документ сам решает,
// показывать ли блок для законных представителей: «возраст меньше 14 лет».
import { chromium } from 'playwright';

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
const p = await (await browser.newContext({ viewport: { width: 1500, height: 1100 } })).newPage();
const jsErr = []; p.on('pageerror', e => jsErr.push(e.message));
p.on('dialog', d => d.accept());
await p.goto(BASE + '/admin/');
await p.fill('#password', 'test123'); await p.click('#loginForm button[type=submit]');
await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
const call = (path, opts) => p.evaluate(async ([pa, o]) => {
  const r = await fetch('/api/admin' + pa, Object.assign({ credentials: 'same-origin' }, o || {}));
  let b = null; try { b = await r.json(); } catch {} return { status: r.status, body: b };
}, [path, opts]);
const preview = (raw) => p.evaluate(async (body) => {
  const r = await fetch('/api/admin/document/preview', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body });
  let out = null; try { out = await r.json(); } catch {}
  return { status: r.status, body: out };
}, raw);

await call('/document', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
  title: 'Согласие', signPrompt: 'Распишитесь', thankYouText: 'Спасибо', idleReturnSec: 0,
  pages: [{ headingRuns: [{ text: 'Данные' }],
    blocks: [
      { runs: [{ text: 'Пациент: {{ФИО}}, {{ДР}}' }], ord: 0 },
      { runs: [{ text: 'БЛОК-ДЛЯ-ПРЕДСТАВИТЕЛЯ' }], ord: 1, visibleWhen: { field: 'ДР', op: 'agelt', value: '14' } },
      { runs: [{ text: 'БЛОК-ДЛЯ-ВЗРОСЛОГО' }], ord: 2, visibleWhen: { field: 'ДР', op: 'agege', value: '18' } },
      { runs: [{ text: 'БЛОК-ПОДРОСТКА' }], ord: 3,
        visibleWhen: { field: 'ДР', op: 'agege', value: '14', and: [{ field: 'ДР', op: 'agelt', value: '18' }] } }
    ],
    checkboxes: [], groups: [] }],
  signBlocks: [], signBlocksBelow: [] }) });

const показано = (r) => JSON.stringify(r.body && r.body.document);
const сегодня = new Date();
const датаЛет = (лет, сдвигДней) => {
  const d = new Date(сегодня.getFullYear() - лет, сегодня.getMonth(), сегодня.getDate() + (сдвигДней || 0));
  return String(d.getDate()).padStart(2, '0') + '.' + String(d.getMonth() + 1).padStart(2, '0') + '.' + d.getFullYear();
};

// Ребёнку десять: только блок для представителя.
let r = await preview(JSON.stringify({ fields: { 'ФИО': 'Иванов Пётр', 'ДР': датаЛет(10) } }));
ok(r.status === 200, 'запрос принят');
ok(/БЛОК-ДЛЯ-ПРЕДСТАВИТЕЛЯ/.test(показано(r)), 'десять лет: показан блок для законного представителя');
ok(!/БЛОК-ДЛЯ-ВЗРОСЛОГО/.test(показано(r)) && !/БЛОК-ПОДРОСТКА/.test(показано(r)), 'и только он');

// Ровно четырнадцать: уже не представитель, но ещё не взрослый.
r = await preview(JSON.stringify({ fields: { 'ДР': датаЛет(14) } }));
ok(!/БЛОК-ДЛЯ-ПРЕДСТАВИТЕЛЯ/.test(показано(r)), 'ровно 14: блок для представителя скрыт');
ok(/БЛОК-ПОДРОСТКА/.test(показано(r)), 'и показан блок для 14-17');
ok(!/БЛОК-ДЛЯ-ВЗРОСЛОГО/.test(показано(r)), 'взрослый блок ещё не показан');

// За день до четырнадцатилетия человек ещё младше.
r = await preview(JSON.stringify({ fields: { 'ДР': датаЛет(14, 1) } }));
ok(/БЛОК-ДЛЯ-ПРЕДСТАВИТЕЛЯ/.test(показано(r)), 'за день до дня рождения возраст ещё 13');

// Взрослый.
r = await preview(JSON.stringify({ fields: { 'ДР': датаЛет(40) } }));
ok(/БЛОК-ДЛЯ-ВЗРОСЛОГО/.test(показано(r)) && !/БЛОК-ДЛЯ-ПРЕДСТАВИТЕЛЯ/.test(показано(r)), 'сорок лет: только взрослый блок');

// Другие форматы даты.
for (const [вид, значение] of [['ISO', '1990-05-17'], ['через дробь', '17/05/1990'], ['через дефис', '17-05-1990']]) {
  const res = await preview(JSON.stringify({ fields: { 'ДР': значение } }));
  ok(/БЛОК-ДЛЯ-ВЗРОСЛОГО/.test(показано(res)), 'дата ' + вид + ' разобрана: ' + значение);
}

// Дата, которую разобрать нельзя: понятная ошибка, а не молча скрытый блок.
r = await preview(JSON.stringify({ fields: { 'ДР': 'вчера' } }));
ok(r.status === 400 && /ДР/.test((r.body || {}).error || ''), 'негодная дата отклоняется с именем тега: ' + (r.body || {}).error);
ok(/01\.01\.1990/.test((r.body || {}).error || ''), 'и с примером правильного вида');

// Даты нет вовсе: не ошибка, просто ни один возрастной блок не показывается.
r = await preview(JSON.stringify({ fields: { 'ФИО': 'Без даты' } }));
ok(r.status === 200 && !/БЛОК-ДЛЯ-ПРЕДСТАВИТЕЛЯ/.test(показано(r)) && !/БЛОК-ДЛЯ-ВЗРОСЛОГО/.test(показано(r)),
  'без даты возрастные блоки не показываются, и это не ошибка');

// Дата из будущего это ошибка данных, а не нулевой возраст.
r = await preview(JSON.stringify({ fields: { 'ДР': датаЛет(-1) } }));
ok(!/БЛОК-ДЛЯ-ПРЕДСТАВИТЕЛЯ/.test(показано(r)), 'дата из будущего не делает человека младенцем');

// ---------- Редактор ----------
await p.reload();
await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
await отказатьсяОтЧерновика(p);
await p.click('.tab[data-tab="document"]');
await p.waitForSelector('.cond-box', { timeout: 5000 });
const значок = await p.locator('.block-card .cond-badge').nth(1).textContent();
ok(/возраст по «ДР» меньше 14 лет/.test(значок), 'значок читается по-человечески: ' + значок);

const cond = p.locator('.block-card .cond-box').nth(1);
await cond.locator('.cond-badge').click();
await p.waitForTimeout(200);
const операции = await cond.locator('[data-role="cop"] option').allTextContents();
ok(операции.some(t => /возраст меньше/.test(t)) && операции.some(t => /возраст от/.test(t)),
  'обе операции по возрасту есть в списке: ' + JSON.stringify(операции));
ok(await cond.locator('[data-role="cval"]').getAttribute('type') === 'number', 'значение вводится числом');

// Проверка документа предупреждает, если возраст считают не по дате.
await call('/document', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
  title: 'Согласие', signPrompt: 'Распишитесь', thankYouText: 'Спасибо', idleReturnSec: 0,
  pages: [{ headingRuns: [{ text: 'Данные' }],
    blocks: [{ runs: [{ text: 'Текст' }], ord: 0, visibleWhen: { field: 'ФИО', op: 'agelt', value: '14' } }],
    checkboxes: [], groups: [] }], signBlocks: [], signBlocksBelow: [] }) });
await p.reload();
await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
await отказатьсяОтЧерновика(p);
await p.click('.tab[data-tab="document"]');
await p.waitForSelector('.cond-box', { timeout: 5000 });
await p.click('#checkDoc');
await p.waitForSelector('.problems', { timeout: 4000 });
const замечания = (await p.locator('.problem').allTextContents()).join(' | ');
ok(/возраст считается по «ФИО»/.test(замечания), 'предупреждение про неподходящий тег: ' + замечания.slice(0, 90));

ok(jsErr.length === 0, 'ошибок JavaScript нет: ' + jsErr.join(' | '));
await browser.close();
console.log(fail === 0 ? '\nВСЁ ПРОЙДЕНО' : '\n' + fail + ' ПРОВЕРОК УПАЛО');
process.exit(fail === 0 ? 0 : 1);
