// Лог оператора должен содержать только то, с чем оператор может что-то сделать. Служебные
// предупреждения платформы (ключи защиты данных, внутренности Kestrel) туда попадать не должны:
// они выглядят как поломка, ничего не требуют и прячут под собой настоящие сбои.
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

const entries = ((await call('/logs')).body || {}).entries || [];
const текст = entries.map(e => e.source + ': ' + e.message).join(' | ');
ok(!/XmlKeyManager|XmlRepository|No XML encryptor|ephemeral key/i.test(текст),
  'служебных предупреждений о ключах в логе нет: ' + текст.slice(0, 200));
ok(entries.some(e => /Сервис запущен/.test(e.message)), 'запуск сервиса в логе есть');
ok(entries.every(e => e.level !== 'предупреждение'), 'уровни записаны как ожидается');

// Ключи защиты данных теперь лежат на диске, а не только в памяти.
ok(fs.existsSync(DATA + '/keys'), 'каталог ключей создан рядом с данными');

// Настоящая ошибка платформы (уровень «ошибка») в лог по-прежнему попадает: планшет о своей
// ошибке сообщает сам, и это тот случай, ради которого вкладка существует.
const code = (await call('/devices/enroll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"name":"Т"}' })).body.code;
const kiosk = await (await browser.newContext()).newPage();
await kiosk.goto(BASE + '/?enroll=' + encodeURIComponent(code));
await kiosk.waitForFunction(() => !!localStorage.getItem('sk_device_token'), { timeout: 12000 });
await kiosk.evaluate(async () => {
  const t = localStorage.getItem('sk_device_token');
  await fetch('/api/log', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t },
    body: JSON.stringify({ level: 'error', message: 'ТЕСТОВАЯ ОШИБКА ПЛАНШЕТА' }) });
});
await p.waitForTimeout(400);
const after = ((await call('/logs')).body || {}).entries || [];
ok(after.some(e => /ТЕСТОВАЯ ОШИБКА ПЛАНШЕТА/.test(e.message) && e.level === 'error'),
  'ошибка планшета в логе есть');

await browser.close();
console.log(fail === 0 ? '\nВСЁ ПРОЙДЕНО' : '\n' + fail + ' ПРОВЕРОК УПАЛО');
process.exit(fail === 0 ? 0 : 1);
