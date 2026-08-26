// Отправка документа на планшет, которого нет на связи. Документ не теряется, он появится при
// подключении. Но сказать об этом надо прямо: сообщение «документ показан» отправляло оператора
// смотреть на экран, где ничего не менялось, и он искал поломку там, где её нет.
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
const p = await (await browser.newContext({ viewport: { width: 1500, height: 1100 } })).newPage();
const jsErr = []; p.on('pageerror', e => jsErr.push(e.message));
p.on('dialog', d => d.accept());
await p.goto(BASE + '/admin/');
await p.fill('#password', 'test123'); await p.click('#loginForm button[type=submit]');
await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
await отказатьсяОтЧерновика(p);
const call = (path, opts) => p.evaluate(async ([pa, o]) => {
  const r = await fetch('/api/admin' + pa, Object.assign({ credentials: 'same-origin' }, o || {}));
  let b = null; try { b = await r.json(); } catch {} return { status: r.status, body: b };
}, [path, opts]);

await call('/document', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
  title: 'Согласие', signPrompt: 'Распишитесь', thankYouText: 'Спасибо', idleReturnSec: 0,
  pages: [{ headingRuns: [{ text: 'Данные' }], blocks: [{ runs: [{ text: 'Пациент: {{ФИО}}' }], ord: 0 }], checkboxes: [], groups: [] }],
  signBlocks: [], signBlocksBelow: [] }) });

// Планшет заведён, поработал и ушёл со связи.
const code = (await call('/devices/enroll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"name":"Выключенный"}' })).body.code;
const ctx = await browser.newContext();
const kiosk = await ctx.newPage();
await kiosk.goto(BASE + '/?enroll=' + encodeURIComponent(code));
await kiosk.waitForFunction(() => !!localStorage.getItem('sk_device_token'), { timeout: 12000 });
const token = await kiosk.evaluate(() => localStorage.getItem('sk_device_token'));
let deviceId = null;
for (let i = 0; i < 40; i++) {
  const d = (await call('/devices')).body || [];
  const on = d.find(x => x.online); if (on) { deviceId = on.id; break; }
  await kiosk.waitForTimeout(250);
}
ok(!!deviceId, 'планшет был на связи');
await ctx.close();
for (let i = 0; i < 40; i++) {
  const d = (await call('/devices')).body || [];
  if (d.length && !d[0].online) break;
  await p.waitForTimeout(250);
}
ok(((await call('/devices')).body || [])[0].online === false, 'и ушёл со связи');

await p.reload(); await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
await отказатьсяОтЧерновика(p);
await p.click('.tab[data-tab="document"]');
await p.waitForTimeout(700);

// В списке адресатов офлайн помечен, и это видно до открытия окна.
const подпись = await p.locator('#docTarget option').first().textContent();
ok(/офлайн/.test(подпись), 'в списке планшет помечен как офлайн: ' + подпись);

await p.click('#showDocument');
await p.waitForSelector('.modal .field', { timeout: 6000 });
ok(await p.locator('.modal .note-warn').count() === 1, 'в окне сказано, что планшет не на связи');
const предупреждение = await p.locator('.modal .note-warn').textContent();
ok(/появится/.test(предупреждение), 'и объяснено, что будет дальше: ' + предупреждение.slice(0, 70));

await p.locator('.modal button', { hasText: 'Заполнить примером' }).click();
await p.waitForTimeout(300);
await p.locator('.modal button', { hasText: 'Отправить на планшет' }).last().click();
await p.waitForTimeout(1200);
const сообщение = await p.evaluate(() => (document.querySelector('.toast') || {}).textContent || '');
ok(/не на связи/.test(сообщение), 'сообщение говорит правду, а не «документ показан»: ' + сообщение);
ok(!/^Документ показан/.test(сообщение), 'старой формулировки нет');

// Документ не потерян: планшет получает его при подключении.
const ctx2 = await browser.newContext();
const kiosk2 = await ctx2.newPage();
await kiosk2.goto(BASE + '/');
await kiosk2.evaluate(t => localStorage.setItem('sk_device_token', t), token);
await kiosk2.reload();
await kiosk2.waitForSelector('.doc-body', { timeout: 12000 });
const текст = await kiosk2.evaluate(() => document.querySelector('.doc-body').textContent);
ok(/Иванова Анна/.test(текст), 'при подключении документ появился с данными: ' + текст.slice(0, 50));

// А для планшета на связи сообщение прежнее.
await p.reload(); await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
await отказатьсяОтЧерновика(p);
await p.click('.tab[data-tab="document"]');
await p.waitForTimeout(700);
await p.click('#showDocument');
await p.waitForSelector('.modal .field', { timeout: 6000 });
ok(await p.locator('.modal .note-warn').count() === 0, 'для планшета на связи предупреждения нет');
await p.locator('.modal button', { hasText: 'Отправить на планшет' }).last().click();
await p.waitForTimeout(1200);
ok(/Документ показан/.test(await p.evaluate(() => (document.querySelector('.toast') || {}).textContent || '')),
  'и сообщение обычное');

ok(jsErr.length === 0, 'ошибок JavaScript нет: ' + jsErr.join(' | '));
await browser.close();
console.log(fail === 0 ? '\nВСЁ ПРОЙДЕНО' : '\n' + fail + ' ПРОВЕРОК УПАЛО');
process.exit(fail === 0 ? 0 : 1);
