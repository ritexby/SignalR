// Поля, которых нет в документе, не ошибка: запрос принимается. Но в подписанный документ и
// в запись они попадать не должны: человек их не видел и не подписывал, а хранить лишние
// персональные данные незачем.
import { chromium } from 'playwright';
const BASE = 'http://127.0.0.1:5080';
// Путь к браузеру берётся из окружения: на другой машине он другой, а зашитый путь
// превращал набор в неработающий у всех, кроме одной установки. Пусто значит
// «пусть Playwright возьмёт свой», как он и делает по умолчанию.
const EXE = process.env.SK_CHROME || undefined;
const SP = '' + (process.env.SK_RABOTA || '.') + '';
let fail = 0;
const ok = (c, m) => { if (c) console.log('PASS', m); else { console.error('FAIL', m); fail++; } };

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const admin = await (await browser.newContext()).newPage();
await admin.goto(BASE + '/admin/');
await admin.fill('#password', 'test123'); await admin.click('#loginForm button[type=submit]');
await admin.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
const call = (path, opts) => admin.evaluate(async ([pa, o]) => {
  const r = await fetch('/api/admin' + pa, Object.assign({ credentials: 'same-origin' }, o || {}));
  let b = null; try { b = await r.json(); } catch {} return { status: r.status, body: b };
}, [path, opts]);
const post = (path, obj) => call(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });

// Документ использует ФИО в тексте и «отделение» в условии. Всё остальное для него лишнее.
await call('/document', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
  title: 'Согласие', signPrompt: 'Распишитесь', thankYouText: 'Спасибо', idleReturnSec: 0,
  pages: [{ headingRuns: [{ text: 'Страница' }],
    blocks: [{ runs: [{ text: 'Пациент: {{ФИО}}' }], ord: 0 },
             { runs: [{ text: 'БЛОК-УРОЛОГИЯ' }], ord: 1, visibleWhen: { field: 'отделение', op: 'eq', value: 'урология' } }],
    checkboxes: [], groups: [] }],
  signBlocks: [], signBlocksBelow: [] }) });

const code = (await post('/devices/enroll', { name: 'Планшет' })).body.code;
const kiosk = await (await browser.newContext()).newPage();
await kiosk.goto(BASE + '/?enroll=' + encodeURIComponent(code));
await kiosk.waitForFunction(() => !!localStorage.getItem('sk_device_token'), { timeout: 12000 });
let deviceId = null;
for (let i = 0; i < 40; i++) {
  const d = (await call('/devices')).body || [];
  const on = d.find(x => x.online); if (on) { deviceId = on.id; break; }
  await kiosk.waitForTimeout(250);
}

// Шлём и нужные поля, и служебные, которых в документе нет.
const r = await post('/show-document', { target: 'device:' + deviceId, fields: {
  'ФИО': 'Иванова Анна', 'отделение': 'урология',
  'orderId': 'ORD-99887', 'внутреннийКомментарий': 'звонить после 18', 'lab_system_id': 'X-42'
} });
ok(r.status === 200, 'запрос с лишними полями принят, а не отклонён: ' + r.status);
ok((r.body.missingPlaceholders || []).length === 0, 'незаполненных тегов нет');

await kiosk.waitForSelector('.doc-body', { timeout: 8000 });
const наЭкране = await kiosk.evaluate(() => document.querySelector('.doc-body').textContent);
ok(/Иванова Анна/.test(наЭкране), 'нужное поле подставилось');
ok(/БЛОК-УРОЛОГИЯ/.test(наЭкране), 'условие на своём поле сработало');
ok(!/ORD-99887/.test(наЭкране) && !/звонить после 18/.test(наЭкране),
  'служебные поля на экран клиента не попали');

// Подписываем.
await kiosk.click('.doc-footer button:last-child');
await kiosk.waitForSelector('canvas', { timeout: 8000 });
const box = await kiosk.locator('.sign-wrap').boundingBox();
await kiosk.mouse.move(box.x + 30, box.y + box.height / 2);
await kiosk.mouse.down();
await kiosk.mouse.move(box.x + box.width - 40, box.y + box.height / 2 - 20, { steps: 10 });
await kiosk.mouse.up();
await kiosk.waitForTimeout(300);
await kiosk.evaluate(() => { const b = document.getElementById('btnSign'); if (b && !b.disabled) b.click(); });
await kiosk.waitForTimeout(2000);

const sigs = (await call('/signatures')).body || [];
ok(sigs.length === 1, 'подпись сохранена');
const rec = (await call('/signatures/' + sigs[0].id)).body;
const поля = Object.keys(rec.fields || {});
ok(поля.indexOf('ФИО') >= 0 && поля.indexOf('отделение') >= 0, 'использованные поля в записи есть: ' + JSON.stringify(поля));
ok(поля.indexOf('orderId') < 0 && поля.indexOf('lab_system_id') < 0 && поля.indexOf('внутреннийКомментарий') < 0,
  'служебных полей в записи нет: ' + JSON.stringify(поля));

// И в PDF их тоже нет.
const bytes = await admin.evaluate(async (sid) => {
  const res = await fetch('/api/admin/signatures/' + sid + '/pdf', { credentials: 'same-origin' });
  return Array.from(new Uint8Array(await res.arrayBuffer()));
}, sigs[0].id);
const fs = await import('fs');
fs.writeFileSync(SP + '/extra.pdf', Buffer.from(bytes));
const { execSync } = await import('child_process');
const текстPdf = execSync('pdftotext -layout ' + SP + '/extra.pdf -').toString();
ok(/Иванова Анна/.test(текстPdf), 'в PDF есть данные подписанта');
ok(!/ORD-99887/.test(текстPdf) && !/lab_system_id/.test(текстPdf) && !/звонить после 18/.test(текстPdf),
  'служебных полей в PDF нет');

await browser.close();
console.log(fail === 0 ? '\nВСЁ ПРОЙДЕНО' : '\n' + fail + ' ПРОВЕРОК УПАЛО');
process.exit(fail === 0 ? 0 : 1);
