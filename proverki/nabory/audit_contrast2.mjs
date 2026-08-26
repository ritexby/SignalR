// Вторая половина проверки вида: то, чего не видно при простом заходе на вкладку. Узкий экран,
// всплывающие окна конструктора и, главное, все экраны планшета от ожидания до прощания. Первая
// проверка смотрит вкладки как они открываются, эта  доводит дело до состояний, в которых
// пользователь проводит больше всего времени.
import { chromium } from 'playwright';
import { ПРОВЕРКА } from './contrast_lib.mjs';
const BASE = 'http://127.0.0.1:5080';
// Путь к браузеру берётся из окружения: на другой машине он другой, а зашитый путь
// превращал набор в неработающий у всех, кроме одной установки. Пусто значит
// «пусть Playwright возьмёт свой», как он и делает по умолчанию.
const EXE = process.env.SK_CHROME || undefined;
let найдено = [];
const баг = (что) => { найдено.push(что); console.log('FAIL ' + что); };
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

// Окно поверх страницы перехватывает нажатия, и следующий шаг проверки утыкается в него, а не
// в кнопку. Закрываем прямо, а не надеждой на Escape.
async function закрытьОкно(страница) {
  for (let i = 0; i < 3; i++) {
    const открыто = await страница.evaluate(() => {
      const m = document.getElementById('modal');
      return !!(m && !m.classList.contains('hidden'));
    });
    if (!открыто) return;
    await страница.evaluate(() => { const b = document.getElementById('modalClose'); if (b) b.click(); });
    await страница.waitForTimeout(400);
  }
}

async function смотреть(страница, где) {
  const r = await страница.evaluate(ПРОВЕРКА);
  r.текстовые.forEach(x => баг(где + ': текст «' + x.текст + '» контраст ' + x.контраст + ' при пороге ' + x.порог + ' (' + x.где + ')'));
  (r.значки || []).forEach(x => баг(где + ': значок не виден, контраст ' + x.контраст + ' (' + x.где + ')'));
  r.коробки.forEach(x => баг(где + ': ' + x.вид + ', контраст ' + x.контраст + (x.порог ? ' при пороге ' + x.порог : '') + ' (' + x.где + ')'));
  console.log(где + ': проверено');
}

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const p = await (await browser.newContext({ viewport: { width: 1500, height: 1000 } })).newPage();
p.on('dialog', d => d.accept());
await p.goto(BASE + '/admin/');
await p.fill('#password', 'test123');
await p.click('#loginForm button[type=submit]');
await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
const отказ = p.locator('.modal button', { hasText: 'Отказаться от черновика' });
try { await отказ.waitFor({ state: 'visible', timeout: 2000 }); await отказ.click(); } catch {}

const call = (path, opts) => p.evaluate(async ([pa, o]) => {
  const r = await fetch('/api/admin' + pa, Object.assign({ credentials: 'same-origin' }, o || {}));
  let body = null; try { body = await r.json(); } catch { body = null; }
  return { status: r.status, body };
}, [path, opts]);
const post = (path, obj) => call(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });
const put = (path, obj) => call(path, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });

// ---------- Документ со всеми видами блоков: иначе половину вёрстки просто нечем нарисовать ----------
const документ = {
  kind: 'sign', title: 'Согласие на проверку вида', signPrompt: 'Распишитесь ниже',
  thankYouText: 'Спасибо, документ подписан', idleReturnSec: 0, thankYouSec: 30,
  pages: [
    { headingRuns: [{ text: 'Условия' }], includeDynamic: false,
      blocks: [
        { runs: [{ text: 'Обычный абзац с ' }, { text: 'жирным', bold: true }, { text: ' и ' }, { text: 'цветным', color: '#b91c1c' }, { text: ' текстом.' }], ord: 0 },
        { list: 'number', runs: [{ text: 'Первый пункт списка\nВторой пункт списка' }], ord: 1 },
        { list: 'bullet', runs: [{ text: 'Маркированный пункт\nЕщё один пункт' }], ord: 2 },
        { table: { rows: [['Услуга', 'Цена'], ['Осмотр', '1200'], ['Повторный приём', '900']], widths: [], headerRow: true }, ord: 3 },
        { imageTag: 'ФОТО', imageWidth: 30, ord: 4 },
        { bg: '#fef9c3', borderColor: '#eab308', pad: 12, runs: [{ text: 'Блок с собственным оформлением.' }], ord: 5 },
        { kind: 'divider', ord: 6 }
      ] },
    { headingRuns: [{ text: 'Отметки и поля' }], includeDynamic: false,
      blocks: [{ runs: [{ text: 'Заполните и отметьте:' }], ord: 0 }],
      checkboxes: [{ key: 'ok1', label: 'Согласен на обработку данных', required: true, ord: 1 },
                   { key: 'ok2', label: 'Согласен на рассылку', required: false, ord: 2 }],
      inputs: [{ key: 'fio', label: 'Фамилия и имя', kind: 'text', required: true, ord: 3 },
               { key: 'tel', label: 'Телефон', kind: 'phone', required: false, ord: 4 }] },
    { headingRuns: [{ text: 'Подпись' }], includeDynamic: false,
      blocks: [{ runs: [{ text: 'Распишитесь в поле ниже.' }], ord: 0 }],
      signatures: [{ key: 'sig', label: 'Подпись клиента', required: true, ord: 1 }] }
  ]
};
await put('/document', документ);

// ---------- Узкий экран: админкой пользуются и с ноутбука, и с планшета ----------
const узкая = await (await browser.newContext({ viewport: { width: 860, height: 1000 } })).newPage();
узкая.on('dialog', d => d.accept());
await узкая.goto(BASE + '/admin/');
await узкая.fill('#password', 'test123');
await узкая.click('#loginForm button[type=submit]');
await узкая.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
const отказ2 = узкая.locator('.modal button', { hasText: 'Отказаться от черновика' });
try { await отказ2.waitFor({ state: 'visible', timeout: 2000 }); await отказ2.click(); } catch {}
const вкладки = await узкая.locator('.tab').evaluateAll(n => n.map(x => x.getAttribute('data-tab')));
for (const имя of вкладки) {
  await узкая.click('.tab[data-tab="' + имя + '"]');
  await узкая.waitForTimeout(700);
  await смотреть(узкая, 'узкий экран, вкладка «' + имя + '»');
}
await узкая.close();

const enr = (await post('/devices/enroll', { name: 'Планшет вида', ttlMinutes: 30 })).body;
const tok = await p.evaluate(async (code) => (await fetch('/api/kiosk/enroll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) })).json(), enr.code);

const kiosk = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
await kiosk.goto(BASE + '/');
await kiosk.waitForTimeout(900);
await смотреть(kiosk, 'планшет: экран привязки');

await kiosk.evaluate(t => localStorage.setItem('sk_device_token', t), tok.token);
await kiosk.reload();
await kiosk.waitForTimeout(1500);
await смотреть(kiosk, 'планшет: ожидание');

// ---------- Всплывающие окна конструктора ----------
await p.click('.tab[data-tab="document"]');
await p.waitForTimeout(900);

await p.click('#previewDoc');
await p.waitForSelector('#modal:not(.hidden)', { timeout: 6000 });
await p.waitForTimeout(600);
await смотреть(p, 'окно предпросмотра');
await p.click('#modalClose');
await p.waitForTimeout(400);

await p.click('#pdfLayout');
await p.waitForSelector('#modal:not(.hidden)', { timeout: 6000 });
await p.waitForTimeout(900);
await смотреть(p, 'окно раскладки PDF');
await p.click('#modalClose');
await p.waitForTimeout(400);

await p.click('#checkDoc');
await p.waitForTimeout(700);
await смотреть(p, 'проверка документа');
// Проверка тоже открывает окно, и незакрытым оно потом перехватывает все нажатия.
if (await p.locator('#modal:not(.hidden)').count()) { await p.click('#modalClose'); await p.waitForTimeout(400); }

const меню = p.locator('.doc-tab-menu').first();
if (await меню.count()) {
  await меню.click();
  await p.waitForTimeout(400);
  await смотреть(p, 'меню закладки документа');
  await p.keyboard.press('Escape');
  await p.waitForTimeout(300);
}

// Прожектор условий: панель, которая появляется только когда в документе есть условия.
const прожектор = p.locator('.spotlight');
if (await прожектор.count()) {
  await p.evaluate(() => { const s = document.querySelector('.spotlight select'); if (s && s.options.length > 1) { s.selectedIndex = 1; s.dispatchEvent(new Event('change', { bubbles: true })); } });
  await p.waitForTimeout(500);
  await смотреть(p, 'прожектор условий');
}

// ---------- Планшет: все экраны по очереди ----------
// Всплывашки живут секунды и в обычную проверку не попадают, а видеть их надо: одна из них
// предлагает посмотреть за планшетом, и нажимать в ней приходится вслепую, если кнопки белые.
await p.click('.tab[data-tab="devices"]');
await p.waitForTimeout(800);
await p.click('.tab[data-tab="document"]');
await p.waitForTimeout(800);
await закрытьОкно(p);
await p.selectOption('#docTarget', { index: 1 }).catch(() => {});
await p.click('#saveDocument');
await p.waitForSelector('.toast', { timeout: 6000 });
await смотреть(p, 'всплывашка о сохранении');
// Всплывашку убираем сами: она перекрывает низ страницы и держит клик на кнопке.
await p.evaluate(() => document.querySelectorAll('.toast').forEach(t => t.remove()));
await закрытьОкно(p);
// Предложение посмотреть за планшетом приходит по связи и на отправку из внешней системы тоже,
// поэтому толкаем документ через API: так проверка не зависит от окон, которые открывает кнопка.
await post('/show-document', { target: 'device:' + tok.deviceId, fields: {}, images: {} });
await p.waitForSelector('.toast-watch', { timeout: 10000 });
await p.waitForTimeout(400);
await смотреть(p, 'всплывашка с предложением посмотреть за планшетом');

// Окно наблюдения за экраном планшета: отдельный вид со своими отметками, росчерком и полосой
// состояния. Открывается настоящим новым окном браузера, поэтому ловим его как всплывающую
// страницу, а не ищем на текущей.
const [окноНаблюдения] = await Promise.all([
  p.context().waitForEvent('page', { timeout: 15000 }),
  p.click('.toast-watch .btn')
]);
await окноНаблюдения.waitForSelector('.watch-screen', { timeout: 15000 });
await окноНаблюдения.waitForTimeout(1500);
await смотреть(окноНаблюдения, 'окно наблюдения за экраном планшета');
await окноНаблюдения.close();

// Ещё одна отправка, теперь через API и с картинкой: её на планшете тоже надо увидеть.
await post('/show-document', { target: 'device:' + tok.deviceId, fields: {}, images: { 'ФОТО': 'data:image/png;base64,' + PNG } });
await kiosk.waitForSelector('text=Обычный абзац', { timeout: 8000 });
await смотреть(kiosk, 'планшет: страница текста, списка и таблицы');

await kiosk.click('#btnNext');
await kiosk.waitForSelector('text=Заполните и отметьте', { timeout: 6000 });
await смотреть(kiosk, 'планшет: отметки и поля');

// Незаполненное обязательное поле: подсветка ошибки тоже должна читаться.
await kiosk.click('#btnNext');
await kiosk.waitForTimeout(600);
await смотреть(kiosk, 'планшет: подсветка незаполненного');

await kiosk.evaluate(() => {
  document.querySelectorAll('#document input[type=checkbox]').forEach(c => { if (!c.checked) { c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })); } });
  document.querySelectorAll('#document input[type=text], #document input[type=tel]').forEach(i => { i.value = 'Проверка вида'; i.dispatchEvent(new Event('input', { bubbles: true })); });
});
await kiosk.waitForTimeout(400);
await kiosk.click('#btnNext');
await kiosk.waitForSelector('#document canvas', { timeout: 6000 });
await смотреть(kiosk, 'планшет: экран подписи');

// Росчерк мышью на каждом экране, где есть поле подписи: их два, страница с блоком подписи и
// отдельный экран подписи в конце. Идём до прощания, а не считаем шаги руками.
for (let шаг = 0; шаг < 5; шаг++) {
  const холсты = kiosk.locator('#document canvas');
  if (await холсты.count()) {
    const b = await холсты.first().boundingBox();
    await kiosk.mouse.move(b.x + 40, b.y + 60);
    await kiosk.mouse.down();
    await kiosk.mouse.move(b.x + 200, b.y + 100, { steps: 12 });
    await kiosk.mouse.up();
    await kiosk.waitForTimeout(400);
    if (шаг === 0) await смотреть(kiosk, 'планшет: подпись поставлена');
  }
  if (await kiosk.locator('#document .thankyou').count()) break;
  // Отправка документа тянет за собой PDF, и кнопка успевает исчезнуть раньше, чем появится
  // прощание. Ждём любое из двух, иначе проверка спотыкается на собственной торопливости.
  // На последнем экране кнопка называется «ПОДПИСАТЬ» и у неё другой номер, а не «Далее».
  await kiosk.waitForSelector('#document .thankyou, #btnNext, #btnSign', { timeout: 15000 });
  if (await kiosk.locator('#document .thankyou').count()) break;
  if (await kiosk.locator('#btnSign').count()) {
    await смотреть(kiosk, 'планшет: кнопка подписания');
    await kiosk.click('#btnSign');
  } else await kiosk.click('#btnNext');
  await kiosk.waitForTimeout(1500);
}
await kiosk.waitForSelector('#document .thankyou', { timeout: 8000 });
await смотреть(kiosk, 'планшет: прощание');

await browser.close();
console.log('\nИТОГО НАЙДЕНО: ' + найдено.length);
if (найдено.length === 0) console.log('\nВСЁ ПРОЙДЕНО');
process.exit(найдено.length === 0 ? 0 : 1);
