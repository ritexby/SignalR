// Предпросмотр должен уметь всё, что приходит по API: теги, состояние именованных чекбоксов и
// выбор в двойных зависимых чекбоксах. И должен уметь отправить ровно эти данные на планшет,
// чтобы проверить документ на живом экране.
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
const p = await (await browser.newContext({ viewport: { width: 1500, height: 1200 } })).newPage();
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
  pages: [{ headingRuns: [{ text: 'Данные' }],
    blocks: [{ runs: [{ text: 'Пациент: {{ФИО}}' }], ord: 0 },
             { runs: [{ text: 'БЛОК-ПРИ-СМС' }], ord: 3, visibleWhen: { field: 'sms', op: 'eq', value: 'true' } },
             { runs: [{ text: 'БЛОК-ПРИ-ЗАПРЕТЕ' }], ord: 4, visibleWhen: { field: 'transfer', op: 'eq', value: 'deny' } }],
    checkboxes: [{ key: 'sms', label: 'Согласен на СМС', required: false, ord: 1 }],
    groups: [{ key: 'transfer', title: 'Передача данных', required: false, ord: 2,
      options: [{ key: 'allow', label: 'Разрешаю' }, { key: 'deny', label: 'Запрещаю' }] }] }],
  signBlocks: [], signBlocksBelow: [] }) });

const code = (await call('/devices/enroll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"name":"Проверочный"}' })).body.code;
const kiosk = await (await browser.newContext()).newPage();
await kiosk.goto(BASE + '/?enroll=' + encodeURIComponent(code));
await kiosk.waitForFunction(() => !!localStorage.getItem('sk_device_token'), { timeout: 12000 });
let deviceId = null;
for (let i = 0; i < 40; i++) {
  const d = (await call('/devices')).body || [];
  const on = d.find(x => x.online); if (on) { deviceId = on.id; break; }
  await kiosk.waitForTimeout(250);
}
await p.reload(); await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
await отказатьсяОтЧерновика(p);
await p.click('.tab[data-tab="document"]');
await p.waitForSelector('[data-role="itemlist"]', { timeout: 5000 });
await p.click('#previewDoc');
await p.waitForSelector('.preview-setup', { timeout: 5000 });

// Всё, что приходит по API, должно быть в окне.
ok(await p.locator('.preview-setup input[data-check="sms"]').count() === 1, 'именованный чекбокс документа есть в окне');
ok(await p.locator('.preview-setup select[data-group="transfer"]').count() === 1, 'двойные зависимые чекбоксы тоже');
ok(await p.locator('.preview-setup textarea').count() === 1, 'и поле для чекбоксов, добавляемых через API');
ok(await p.locator('.pv-setup-send select').count() === 1, 'есть выбор планшета для проверки');

// Ничего не отмечено: зависимые блоки скрыты.
await p.click('.preview-setup .btn-primary');
await p.waitForSelector('.preview-wrap', { timeout: 6000 });
let текст = await p.locator('.pv-body').textContent();
ok(!/БЛОК-ПРИ-СМС/.test(текст) && !/БЛОК-ПРИ-ЗАПРЕТЕ/.test(текст), 'пока ничего не прислано, зависимые блоки скрыты');
await p.locator('.preview-wrap button', { hasText: 'Изменить значения' }).click();
await p.waitForSelector('.preview-setup', { timeout: 4000 });

// Присылаем отметку и выбор.
await p.locator('.preview-setup input[data-check="sms"]').check();
await p.locator('.preview-setup select[data-group="transfer"]').selectOption('deny');
await p.click('.preview-setup .btn-primary');
await p.waitForSelector('.preview-wrap', { timeout: 6000 });
текст = await p.locator('.pv-body').textContent();
ok(/БЛОК-ПРИ-СМС/.test(текст), 'присланная отметка показала свой блок');
ok(/БЛОК-ПРИ-ЗАПРЕТЕ/.test(текст), 'присланный выбор в группе показал свой блок');
const отмечен = await p.evaluate(() => {
  const i = document.querySelector('.pv-live input[type=checkbox]');
  return i ? i.checked : null;
});
ok(отмечен === true, 'и сам пункт показан отмеченным, а не пустым');

// Отправка на планшет тем же составом данных.
await p.locator('.preview-wrap button', { hasText: 'Изменить значения' }).click();
await p.waitForSelector('.preview-setup', { timeout: 4000 });
await p.locator('.preview-setup input[data-check="sms"]').check();
await p.locator('.preview-setup select[data-group="transfer"]').selectOption('deny');
await p.locator('.pv-setup-send button', { hasText: 'Проверить на планшете' }).click();
await p.waitForTimeout(1200);

await kiosk.waitForSelector('.doc-body', { timeout: 8000 });
const наПланшете = await kiosk.evaluate(() => document.querySelector('.doc-body').textContent);
ok(/БЛОК-ПРИ-СМС/.test(наПланшете), 'на планшете тот же блок по отметке');
ok(/БЛОК-ПРИ-ЗАПРЕТЕ/.test(наПланшете), 'и тот же блок по выбору в группе');
ok(/Иванова Анна/.test(наПланшете), 'и тестовые значения тегов подставились: ' + наПланшете.slice(0, 60));
const наПланшетеОтмечен = await kiosk.evaluate(() => {
  const i = document.querySelector('.checks .check input');
  return i ? i.checked : null;
});
ok(наПланшетеОтмечен === true, 'пункт на планшете тоже отмечен');

// Та же кнопка есть и в самом окне предпросмотра: решение «посмотрю на живом экране»
// приходит и там тоже.
await p.click('#previewDoc');
await p.waitForSelector('.preview-setup', { timeout: 5000 });
await p.click('.preview-setup .btn-primary');
await p.waitForSelector('.preview-wrap', { timeout: 6000 });
ok(await p.locator('.preview-wrap .pv-setup-send button', { hasText: 'Проверить на планшете' }).count() === 1,
  'в окне предпросмотра тоже есть «Проверить на планшете»');

ok(jsErr.length === 0, 'ошибок JavaScript нет: ' + jsErr.join(' | '));
await browser.close();
console.log(fail === 0 ? '\nВСЁ ПРОЙДЕНО' : '\n' + fail + ' ПРОВЕРОК УПАЛО');
process.exit(fail === 0 ? 0 : 1);
