// Документация API в админке должна описывать ровно то, что делает сервер. Расхождение здесь
// вводит интегратора в заблуждение напрямую: он пишет код по описанию, а получает другое.
import { chromium } from 'playwright';
const BASE = 'http://127.0.0.1:5080';
// Путь к браузеру берётся из окружения: на другой машине он другой, а зашитый путь
// превращал набор в неработающий у всех, кроме одной установки. Пусто значит
// «пусть Playwright возьмёт свой», как он и делает по умолчанию.
const EXE = process.env.SK_CHROME || undefined;
let fail = 0;
const ok = (c, m) => { if (c) console.log('PASS', m); else { console.error('FAIL', m); fail++; } };

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const p = await (await browser.newContext({ viewport: { width: 1400, height: 1000 } })).newPage();
await p.goto(BASE + '/admin/');
await p.fill('#password', 'test123'); await p.click('#loginForm button[type=submit]');
await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
await p.click('.tab[data-tab="apidocs"]');
await p.waitForTimeout(600);

const key = await p.evaluate(async () => {
  const r = await fetch('/api/admin/apikeys', { method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' }, body: '{"label":"Проверка"}' });
  return (await r.json()).key;
});
const ext = (path, body, method) => p.evaluate(async ([k, pa, b, m]) => {
  const init = { method: m || 'POST', headers: { 'X-Api-Key': k } };
  if (init.method !== 'GET') { init.headers['Content-Type'] = 'application/json'; init.body = b; }
  const r = await fetch(pa, init);
  let out = null; try { out = await r.json(); } catch {}
  return { status: r.status, body: out };
}, [key, path, body, method]);

// Каждый описанный путь должен существовать: несуществующий даёт 404 от маршрутизации.
const paths = await p.evaluate(() => Array.from(document.querySelectorAll('.api-path, .ep-path, code'))
  .map(e => e.textContent.trim())
  .filter(t => /^\/api\/ext\/[a-z-]+(\/|$)/.test(t) && t.indexOf('{') < 0 && t.indexOf('*') < 0));
const уникальные = [...new Set(paths)];
ok(уникальные.length >= 7, 'в документации перечислены методы: ' + JSON.stringify(уникальные));
for (const path of уникальные) {
  const метод = /devices$|workstations$|scans$/.test(path) ? 'GET' : 'POST';
  const r = await ext(path, '{}', метод);
  ok(r.status !== 404, метод + ' ' + path + ': маршрут существует (' + r.status + ')');
}

// Обещания из описания должны выполняться.
const текст = await p.evaluate(() => document.querySelector('[data-panel="apidocs"]').innerText);
ok(/без учёта регистра/.test(текст), 'сказано про регистр имён тегов');
ok(/groups/.test(текст) && /выбранного варианта/.test(текст), 'массив groups объяснён, а не только показан в примере');
ok(/409/.test(текст), 'про 409 сказано');

// Обещание «не на связи - сразу 409» проверяем на живом сервере.
const en = await p.evaluate(async () => {
  const r = await fetch('/api/admin/devices/enroll', { method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' }, body: '{"name":"Выключенный"}' });
  return await r.json();
});
const kiosk = await (await browser.newContext()).newPage();
await kiosk.goto(BASE + '/?enroll=' + encodeURIComponent(en.code));
await kiosk.waitForFunction(() => !!localStorage.getItem('sk_device_token'), { timeout: 12000 });
const id = await kiosk.evaluate(() => localStorage.getItem('sk_device_token').split('.')[0]);
await kiosk.context().close();
await p.waitForTimeout(1500);

const started = Date.now();
const scan = await ext('/api/ext/scan-request', JSON.stringify({ deviceId: id, timeoutSec: 60 }));
const прошло = Date.now() - started;
ok(scan.status === 409, 'выключенный планшет даёт 409, а не ожидание: ' + scan.status);
ok(прошло < 5000, 'и отвечает сразу, а не через минуту: ' + прошло + ' мс');
ok(/не на связи/.test((scan.body || {}).error || ''), 'с понятной причиной: ' + (scan.body || {}).error);

// Обещание про несколько планшетов на одном месте.
const ws = await p.evaluate(async () => {
  const r = await fetch('/api/admin/workstations', { method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' }, body: '{"externalId":"WS-9","name":"Общее место"}' });
  return await r.json();
});
for (const имя of ['Первый', 'Второй']) {
  const e = await p.evaluate(async ([n, w]) => {
    const r = await fetch('/api/admin/devices/enroll', { method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: n, workstationId: w }) });
    return await r.json();
  }, [имя, ws.id]);
  const k = await (await browser.newContext()).newPage();
  await k.goto(BASE + '/?enroll=' + encodeURIComponent(e.code));
  await k.waitForFunction(() => !!localStorage.getItem('sk_device_token'), { timeout: 12000 });
  await k.context().close();
}
const конфликт = await ext('/api/ext/show-document', JSON.stringify({ workstationExternalId: 'WS-9', fields: {} }));
ok(конфликт.status === 409, 'два планшета на месте: сервер отказывается выбирать сам (' + конфликт.status + ')');

await browser.close();
console.log(fail === 0 ? '\nВСЁ ПРОЙДЕНО' : '\n' + fail + ' ПРОВЕРОК УПАЛО');
process.exit(fail === 0 ? 0 : 1);
