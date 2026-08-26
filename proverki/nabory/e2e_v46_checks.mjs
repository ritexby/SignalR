// Именованные чекбоксы, группы вариантов и условия на то, что клиент отметил.
// Проверяется весь путь: API задаёт состояние одним вызовом, планшет показывает и пересчитывает
// на лету, скрытый пункт не держит клиента, а в запись и в PDF попадает то, что он реально видел.
import { chromium } from 'playwright';
import fs from 'node:fs';

const BASE = 'http://127.0.0.1:5080';
// Путь к браузеру берётся из окружения: на другой машине он другой, а зашитый путь
// превращал набор в неработающий у всех, кроме одной установки. Пусто значит
// «пусть Playwright возьмёт свой», как он и делает по умолчанию.
const EXE = process.env.SK_CHROME || undefined;
const SP = '' + (process.env.SK_RABOTA || '.') + '';
let fail = 0;
const ok = (c, m) => { if (c) console.log('PASS', m); else { console.error('FAIL', m); fail++; } };

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const admin = await (await browser.newContext({ viewport: { width: 1280, height: 1100 } })).newPage();
const adminErr = []; admin.on('pageerror', e => adminErr.push(e.message));
admin.on('dialog', d => d.accept());
await admin.goto(BASE + '/admin/');
await admin.fill('#password', 'test123'); await admin.click('#loginForm button[type=submit]');
await admin.waitForSelector('#app:not(.hidden)', { timeout: 8000 });

const call = (path, opts) => admin.evaluate(async ([pa, o]) => {
  const r = await fetch('/api/admin' + pa, Object.assign({ credentials: 'same-origin' }, o || {}));
  let body = null; try { body = await r.json(); } catch { body = null; }
  return { status: r.status, body };
}, [path, opts]);
const post = (path, obj) => call(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj || {}) });
const put = (path, obj) => call(path, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });

// Документ: именованный чекбокс, группа вариантов и два блока, зависящих от того,
// что клиент отметит прямо сейчас.
const doc = {
  title: 'Согласие', signPrompt: 'Распишитесь', thankYouText: 'Спасибо', idleReturnSec: 0,
  pages: [{
    headingRuns: [{ text: 'Согласия' }],
    blocks: [
      { runs: [{ text: 'ВИДНО-ПРИ-РАССЫЛКЕ' }], visibleWhen: { field: 'marketing', op: 'eq', value: 'true' } },
      { runs: [{ text: 'ВИДНО-ПРИ-ЗАПРЕТЕ' }], visibleWhen: { field: 'transfer', op: 'eq', value: 'deny' } }
    ],
    checkboxes: [
      { key: 'consent', label: 'Согласен с условиями', required: true, checked: false },
      { key: 'marketing', label: 'Согласен на рассылку', required: false, checked: false },
      // Обязательный, но показывается только при выборе рассылки: не должен держать «Далее»,
      // пока он скрыт, иначе клиент упирается в галочку, которой не видит.
      { key: 'marketing_channel', label: 'Подтверждаю канал рассылки', required: true, checked: false,
        visibleWhen: { field: 'marketing', op: 'eq', value: 'true' } }
    ],
    groups: [{
      key: 'transfer', title: 'Трансграничная передача', required: true,
      options: [{ key: 'allow', label: 'Разрешаю' }, { key: 'deny', label: 'Запрещаю' }]
    }]
  }],
  signBlocks: [], signBlocksBelow: []
};
let r = await put('/document', doc);
ok(r.status === 200, 'документ с именованными чекбоксами и группой сохраняется');

const saved = (await call('/document')).body;
ok((saved.pages[0].checkboxes || []).length === 3, 'чекбоксы сохранены');
ok(saved.pages[0].checkboxes[0].key === 'consent', 'имя чекбокса сохранено');
ok((saved.pages[0].groups || []).length === 1, 'группа сохранена');
ok((saved.pages[0].groups[0].options || []).length === 2, 'варианты группы сохранены');
ok(saved.pages[0].checkboxes[2].visibleWhen.field === 'marketing', 'условие на чекбоксе сохранено');

// ---------- Один вызов задаёт всё сразу ----------
const key = (await call('/apikeys', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"label":"ERP"}' })).body.key;
const enr = await post('/devices/enroll', { name: 'Планшет согласий', ttlMinutes: 30 });
const tablet = await (await browser.newContext({ viewport: { width: 900, height: 1500 } })).newPage();
const tabletErr = []; tablet.on('pageerror', e => tabletErr.push(e.message));
await tablet.goto(BASE + '/?enroll=' + enr.body.code);
await tablet.waitForSelector('#slideshow:not(.hidden)', { timeout: 10000 }).catch(() => {});
await admin.waitForTimeout(1200);
const dev = ((await call('/devices')).body).find(d => d.name === 'Планшет согласий');

const ext = (body) => admin.evaluate(async ([k, b]) => {
  const r = await fetch('/api/ext/show-document', {
    method: 'POST', headers: { 'X-Api-Key': k, 'Content-Type': 'application/json' }, body: JSON.stringify(b)
  });
  let out = null; try { out = await r.json(); } catch { out = null; }
  return { status: r.status, body: out };
}, [key, body]);

r = await ext({
  deviceId: dev.id,
  fields: { 'ФИО': 'Иванова Анна' },
  checkboxes: [{ key: 'consent', checked: true }, { key: 'marketing', checked: false }],
  groups: [{ key: 'transfer', selected: 'deny' }]
});
ok(r.status === 200, 'теги, чекбоксы и группы уходят одним вызовом');

await tablet.waitForSelector('#document:not(.hidden)', { timeout: 8000 });
await tablet.waitForTimeout(400);

const state1 = await tablet.evaluate(() => {
  const boxes = Array.from(document.querySelectorAll('#document .check'));
  return {
    text: document.querySelector('#document').textContent,
    checked: boxes.filter(b => b.querySelector('input').checked).map(b => b.textContent.trim()),
    labels: boxes.map(b => b.textContent.trim()),
    groupTitle: (document.querySelector('#document .group-title') || {}).textContent || ''
  };
});
ok(/Согласен с условиями/.test(state1.labels.join('|')), 'чекбокс из шаблона показан');
ok(state1.checked.some(t => /Согласен с условиями/.test(t)), 'API отметил именованный чекбокс');
ok(!state1.checked.some(t => /рассылку/.test(t)), 'а неотмеченный так и остался пустым');
ok(state1.labels.filter(t => /Согласен с условиями/.test(t)).length === 1,
  'именованный чекбокс не продублирован внизу страницы');
ok(/Трансграничная передача/.test(state1.groupTitle), 'группа показана с заголовком');
ok(state1.checked.some(t => /Запрещаю/.test(t)), 'API выбрал вариант в группе');
ok(!state1.checked.some(t => /Разрешаю/.test(t)), 'второй вариант не выбран');

// ---------- Условия пересчитываются по ходу ----------
ok(/ВИДНО-ПРИ-ЗАПРЕТЕ/.test(state1.text), 'блок по выбору в группе показан');
ok(!/ВИДНО-ПРИ-РАССЫЛКЕ/.test(state1.text), 'блок по неотмеченному чекбоксу скрыт');
ok(!/Подтверждаю канал/.test(state1.labels.join('|')), 'условный чекбокс пока скрыт');

// Кнопка «Далее» не должна упираться в скрытый обязательный пункт. Кнопка теперь всегда
// нажимаемая, а «ещё рано» показывается приглушённым видом, поэтому проверяем именно его.
ok(await tablet.evaluate(() => {
  const b = document.getElementById('btnNext');
  return b && !b.disabled && !b.classList.contains('btn-wait');
}), 'скрытый обязательный пункт не держит «Далее»');

// Клиент отмечает рассылку: блок и условный пункт появляются немедленно.
await tablet.locator('#document .check', { hasText: 'Согласен на рассылку' }).locator('input').check();
await tablet.waitForTimeout(300);
const state2 = await tablet.evaluate(() => ({
  text: document.querySelector('#document').textContent,
  nextWait: !!(document.getElementById('btnNext') || {}).classList.contains('btn-wait')
}));
ok(/ВИДНО-ПРИ-РАССЫЛКЕ/.test(state2.text), 'блок появился сразу после нажатия');
ok(/Подтверждаю канал/.test(state2.text), 'условный чекбокс появился');
ok(state2.nextWait, 'и теперь, когда он виден, он держит «Далее» как обязательный');
// А по нажатию система прямо показывает, чего не хватает.
await tablet.locator('#btnNext').click();
await tablet.waitForTimeout(400);
ok(await tablet.locator('.check.miss').count() >= 1, 'нажатие подсвечивает пропущенный пункт');
await tablet.locator('#document .check', { hasText: 'Подтверждаю канал' }).locator('input').check();
await tablet.waitForTimeout(300);

// Выбор в группе снимается повторным нажатием: «ни одного» это тоже состояние.
await tablet.locator('#document .check', { hasText: 'Запрещаю' }).locator('input').uncheck();
await tablet.waitForTimeout(300);
const state3 = await tablet.evaluate(() => ({
  text: document.querySelector('#document').textContent,
  anyChosen: Array.from(document.querySelectorAll('#document .group input')).some(i => i.checked)
}));
ok(!state3.anyChosen, 'повторное нажатие снимает выбор в группе');
ok(!/ВИДНО-ПРИ-ЗАПРЕТЕ/.test(state3.text), 'зависимый блок исчез вместе с выбором');

// Выбор другого варианта снимает предыдущий: одновременно двух быть не может.
await tablet.locator('#document .check', { hasText: 'Разрешаю' }).locator('input').check();
await tablet.waitForTimeout(200);
await tablet.locator('#document .check', { hasText: 'Запрещаю' }).locator('input').check();
await tablet.waitForTimeout(300);
const state4 = await tablet.evaluate(() =>
  Array.from(document.querySelectorAll('#document .group .check')).filter(b => b.querySelector('input').checked).map(b => b.textContent.trim()));
ok(state4.length === 1 && /Запрещаю/.test(state4[0]), 'в группе выбран ровно один вариант: ' + JSON.stringify(state4));

// ---------- Подпись: в запись попадает то, что клиент видел ----------
await tablet.locator('#document .check', { hasText: 'Подтверждаю канал' }).locator('input').check();
await tablet.waitForTimeout(200);
for (let i = 0; i < 6 && !(await tablet.$('#btnSign')); i++) {
  if (await tablet.$('#btnNext')) { await tablet.click('#btnNext'); await tablet.waitForTimeout(200); }
}
await tablet.waitForSelector('.sign-wrap canvas', { timeout: 8000 });
const box = await tablet.locator('.sign-wrap canvas').boundingBox();
await tablet.mouse.move(box.x + 40, box.y + 40); await tablet.mouse.down();
await tablet.mouse.move(box.x + 180, box.y + 80, { steps: 8 }); await tablet.mouse.up();
await tablet.waitForSelector('#btnSign:not([disabled])', { timeout: 5000 });
await tablet.click('#btnSign');
await tablet.waitForTimeout(2500);

const sigs = (await call('/signatures')).body;
ok(sigs.length >= 1, 'подпись сохранена');
const rec = (await call('/signatures/' + sigs[0].id)).body;
const items = rec.items || [];
const byKey = (k) => items.filter(i => i.key === k)[0];
ok(byKey('consent') && byKey('consent').checked === true, 'состояние именованного чекбокса записано по ключу');
ok(byKey('marketing') && byKey('marketing').checked === true, 'то, что клиент отметил сам, тоже записано');
ok(byKey('marketing_channel') && byKey('marketing_channel').checked === true, 'условный пункт записан, раз клиент его видел');
const groups = rec.groups || [];
ok(groups.length === 1 && groups[0].key === 'transfer', 'группа записана по ключу');
ok(groups[0].selected === 'deny', 'записан именно выбранный вариант: ' + groups[0].selected);
ok(/Запрещаю/.test(groups[0].selectedLabel || ''), 'и его текст: ' + groups[0].selectedLabel);
ok((groups[0].options || []).length === 2, 'вместе со всеми вариантами, из которых выбирали');

// ---------- В PDF попадает только то, что человек видел ----------
const docPath = SP + '/data_v3/signatures/' + sigs[0].id + '/document.json';
ok(fs.existsSync(docPath), 'документ сохранён рядом с подписью');
const stored = JSON.parse(fs.readFileSync(docPath, 'utf8'));
const storedText = JSON.stringify(stored);
ok(/ВИДНО-ПРИ-РАССЫЛКЕ/.test(storedText), 'блок, который клиент видел, попал в источник PDF');
ok(/ВИДНО-ПРИ-ЗАПРЕТЕ/.test(storedText), 'и блок по выбранному варианту тоже');
const pdf = await admin.evaluate(async (id) => {
  const r = await fetch('/api/admin/signatures/' + id + '/pdf', { credentials: 'same-origin' });
  return { status: r.status, size: r.ok ? (await r.arrayBuffer()).byteLength : 0 };
}, sigs[0].id);
ok(pdf.status === 200 && pdf.size > 1000, 'PDF сформирован: ' + JSON.stringify(pdf));

// ---------- Скрытое клиентом не попадает в PDF ----------
// Второй клиент, который рассылку не отмечает: блока быть не должно.
await post('/show-document', { target: 'device:' + dev.id, fields: {} });
await tablet.waitForSelector('#document:not(.hidden)', { timeout: 8000 });
await tablet.waitForTimeout(400);
await tablet.locator('#document .check', { hasText: 'Согласен с условиями' }).locator('input').check();
await tablet.locator('#document .check', { hasText: 'Разрешаю' }).locator('input').check();
await tablet.waitForTimeout(300);
for (let i = 0; i < 6 && !(await tablet.$('#btnSign')); i++) {
  if (await tablet.$('#btnNext')) { await tablet.click('#btnNext'); await tablet.waitForTimeout(200); }
}
await tablet.waitForSelector('.sign-wrap canvas', { timeout: 8000 });
const box2 = await tablet.locator('.sign-wrap canvas').boundingBox();
await tablet.mouse.move(box2.x + 40, box2.y + 40); await tablet.mouse.down();
await tablet.mouse.move(box2.x + 180, box2.y + 80, { steps: 8 }); await tablet.mouse.up();
await tablet.waitForSelector('#btnSign:not([disabled])', { timeout: 5000 });
await tablet.click('#btnSign');
await tablet.waitForTimeout(2500);

const sigs2 = (await call('/signatures')).body;
const second = sigs2[0].id === sigs[0].id ? sigs2[1] : sigs2[0];
const stored2 = JSON.parse(fs.readFileSync(SP + '/data_v3/signatures/' + second.id + '/document.json', 'utf8'));
const text2 = JSON.stringify(stored2);
ok(!/ВИДНО-ПРИ-РАССЫЛКЕ/.test(text2), 'блок, который второй клиент не видел, в его PDF не попал');
ok(!/ВИДНО-ПРИ-ЗАПРЕТЕ/.test(text2), 'и блок по невыбранному варианту тоже');
const rec2 = (await call('/signatures/' + second.id)).body;
ok(!(rec2.items || []).some(i => i.key === 'marketing_channel'),
  'скрытый пункт не записан как непрочитанный отказ');
ok((rec2.groups || [])[0].selected === 'allow', 'у второго клиента записан его собственный выбор');

ok(tabletErr.length === 0, 'ошибок JavaScript на планшете нет: ' + tabletErr.join(' | '));
ok(adminErr.length === 0, 'ошибок JavaScript в админке нет: ' + adminErr.join(' | '));

await browser.close();
console.log(fail === 0 ? '\nВСЁ ПРОЙДЕНО' : '\n' + fail + ' ПРОВЕРОК УПАЛО');
process.exit(fail === 0 ? 0 : 1);
