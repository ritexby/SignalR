// Тексты чекбоксов и двойных зависимых чекбоксов, присланные по API: замена и дописывание.
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

const ТЕКСТ = 'С момента последнего приема пищи прошло не менее 8 часов';
await call('/document', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
  title: 'АНКЕТА', signPrompt: 'Распишитесь', thankYouText: 'Спасибо', idleReturnSec: 0,
  pages: [{ headingRuns: [{ text: 'Подготовка' }], blocks: [], signatures: [], scans: [],
    checkboxes: [{ key: 'golod', label: ТЕКСТ, required: true, ord: 0 }],
    groups: [{ key: 'pisha', title: ТЕКСТ, required: true, ord: 1,
      options: [{ key: 'da', label: 'ДА' }, { key: 'net', label: 'НЕТ' }] }] }],
  signBlocks: [], signBlocksBelow: [] }) });

// Планшет, на который будем показывать.
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

const показать = async (body) => {
  await call('/show-document', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(Object.assign({ target: 'device:' + id, fields: {} }, body)) });
  await kiosk.waitForTimeout(900);
  return (await kiosk.textContent('body')).replace(/\s+/g, ' ');
};

// 1. Без присланного текста стоит текст документа.
let t = await показать({});
ok(t.includes(ТЕКСТ), 'без присланного текста стоит текст документа');

// 2. Замена текста чекбокса.
t = await показать({ checkboxes: [{ key: 'golod', checked: false, label: 'Совсем другой вопрос' }] });
ok(t.includes('Совсем другой вопрос'), 'текст чекбокса заменяется присланным');
const текстПункта = async () => kiosk.evaluate(() => {
  const n = document.querySelector('.checks .check');
  return n ? n.textContent.replace(/\s+/g, ' ').trim() : '';
});
ok(!(await текстПункта()).includes('С момента'), 'старый текст чекбокса ушёл: ' + await текстПункта());

// 3. Дописывание к тексту чекбокса.
t = await показать({ checkboxes: [{ key: 'golod', checked: false, labelAppend: '(уточнение: с 22:00)' }] });
ok(t.includes(ТЕКСТ + ' (уточнение: с 22:00)'), 'к тексту чекбокса дописывается присланное: ' +
  (t.match(/С момента[^«]{0,80}/) || [''])[0]);

// 4. Заголовок группы: замена и дописывание, и подписи вариантов.
t = await показать({ groups: [{ key: 'pisha', selected: '', title: 'Голодание перед сдачей' }] });
console.log('ЗАГОЛОВОК ГРУППЫ:', await kiosk.evaluate(() => {
  const n = document.querySelector('.group-title, .grp-title, .group h3, .group');
  return n ? n.textContent.replace(/\s+/g, ' ').trim().slice(0, 120) : 'группа не найдена';
}));
ok(t.includes('Голодание перед сдачей'), 'заголовок группы заменяется');

t = await показать({ groups: [{ key: 'pisha', selected: '', titleAppend: '(не менее 8 часов)' }] });
ok(t.includes(ТЕКСТ + ' (не менее 8 часов)'), 'к заголовку группы дописывается присланное');

t = await показать({ groups: [{ key: 'pisha', selected: '', options: [
  { key: 'da', label: 'ДА, соблюдал' }, { key: 'net', labelAppend: ', не соблюдал' }] }] });
ok(t.includes('ДА, соблюдал'), 'текст варианта заменяется');
ok(t.includes('НЕТ, не соблюдал'), 'к тексту варианта дописывается присланное');

// 5. Варианты ответов можно прислать целиком: присланный список заменяет тот, что в документе.
t = await показать({ groups: [{ key: 'pisha', selected: 'menee', options: [
  { key: 'menee', label: 'Менее 8 часов' }, { key: 'bolee', label: 'Более 8 часов' },
  { key: 'nepomnyu', label: 'Не помню' }] }] });
ok(t.includes('Менее 8 часов') && t.includes('Более 8 часов') && t.includes('Не помню'),
  'присланные варианты показаны все три');
ok(!t.includes('ДА') && !t.includes('НЕТ'), 'а варианты из документа заменены, а не добавлены');

// Варианты на планшете стоят в одну строку под вопросом.
const рядом = await kiosk.evaluate(() => {
  const box = document.querySelector('.group-options');
  if (!box) return { нет: true };
  const rows = {};
  box.querySelectorAll('.check').forEach(n => {
    const y = Math.round(n.getBoundingClientRect().top);
    rows[y] = (rows[y] || 0) + 1;
  });
  const строки = Object.values(rows);
  const заголовок = document.querySelector('.group-title');
  return { строк: строки.length, вСтроке: Math.max.apply(null, строки),
    заголовокВыше: заголовок ? заголовок.getBoundingClientRect().bottom <= box.getBoundingClientRect().top + 1 : null };
});
ok(!рядом.нет, 'блок вариантов найден');
ok(рядом.вСтроке === 3, 'три варианта стоят в одной строке: ' + JSON.stringify(рядом));
ok(рядом.заголовокВыше === true, 'а вопрос остался над ними');

// Выбор из присланного списка доходит до планшета.
const отмечен = await kiosk.evaluate(() => {
  const n = Array.from(document.querySelectorAll('.group-options .check'))
    .find(x => x.textContent.includes('Менее 8 часов'));
  return n ? n.classList.contains('checked') : null;
});
ok(отмечен === true, 'присланный выбор отмечен');

// 6. Присланный текст должен пережить переподключение планшета.
await показать({ checkboxes: [{ key: 'golod', checked: false, labelAppend: '(после переподключения)' }] });
await kiosk.reload();
await kiosk.waitForTimeout(1500);
const после = (await kiosk.textContent('body')).replace(/\s+/g, ' ');
ok(после.includes('(после переподключения)'), 'присланный текст пережил переподключение планшета');

// 7. В сам шаблон ни дописывание, ни присланные варианты не попадают.
const шаблон = (await call('/document')).body;
const cb = шаблон.pages[0].checkboxes[0];
ok(cb.label === ТЕКСТ, 'в шаблоне остался свой текст: ' + cb.label);
ok(!cb.labelAppend, 'дописывание в шаблоне не сохранилось');
const гр = шаблон.pages[0].groups[0];
ok(гр.options.length === 2 && гр.options[0].key === 'da', 'варианты в шаблоне свои: ' + JSON.stringify(гр.options.map(o => o.key)));

await browser.close();
console.log(fail === 0 ? '\nВСЁ ПРОЙДЕНО' : '\n' + fail + ' ПРОВЕРОК УПАЛО');
process.exit(fail === 0 ? 0 : 1);
