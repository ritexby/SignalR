// Библиотека документов: несколько документов, адресуемых кодом. Проверяется и главное правило:
// неизвестный код отказывает громко, а не подставляет молча документ по умолчанию.
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
const del = (path) => call(path, { method: 'DELETE' });

// ---------- 1. Библиотека заводится сама из существующего документа ----------
let список = (await call('/documents')).body;
ok(Array.isArray(список) && список.length === 1, 'библиотека завелась из единственного документа: ' + JSON.stringify(список));
ok(список[0].isDefault === true, 'он и стал документом по умолчанию');
const главный = список[0];

await put('/document', {
  title: 'СОГЛАСИЕ', signPrompt: 'Подпись', thankYouText: 'Спасибо', idleReturnSec: 0,
  pages: [{ headingRuns: [{ text: 'Согласие' }], blocks: [{ runs: [{ text: 'ТЕКСТ СОГЛАСИЯ' }], ord: 0 }], checkboxes: [], includeDynamic: false }]
});

// ---------- 2. Второй документ ----------
const создан = await post('/documents', { code: 'DOGOVOR', name: 'Договор услуг' });
ok(создан.status === 200 && создан.body.code === 'DOGOVOR', 'второй документ заведён: ' + JSON.stringify(создан.body));
const договор = создан.body;
ok(договор.isDefault === false, 'и он не стал документом по умолчанию');

ok((await put('/document?id=' + договор.id, {
  title: 'ДОГОВОР', signPrompt: 'Подпись', thankYouText: 'Спасибо', idleReturnSec: 0,
  pages: [{ headingRuns: [{ text: 'Договор' }], blocks: [{ runs: [{ text: 'ТЕКСТ ДОГОВОРА' }], ord: 0 }], checkboxes: [], includeDynamic: false }]
})).status === 200, 'текст второго документа сохранён');

// Каждый читается сам по себе.
ok(/ТЕКСТ СОГЛАСИЯ/.test(JSON.stringify((await call('/document')).body)), 'документ по умолчанию читается без указания');
ok(/ТЕКСТ ДОГОВОРА/.test(JSON.stringify((await call('/document?id=' + договор.id)).body)), 'второй читается по идентификатору');
ok(!/ТЕКСТ ДОГОВОРА/.test(JSON.stringify((await call('/document')).body)), 'и они не путаются между собой');

// ---------- 3. Коды: обязательный, уникальный ----------
ok((await post('/documents', { code: '', name: 'Без кода' })).status === 400, 'документ без кода не заводится');
const занят = await post('/documents', { code: 'dogovor', name: 'Ещё один' });
ok(занят.status === 400 && /занят/.test((занят.body || {}).error || ''),
  'код занят, регистр при этом не важен: ' + JSON.stringify(занят.body));

// ---------- 4. Показ по коду ----------
const enr = (await post('/devices/enroll', { name: 'Планшет библиотеки', ttlMinutes: 30 })).body;
const tok = await admin.evaluate(async (code) => (await fetch('/api/kiosk/enroll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) })).json(), enr.code);
const kiosk = await (await browser.newContext({ viewport: { width: 900, height: 1400 } })).newPage();
kiosk.on('pageerror', e => { console.error('FAIL ошибка на планшете: ' + e.message); fail++; });
await kiosk.goto(BASE + '/');
await kiosk.evaluate(t => localStorage.setItem('sk_device_token', t), tok.token);
await kiosk.reload();
await kiosk.waitForTimeout(1500);

ok((await post('/show-document', { target: 'device:' + tok.deviceId, fields: {} })).status === 200, 'показ без кода принят');
await kiosk.waitForSelector('text=ТЕКСТ СОГЛАСИЯ', { timeout: 8000 });
ok(true, 'без кода показан документ по умолчанию');

ok((await post('/show-document', { target: 'device:' + tok.deviceId, fields: {}, documentCode: 'DOGOVOR' })).status === 200, 'показ по коду принят');
await kiosk.waitForSelector('text=ТЕКСТ ДОГОВОРА', { timeout: 8000 });
ok(true, 'по коду показан именно второй документ');

// ---------- 5. Главное правило: неизвестный код отказывает громко ----------
const чужой = await post('/show-document', { target: 'device:' + tok.deviceId, fields: {}, documentCode: 'ОПЕЧАТКА' });
ok(чужой.status === 400 && /не найден/.test((чужой.body || {}).error || ''),
  'неизвестный код отклонён с объяснением: ' + JSON.stringify(чужой.body));
ok(/DOGOVOR/.test((чужой.body || {}).error || ''), 'и в отказе перечислены доступные коды');
await kiosk.waitForTimeout(500);
ok(/ТЕКСТ ДОГОВОРА/.test(await kiosk.textContent('#document')),
  'на планшете при этом ничего не подменилось: молчаливой подстановки нет');

// ---------- 6. Внешнее API ----------
const key = (await post('/apikeys', { label: 'библиотека' })).body.key;
const ws = (await post('/workstations', { externalId: 'WS-LIB', name: 'Место', location: '' })).body;
await call('/devices/' + tok.deviceId, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Планшет библиотеки', workstationId: ws.id }) });
const внешний = await admin.request.post(BASE + '/api/ext/show-document', {
  headers: { 'X-Api-Key': key, 'Content-Type': 'application/json' },
  data: JSON.stringify({ workstationExternalId: 'WS-LIB', documentCode: 'DOGOVOR', fields: {} })
});
ok(внешний.status() === 200, 'внешняя система показала документ по коду: ' + внешний.status());
const списокВнешний = await admin.request.get(BASE + '/api/ext/documents', { headers: { 'X-Api-Key': key } });
const коды = await списокВнешний.json();
ok(списокВнешний.status() === 200 && коды.some(d => d.code === 'DOGOVOR'),
  'внешняя система видит список кодов: ' + JSON.stringify(коды));

// ---------- 7. Запись подписи помнит документ ----------
await post('/show-document', { target: 'device:' + tok.deviceId, fields: {}, documentCode: 'DOGOVOR' });
await kiosk.waitForSelector('text=ТЕКСТ ДОГОВОРА', { timeout: 8000 });
for (let шаг = 0; шаг < 8; шаг++) {
  if (await kiosk.$('#btnSign')) {
    const box = await kiosk.locator('#document canvas').boundingBox();
    await kiosk.mouse.move(box.x + 40, box.y + 40); await kiosk.mouse.down();
    await kiosk.mouse.move(box.x + 200, box.y + 80, { steps: 8 }); await kiosk.mouse.up();
    await kiosk.waitForSelector('#btnSign:not([disabled])', { timeout: 3000 });
    await kiosk.click('#btnSign'); break;
  } else if (await kiosk.$('#btnNext')) {
    await kiosk.waitForSelector('#btnNext:not([disabled])', { timeout: 3000 });
    await kiosk.click('#btnNext'); await kiosk.waitForTimeout(120);
  } else break;
}
await kiosk.waitForSelector('#document .thankyou', { timeout: 8000 });
await admin.waitForTimeout(700);
const записи = (await call('/signatures')).body;
ok(записи[0] && записи[0].documentCode === 'DOGOVOR',
  'в записи подписи сохранён код документа: ' + JSON.stringify({ код: записи[0] && записи[0].documentCode, имя: записи[0] && записи[0].documentName }));

// ---------- 8. Документ по умолчанию переставляется ----------
ok((await post('/documents/' + договор.id + '/default', {})).status === 200, 'второй документ назначен по умолчанию');
список = (await call('/documents')).body;
ok(список.find(d => d.id === договор.id).isDefault === true, 'признак переставлен');
ok(список.find(d => d.id === главный.id).isDefault === false, 'у прежнего снят');
ok(/ТЕКСТ ДОГОВОРА/.test(JSON.stringify((await call('/document')).body)), 'без указания теперь читается договор');
ok(/ТЕКСТ СОГЛАСИЯ/.test(JSON.stringify((await call('/document?id=' + главный.id)).body)),
  'а прежний документ по умолчанию цел и читается по идентификатору');

// ---------- 9. Удаление ----------
const нельзя = await del('/documents/' + договор.id);
ok(нельзя.status === 400 && /по умолчанию/.test((нельзя.body || {}).error || ''),
  'документ по умолчанию не удаляется: ' + JSON.stringify(нельзя.body));
ok((await del('/documents/' + главный.id)).status === 200, 'обычный документ удаляется');
ok(((await call('/documents')).body || []).length === 1, 'в библиотеке остался один');

// ---------- 10. Копия ----------
const копия = await post('/documents', { code: 'KOPIYA', name: 'Копия договора', copyOfId: договор.id });
ok(копия.status === 200, 'копия заведена');
ok(/ТЕКСТ ДОГОВОРА/.test(JSON.stringify((await call('/document?id=' + копия.body.id)).body)),
  'копия начинается с текста исходного документа, а не с пустого листа');

await browser.close();
if (fail === 0) console.log('\nВСЁ ПРОЙДЕНО');
process.exit(fail ? 1 : 0);
