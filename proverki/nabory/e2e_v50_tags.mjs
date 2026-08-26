// Внешняя система шлёт теги так, как ей удобно: {{ПОЛ}} в тексте, «Пол» в условии, «пол» в запросе.
// Сервер сравнивает имена без учёта регистра, и это должно работать на всём пути: подстановка,
// условия, список незаполненных, проверка документа в редакторе.
import { chromium } from 'playwright';
// После перезагрузки редактор может предложить восстановить черновик. Эти проверки про другое,
// поэтому черновик отклоняется, если он предложен.
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
const p = await (await browser.newContext({ viewport: { width: 1400, height: 1000 } })).newPage();
const jsErr = []; p.on('pageerror', e => jsErr.push(e.message));
p.on('dialog', d => d.accept());
await p.goto(BASE + '/admin/');
await p.fill('#password', 'test123'); await p.click('#loginForm button[type=submit]');
await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
await отказатьсяОтЧерновика(p);

const call = (path, opts) => p.evaluate(async ([pa, o]) => {
  const r = await fetch('/api/admin' + pa, Object.assign({ credentials: 'same-origin' }, o || {}));
  let body = null; try { body = await r.json(); } catch { body = null; }
  return { status: r.status, body };
}, [path, opts]);
const put = (path, obj) => call(path, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });
const preview = (raw) => p.evaluate(async (body) => {
  const r = await fetch('/api/admin/document/preview', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body });
  let out = null; try { out = await r.json(); } catch { out = null; }
  return { status: r.status, body: out };
}, raw);

// В тексте тег записан прописными, в условиях как в списке известных.
await put('/document', {
  title: 'Согласие для {{ФИО}}', signPrompt: 'Распишитесь', thankYouText: 'Спасибо', idleReturnSec: 0,
  pages: [{
    headingRuns: [{ text: 'Данные' }],
    blocks: [
      { runs: [{ text: 'ФИО: {{ФИО}}, ДР: {{ДР}}, пол: {{ПОЛ}}, почта: {{email}}, адрес: {{Адрес регистрации}}, телефон: {{telephone}}' }], ord: 0 },
      { runs: [{ text: 'БЛОК-Ж' }], visibleWhen: { field: 'Пол', op: 'eq', value: 'F' }, ord: 1 },
      { runs: [{ text: 'БЛОК-М' }], visibleWhen: { field: 'пол', op: 'eq', value: 'M' }, ord: 2 }
    ],
    checkboxes: [], groups: []
  }],
  signBlocks: [], signBlocksBelow: []
});

const shown = (r) => JSON.stringify(r.body && r.body.document);

// Внешняя система шлёт имена в третьем варианте написания.
let r = await preview(JSON.stringify({ fields: {
  'ФИО': 'Иванова Анна', 'ДР': '01.01.1990', 'пол': 'F', 'email': 'a@b.by',
  'адрес регистрации': 'Минск', 'TELEPHONE': '+375291234567'
} }));
ok(r.status === 200, 'запрос принят: ' + r.status);
ok(/Иванова Анна/.test(shown(r)), 'ФИО подставилось');
ok(/пол: F/.test(shown(r)), 'значение подставилось в {{ПОЛ}}, хотя прислали «пол»');
ok(/адрес: Минск/.test(shown(r)), 'адрес подставился при другом регистре');
ok(/телефон: \+375291234567/.test(shown(r)), 'телефон подставился при других прописных');
ok(/БЛОК-Ж/.test(shown(r)), 'условие на «Пол» сработало от присланного «пол»');
ok(!/БЛОК-М/.test(shown(r)), 'встречное условие при этом не сработало');
ok((r.body.missingPlaceholders || []).length === 0,
  'незаполненных тегов нет, регистр не мешает: ' + JSON.stringify(r.body.missingPlaceholders));

r = await preview(JSON.stringify({ fields: { 'Пол': 'M' } }));
ok(/БЛОК-М/.test(shown(r)) && !/БЛОК-Ж/.test(shown(r)), 'обратный случай тоже работает');

// Незаполненные теги перечисляются в том виде, в каком они стоят в документе.
r = await preview(JSON.stringify({ fields: { 'ФИО': 'Иванова' } }));
const missing = r.body.missingPlaceholders || [];
ok(missing.indexOf('ПОЛ') >= 0 && missing.indexOf('ФИО') < 0,
  'незаполненные названы как в документе: ' + JSON.stringify(missing));

// Проверка документа в редакторе не должна ругаться на регистр.
await p.reload();
await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
await отказатьсяОтЧерновика(p);
await p.click('.tab[data-tab="document"]');
// Справка о тегах свёрнута, чтобы не занимать четверть экрана. Раскрываем её, как это делает
// оператор: список тегов живёт внутри неё.
await p.evaluate(() => { var d = document.querySelector('.tags-box'); if (d) d.open = true; });
await p.waitForSelector('[data-role="itemlist"]', { timeout: 5000 });
await p.click('#checkDoc');
await p.waitForTimeout(500);
const problems = (await p.locator('.problem').allTextContents()).join(' | ');
ok(!/ПОЛ/.test(problems) && !/Адрес регистрации/.test(problems),
  'проверка не считает теги в другом регистре неизвестными: ' + problems);

// ---------- Банер тегов ----------
// Он должен отвечать на вопрос «что вообще можно прислать по API», а не только «что уже
// стоит в документе»: раньше показывались лишь использованные, и это читалось как
// ограничение.
const schema = (await call('/field-schema')).body;
const allTags = schema.fields.map(f => f.name);
const shownTags = (await p.locator('.placeholders .ph-tag:not(.ph-unknown)').allTextContents())
  .map(t => t.replace(/[{}]/g, ''));
ok(JSON.stringify(shownTags) === JSON.stringify(allTags),
  'показаны все теги, которые принимает API, и в том же порядке: ' + shownTags.length + ' из ' + allTags.length);
ok(allTags.indexOf('text10') >= 0 && allTags.indexOf('document') >= 0 && allTags.indexOf('date') >= 0,
  'в списке есть и text1..text10, и document, и date');

const usedTags = (await p.locator('.placeholders .ph-used').allTextContents()).map(t => t.replace(/[{}]/g, ''));
ok(usedTags.indexOf('Пол') >= 0, 'тег, записанный в документе как ПОЛ, отмечен использованным: ' + JSON.stringify(usedTags));
ok(usedTags.indexOf('urine') < 0, 'неиспользованный тег показан, но не отмечен');

// Опечатка в теге должна быть видна прямо здесь.
await put('/document', {
  title: 'Согласие', signPrompt: 'Распишитесь', thankYouText: 'Спасибо', idleReturnSec: 0,
  pages: [{ headingRuns: [{ text: 'Данные' }], blocks: [{ runs: [{ text: 'Опечатка: {{ФИ0}}' }], ord: 0 }], checkboxes: [], groups: [] }],
  signBlocks: [], signBlocksBelow: []
});
await p.reload();
await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
await отказатьсяОтЧерновика(p);
await p.click('.tab[data-tab="document"]');
// Справка о тегах свёрнута, чтобы не занимать четверть экрана. Раскрываем её, как это делает
// оператор: список тегов живёт внутри неё.
await p.evaluate(() => { var d = document.querySelector('.tags-box'); if (d) d.open = true; });
await p.waitForSelector('.placeholders .ph-tag', { timeout: 5000 });
const bad = await p.locator('.placeholders .ph-unknown').allTextContents();
ok(bad.length === 1 && bad[0] === '{{ФИ0}}', 'тег не из списка отмечен отдельно: ' + JSON.stringify(bad));

ok(jsErr.length === 0, 'ошибок JavaScript нет: ' + jsErr.join(' | '));
await browser.close();
console.log(fail === 0 ? '\nВСЁ ПРОЙДЕНО' : '\n' + fail + ' ПРОВЕРОК УПАЛО');
process.exit(fail === 0 ? 0 : 1);
