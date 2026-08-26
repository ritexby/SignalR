import { chromium } from 'playwright';

const BASE = 'http://127.0.0.1:5080';
// Путь к браузеру берётся из окружения: на другой машине он другой, а зашитый путь
// превращал набор в неработающий у всех, кроме одной установки. Пусто значит
// «пусть Playwright возьмёт свой», как он и делает по умолчанию.
const EXE = process.env.SK_CHROME || undefined;
let fail = 0;
const ok = (c, m) => { if (c) console.log('PASS', m); else { console.error('FAIL', m); fail++; } };

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const ctx = await browser.newContext();
const p = await ctx.newPage();
const jsErrors = [];
p.on('pageerror', e => jsErrors.push(e.message));

await p.goto(BASE + '/admin/');
await p.fill('#password', 'test123');
await p.click('#loginForm button[type=submit]');
await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
ok(true, 'admin logged in');

// two independent target selectors exist and are populated
await p.waitForTimeout(500);
const slidesOpts = await p.evaluate(() => document.getElementById('slidesTarget').options.length);
const docOpts = await p.evaluate(() => document.getElementById('docTarget').options.length);
ok(slidesOpts >= 1, 'slidesTarget populated (' + slidesOpts + ' options)');
ok(docOpts >= 1, 'docTarget populated (' + docOpts + ' options)');
ok(await p.evaluate(() => !Array.from(document.getElementById('docTarget').options).some(o => o.value === 'all')),
  'docTarget has no "all" option (document is single-tablet)');
ok(await p.evaluate(() => !document.getElementById('targetSelect')), 'old shared topbar target removed');

// API docs tab
await p.click('.tab[data-tab="apidocs"]');
await p.waitForSelector('[data-panel="apidocs"]:not(.hidden)', { timeout: 4000 });
const epCount = await p.evaluate(() => document.querySelectorAll('#apiDocsList .api-ep').length);
ok(epCount >= 10, 'API docs lists the endpoints (' + epCount + ')');
const baseShown = await p.textContent('#apiBaseUrl');
ok(baseShown && baseShown.includes('127.0.0.1:5080'), 'API base URL filled: ' + baseShown);

// Document editor: placeholder helper + idle field render without error
await p.click('.tab[data-tab="document"]');
await p.waitForSelector('[data-panel="document"]:not(.hidden)', { timeout: 4000 });
await p.waitForTimeout(200);
ok(await p.$('#docPlaceholders') !== null, 'document editor has placeholder helper');
ok(await p.$('#idleReturn') !== null, 'document editor has idle-timeout field');

// Планшет заводится самой проверкой: раньше набор рассчитывал на уже населённую систему и
// на чистых данных ругался на пустой список.
{
  const post = (path, body) => p.evaluate(async ([pa, b]) => {
    const r = await fetch('/api/admin' + pa, { method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
    let j = null; try { j = await r.json(); } catch {}
    return j;
  }, [path, body]);

  // Рабочее место, группа и привязанный к ним планшет: карточка должна показывать всё это.
  await post('/workstations', { name: 'Ресепшн 1', externalId: 'WS-204', location: 'Первый этаж, у входа' });
  await post('/groups', { name: 'Первый этаж' });
  const заведён = async (name) => {
    const j = await post('/devices/enroll', { name: name });
    const kiosk = await browser.newPage();
    await kiosk.goto(BASE + '/?enroll=' + encodeURIComponent(j.code));
    await kiosk.waitForFunction(() => !!localStorage.getItem('sk_device_token'), { timeout: 12000 });
    return kiosk;
  };
  await заведён('Планшет для проверки');
  const второй = await заведён('Отозванный планшет');

  const devices = await p.evaluate(async () => {
    const r = await fetch('/api/admin/devices', { credentials: 'same-origin' });
    return await r.json();
  });
  const ws = (await p.evaluate(async () => {
    const r = await fetch('/api/admin/workstations', { credentials: 'same-origin' });
    return await r.json();
  }))[0];
  const gr = (await p.evaluate(async () => {
    const r = await fetch('/api/admin/groups', { credentials: 'same-origin' });
    return await r.json();
  }))[0];
  const первый = devices.find(d => d.name === 'Планшет для проверки');
  const отозвать = devices.find(d => d.name === 'Отозванный планшет');
  await p.evaluate(async ([id, wsId, grId]) => {
    await fetch('/api/admin/devices/' + id, { method: 'PUT', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Планшет для проверки', workstationId: wsId, groupIds: [grId] }) });
  }, [первый.id, ws.id, gr.id]);
  await p.evaluate(async (id) => {
    await fetch('/api/admin/devices/' + id + '/revoke', { method: 'POST', credentials: 'same-origin' });
  }, отозвать.id);
  await второй.close();
  // Список планшетов админка держит в памяти: после правок через API её надо перечитать,
  // иначе карточка покажет состояние до привязки.
  await p.reload();
  await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
  await p.waitForTimeout(600);
}

// Devices tab + filters
await p.click('.tab[data-tab="devices"]');
await p.waitForSelector('[data-panel="devices"]:not(.hidden)', { timeout: 4000 });
await p.waitForTimeout(400);
const totalDevices = await p.evaluate(() => document.querySelectorAll('#devicesList .dev-item').length);
ok(totalDevices >= 1, 'devices rendered (' + totalDevices + ')');
const countText = await p.textContent('#devFilterCount');
ok(countText && countText.indexOf('Показано') === 0, 'filter count shown: ' + countText);

// device card shows workstation name + external ID + description, and the group
const cardText = await p.evaluate(() => {
  const n = Array.from(document.querySelectorAll('#devicesList .dev-item'))
    .find(x => x.textContent.includes('Планшет для проверки'));
  return n ? n.textContent : '';
});
ok(cardText.includes('Ресепшн 1'), 'card shows workstation name');
ok(cardText.includes('код для API: WS-204'), 'card shows workstation external ID');
ok(cardText.includes('описание: Первый этаж, у входа'), 'card shows workstation description');
ok(cardText.includes('Группа: Первый этаж'), 'card shows group');

// search that matches nothing hides all
await p.fill('#devSearch', 'zzz-nomatch-xyz');
await p.waitForTimeout(200);
const afterSearch = await p.evaluate(() => document.querySelectorAll('#devicesList .dev-item').length);
ok(afterSearch === 0, 'search filter hides non-matching devices');
const emptyNote = await p.$('#devicesList .empty-note');
ok(!!emptyNote, 'empty-note shown when filter matches nothing');

// reset restores
await p.click('#devFilterReset');
await p.waitForTimeout(200);
const afterReset = await p.evaluate(() => document.querySelectorAll('#devicesList .dev-item').length);
ok(afterReset === totalDevices, 'reset restores full device list');

// status filter: "revoked" (the E2E revoked one device)
await p.selectOption('#devStatusFilter', 'revoked');
await p.waitForTimeout(200);
const revokedShown = await p.evaluate(() => document.querySelectorAll('#devicesList .dev-item.revoked').length);
ok(revokedShown >= 1, 'status filter shows revoked device(s): ' + revokedShown);

ok(jsErrors.length === 0, 'no admin JS errors (' + JSON.stringify(jsErrors) + ')');

await browser.close();
console.log(fail === 0 ? '\nADMIN UI SMOKE PASSED' : `\n${fail} ADMIN UI CHECK(S) FAILED`);
process.exit(fail === 0 ? 0 : 1);
