// Наблюдение за экраном планшета: оператор видит то же, что клиент, в реальном времени.
import { chromium } from 'playwright';
const BASE = 'http://127.0.0.1:5080';
// Путь к браузеру берётся из окружения: на другой машине он другой, а зашитый путь
// превращал набор в неработающий у всех, кроме одной установки. Пусто значит
// «пусть Playwright возьмёт свой», как он и делает по умолчанию.
const EXE = process.env.SK_CHROME || undefined;
let fail = 0;
const ok = (c, m) => { if (c) console.log('PASS', m); else { console.error('FAIL', m); fail++; } };

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const p = await (await browser.newContext({ viewport: { width: 1500, height: 950 } })).newPage();
p.on('pageerror', e => console.log('ОШИБКА АДМИНКИ:', e.message));
await p.goto(BASE + '/admin/');
await p.fill('#password', 'test123'); await p.click('#loginForm button[type=submit]');
await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
const call = (path, opts) => p.evaluate(async ([pa, o]) => {
  const r = await fetch('/api/admin' + pa, Object.assign({ credentials: 'same-origin' }, o || {}));
  let b = null; try { b = await r.json(); } catch {} return { status: r.status, body: b };
}, [path, opts]);

await call('/document', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
  title: 'СОГЛАСИЕ НА ОБСЛЕДОВАНИЕ', signPrompt: 'Распишитесь', thankYouText: 'Спасибо', idleReturnSec: 0,
  pages: [
    { headingRuns: [{ text: 'Условия' }], blocks: [{ runs: [{ text: 'Текст соглашения для клиента.' }], ord: 0 }],
      checkboxes: [{ key: 'soglasie', label: 'Согласен с условиями', required: true, ord: 1 },
                   { key: 'rassylka', label: 'Согласен на рассылку', required: false, ord: 2 }],
      groups: [{ key: 'pisha', title: 'Голодание', required: true, ord: 3,
                 options: [{ key: 'da', label: 'ДА' }, { key: 'net', label: 'НЕТ' }] }],
      signatures: [], scans: [] }
  ], signBlocks: [], signBlocksBelow: [] }) });

const code = (await call('/devices/enroll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"name":"Планшет у окна"}' })).body.code;
const kiosk = await (await browser.newContext({ viewport: { width: 800, height: 1200 } })).newPage();
await kiosk.goto(BASE + '/?enroll=' + encodeURIComponent(code));
await kiosk.waitForFunction(() => !!localStorage.getItem('sk_device_token'), { timeout: 12000 });
let id = null;
for (let i = 0; i < 40; i++) {
  const d = (await call('/devices')).body || []; const on = d.find(x => x.online);
  if (on) { id = on.id; break; }
  await kiosk.waitForTimeout(250);
}
ok(!!id, 'планшет на связи');

// Кнопка «Смотреть» на карточке планшета.
await p.click('[data-tab="devices"]'); await p.waitForTimeout(900);
const кнопка = p.locator('.dev-item button', { hasText: 'Смотреть' });
ok(await кнопка.count() === 1, 'на карточке есть кнопка наблюдения');
ok(await p.locator('#watchDoc').count() === 1, 'и на странице документа тоже есть кнопка наблюдения');

// Документ отправляет ВНЕШНЯЯ система, а не оператор: должно прийти предложение посмотреть.
await call('/show-document', { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ target: 'device:' + id, fields: {} }) });
await kiosk.waitForSelector('.check', { timeout: 8000 });
await p.waitForTimeout(900);
const предложение = p.locator('.toast-watch');
ok(await предложение.count() === 1, 'пришло предложение посмотреть');
ok((await предложение.textContent()).includes('Планшет у окна'), 'и названо имя планшета');

// Открываем наблюдение из предложения.
const [окно] = await Promise.all([
  p.context().waitForEvent('page', { timeout: 15000 }),
  предложение.locator('button', { hasText: 'Смотреть' }).click()
]);
await окно.waitForLoadState();
await окно.waitForSelector('.watch-screen', { timeout: 15000 });
await окно.waitForTimeout(1200);
ok(окно !== p, 'наблюдение открылось отдельным окном браузера');
ok(/#watch=/.test(окно.url()), 'и по ссылке наблюдения: ' + окно.url().slice(-40));
const w = окно;
let экран = await w.locator('.watch-screen').textContent();
ok(экран.includes('Текст соглашения для клиента.'), 'оператор видит текст документа');
ok(экран.includes('Согласен с условиями'), 'и пункты');
ok(экран.includes('Голодание') && экран.includes('ДА'), 'и двойные зависимые чекбоксы');
ok(/Шаг 1 из/.test(экран), 'и на каком шаге клиент: ' + (экран.match(/Шаг \d+ из \d+/) || [''])[0]);

// Клиент ставит галочку: она должна появиться у оператора.
ok(await w.locator('.watch-check.on').count() === 0, 'пока клиент ничего не отметил');
await kiosk.evaluate(() => {
  const n = Array.from(document.querySelectorAll('.checks .check')).find(x => x.textContent.includes('Согласен с условиями'));
  const i = n.querySelector('input'); i.checked = true; i.dispatchEvent(new Event('change', { bubbles: true }));
});
await w.waitForTimeout(900);
const отмечено = await w.locator('.watch-check.on').allTextContents();
ok(отмечено.length === 1 && отмечено[0].includes('Согласен с условиями'),
  'отметка клиента появилась у оператора: ' + JSON.stringify(отмечено));

// Клиент выбирает вариант.
await kiosk.evaluate(() => {
  const n = Array.from(document.querySelectorAll('.group-options .check')).find(x => x.textContent.includes('ДА'));
  const i = n.querySelector('input'); i.checked = true; i.dispatchEvent(new Event('change', { bubbles: true }));
});
await w.waitForTimeout(900);
const выбор = await w.locator('.pv-group-options .watch-check.on').allTextContents();
ok(выбор.length === 1 && выбор[0].includes('ДА'), 'выбор варианта тоже виден: ' + JSON.stringify(выбор));

// Клиент переходит на экран подписи и расписывается.
await kiosk.evaluate(() => document.getElementById('btnNext').click());
await kiosk.waitForSelector('.sign-screen canvas', { timeout: 8000 });
await w.waitForTimeout(900);
экран = await w.locator('.watch-screen').textContent();
ok(экран.includes('Распишитесь'), 'оператор видит, что клиент дошёл до подписи');
ok(await w.locator('.watch-ink').count() === 1, 'и место под подпись');
ok(await w.locator('.watch-ink img').count() === 0, 'пока пустое');

const b = await kiosk.locator('.sign-screen .sign-wrap').boundingBox();
await kiosk.mouse.move(b.x + 30, b.y + b.height / 2);
await kiosk.mouse.down();
await kiosk.mouse.move(b.x + b.width - 40, b.y + b.height / 2 - 25, { steps: 12 });
await kiosk.mouse.up();
await w.waitForTimeout(1200);
ok(await w.locator('.watch-ink img').count() === 1, 'подпись клиента появилась у оператора');
const src = await w.locator('.watch-ink img').getAttribute('src');
ok(/^data:image\/(png|jpeg)/.test(src || ''), 'и это настоящая картинка подписи: ' + String(src).slice(0, 24));

// Окно только для просмотра: ни одного поля ввода и ни одной кнопки, что-то меняющей.
const внутри = await w.evaluate(() => {
  const w = document.querySelector('.watch');
  return {
    inputs: w.querySelectorAll('input, textarea, select').length,
    buttons: Array.from(w.querySelectorAll('button')).map(b => b.textContent.trim())
  };
});
ok(внутри.inputs === 0, 'в окне наблюдения нет полей ввода: ' + внутри.inputs);
// Кнопка одна и она только закрывает. Название зависит от того, где открыто наблюдение:
// в отдельном окне закрывается окно, поверх админки закрывается окошко.
ok(внутри.buttons.length === 1 && /^Закрыть( окно)?$/.test(внутри.buttons[0]),
  'и единственная кнопка это «Закрыть»: ' + JSON.stringify(внутри.buttons));

// Камера: у оператора она не открывается и разрешения не спрашивает.
await call('/scan/start', { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ deviceId: id }) }).catch(() => null);
await p.waitForTimeout(1200);
const приСканировании = await w.evaluate(() => {
  const w = document.querySelector('.watch');
  return { видео: w.querySelectorAll('video').length, текст: w.textContent };
});
ok(приСканировании.видео === 0, 'в окне наблюдения нет видео вообще');

// Закрытие прекращает наблюдение. Наблюдение открыто отдельным окном браузера, поэтому кнопка
// закрывает само окно: ждать после этого нечего, страницы больше нет.
await w.locator('.watch button', { hasText: 'Закрыть' }).click();
for (let i = 0; i < 20 && !w.isClosed(); i++) await p.waitForTimeout(100);
ok(w.isClosed(), 'окно наблюдения закрылось');

// Прямая ссылка: наблюдение открывается сразу за нужным планшетом, по коду рабочего места.
const ws = await p.evaluate(async () => {
  const r = await fetch('/api/admin/workstations', { method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Ресепшн', externalId: 'WS-777', location: 'Холл' }) });
  return await r.json();
});
await p.evaluate(async ([devId, wsId]) => {
  await fetch('/api/admin/devices/' + devId, { method: 'PUT', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Планшет у окна', workstationId: wsId }) });
}, [id, ws.id]);

await p.goto(BASE + '/admin/#watch=WS-777');
await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
await p.waitForSelector('.watch-screen', { timeout: 15000 });
await p.waitForTimeout(1200);
ok(await p.locator('.watch-screen').count() === 1, 'ссылка #watch=WS-777 открыла наблюдение сразу');
ok((await p.locator('.watch-head').textContent()).includes('Планшет у окна'), 'и за тем самым планшетом');
const поСсылке = await p.locator('.watch-screen').textContent();
ok(поСсылке.includes('Распишитесь') || поСсылке.includes('Текст соглашения'),
  'и показывает то, что сейчас на экране планшета');
// Ссылку открыли не новым окном, а прямо в этой вкладке: закрыть её браузер не даст, поэтому
// кнопка возвращает в админку к списку планшетов, а не оставляет в окне без выхода.
await p.locator('.watch button', { hasText: 'Закрыть' }).click();
await p.waitForSelector('[data-panel="devices"]:not(.hidden)', { timeout: 8000 });
ok(await p.locator('.watch-screen').count() === 0, 'наблюдение по ссылке закрылось');
ok(await p.locator('.tabs').isVisible(), 'и оператор вернулся в обычную админку');

// Ссылка на несуществующий планшет объясняется словами. Пустое окно без единого слова
// выглядело бы как поломка наблюдения, хотя дело в ссылке.
await p.goto(BASE + '/admin/#watch=WS-НЕТ-ТАКОГО');
await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
await p.waitForSelector('.watch-solo-page', { timeout: 8000 });
await p.waitForTimeout(2000);
const неизвестный = await p.locator('.watch-screen').textContent();
ok(/не найден/.test(неизвестный), 'на неизвестный код окно объясняет, что планшета нет: ' + неизвестный.trim().slice(0, 70));

// Журнал: наблюдение не оставляет следов.
const логи = JSON.stringify((await call('/logs')).body || []);
ok(!/наблюден|watch|Watch/i.test(логи), 'в журнале нет записей о наблюдении');

await browser.close();
console.log(fail === 0 ? '\nВСЁ ПРОЙДЕНО' : '\n' + fail + ' ПРОВЕРОК УПАЛО');
process.exit(fail === 0 ? 0 : 1);
