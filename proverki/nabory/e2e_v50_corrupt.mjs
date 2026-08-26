// Повреждённый файл данных не должен молча превращаться в пустой: следующая запись затёрла бы
// его навсегда. Он откладывается в сторону, а оператор узнаёт об этом из лога и уведомлений.
import { chromium } from 'playwright';
import fs from 'fs';
const BASE = 'http://127.0.0.1:5080';
// Путь к браузеру берётся из окружения: на другой машине он другой, а зашитый путь
// превращал набор в неработающий у всех, кроме одной установки. Пусто значит
// «пусть Playwright возьмёт свой», как он и делает по умолчанию.
const EXE = process.env.SK_CHROME || undefined;
const DATA = '' + (process.env.SK_RABOTA || '.') + '/data_v3';
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

// Создаём рабочее место, чтобы в файле было что терять.
await call('/workstations', { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ externalId: 'WS-1', name: 'Стойка' }) });
ok(((await call('/workstations')).body || []).length === 1, 'рабочее место сохранено');

// Портим файл так, как это сделала бы поломка диска или правка руками.
fs.writeFileSync(DATA + '/workstations.json', '{ это не json');
const listAfter = (await call('/workstations')).body;
ok(Array.isArray(listAfter) && listAfter.length === 0, 'повреждённый файл читается как пустой, сервис работает');

// Главное: оригинал не потерян и его не затрёт следующая запись.
const backups = fs.readdirSync(DATA).filter(f => f.startsWith('workstations.json.corrupt-'));
ok(backups.length === 1, 'повреждённый файл отложен в сторону: ' + JSON.stringify(backups));
ok(fs.readFileSync(DATA + '/' + backups[0], 'utf8').indexOf('это не json') >= 0,
  'в отложенном файле именно то, что было');

// Следующая запись создаёт новый файл и отложенный не трогает.
await call('/workstations', { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ externalId: 'WS-2', name: 'Новая стойка' }) });
ok(fs.existsSync(DATA + '/' + backups[0]), 'отложенный файл на месте после новой записи');

// Оператор об этом узнаёт.
const logs = (await call('/logs?q=workstations')).body;
const entries = (logs && logs.entries) || [];
ok(entries.some(e => e.level === 'error' && /повреждён/.test(e.message)),
  'в логе есть запись об этом: ' + JSON.stringify(entries.map(e => e.message).slice(0, 2)));

await browser.close();
console.log(fail === 0 ? '\nВСЁ ПРОЙДЕНО' : '\n' + fail + ' ПРОВЕРОК УПАЛО');
process.exit(fail === 0 ? 0 : 1);
