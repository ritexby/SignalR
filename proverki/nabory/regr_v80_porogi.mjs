const BASE = process.env.SK_BASE || 'http://127.0.0.1:5080';
// Пороги уведомлений: сервер приводит негодное число к границе. Оператор должен об этом узнать,
// а не уйти в уверенности, что порог у него тот, что он набрал.
import { chromium } from 'playwright';
const EXE = process.env.SK_CHROME || undefined;
let fail = 0;
const ok = (c, m, z) => { if (c) console.log('PASS ' + m); else { console.error('FAIL ' + m + (z ? ': ' + z : '')); fail++; } };

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const p = await (await browser.newContext({ viewport: { width: 1440, height: 950 } })).newPage();
p.on('pageerror', e => { console.error('FAIL ошибка в админке: ' + e.message); fail++; });
await p.goto(BASE + '/admin/');
await p.fill('#password', 'test123');
await p.click('#loginForm button[type=submit]');
await p.waitForSelector('#app:not(.hidden)', { timeout: 10000 });
await p.click('.tab[data-tab="alerts"]');
await p.waitForSelector('#alertOffline', { timeout: 10000 });

const vsplyvashka = async () => (await p.locator('.toast').innerText().catch(() => '')) || '';
async function sohranit(offline, count, window) {
  await p.evaluate(() => { const t = document.querySelector('.toast'); if (t) t.textContent = ''; });
  await p.fill('#alertOffline', String(offline));
  await p.fill('#alertErrCount', String(count));
  await p.fill('#alertErrWindow', String(window));
  await p.click('#saveAlertSettings');
  await p.waitForFunction(() => { const t = document.querySelector('.toast'); return t && t.textContent.trim().length > 0; }, null, { timeout: 10000 });
  return vsplyvashka();
}

// 1. Годные значения: обычное подтверждение, без лишнего шума.
const t1 = await sohranit(10, 5, 10);
console.log('годные: ' + t1);
ok(/сохранен/i.test(t1) && !/не годится/i.test(t1), 'годные пороги сохраняются молча', t1);

// 2. Негодное окно: 99999 минут это 69 суток, сервер берёт 1440.
const t2 = await sohranit(10, 5, 99999);
console.log('негодное окно: ' + t2);
ok(/не годится/i.test(t2) && t2.includes('99999') && t2.includes('1440'),
   'подменённое сервером окно названо оператору', t2);
ok(await p.locator('#alertErrWindow').inputValue() === '1440',
   'в поле стоит то число, с которым сторож работает на самом деле',
   await p.locator('#alertErrWindow').inputValue());

// 3. Негодный порог молчания: ноль минут звонил бы непрерывно.
const t3 = await sohranit(0, 5, 10);
console.log('нулевой порог: ' + t3);
ok(/не годится/i.test(t3) && t3.includes('0 не годится'), 'подставленный вместо нуля порог назван оператору', t3);
ok(Number(await p.locator('#alertOffline').inputValue()) >= 1, 'порог молчания не остался нулём');

// 4. Показанное в полях совпадает с тем, что лежит на сервере.
const nast = await p.evaluate(async () => await (await fetch('/api/admin/alerts/settings', { credentials: 'same-origin' })).json());
const vPolyah = {
  offlineMinutes: Number(await p.locator('#alertOffline').inputValue()),
  errorCount: Number(await p.locator('#alertErrCount').inputValue()),
  errorWindowMinutes: Number(await p.locator('#alertErrWindow').inputValue())
};
ok(nast.offlineMinutes === vPolyah.offlineMinutes && nast.errorCount === vPolyah.errorCount
   && nast.errorWindowMinutes === vPolyah.errorWindowMinutes,
   'поля показывают ровно то, что на сервере', JSON.stringify(nast) + ' против ' + JSON.stringify(vPolyah));

await browser.close();
console.log(fail ? ('ПРОВАЛОВ: ' + fail) : 'ВСЁ ПРОЙДЕНО');
process.exit(fail ? 1 : 0);
