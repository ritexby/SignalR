// Разбор вкладки «Слайды»: каждая кнопка, каждый поток, включая крайние случаи.
import { chromium } from 'playwright';
const BASE = 'http://127.0.0.1:5080';
// Путь к браузеру берётся из окружения: на другой машине он другой, а зашитый путь
// превращал набор в неработающий у всех, кроме одной установки. Пусто значит
// «пусть Playwright возьмёт свой», как он и делает по умолчанию.
const EXE = process.env.SK_CHROME || undefined;
const найдено = [];
const баг = (что) => { найдено.push(что); console.log('FAIL ' + что); };
const норм = (что) => console.log('в порядке: ' + что);

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const p = await (await browser.newContext({ viewport: { width: 1500, height: 950 } })).newPage();
const ошибкиJS = [];
p.on('pageerror', e => ошибкиJS.push(String(e.message).slice(0, 120)));
await p.goto(BASE + '/admin/');
await p.fill('#password', 'test123'); await p.click('#loginForm button[type=submit]');
await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
const call = (path, opts) => p.evaluate(async ([pa, o]) => {
  const r = await fetch('/api/admin' + pa, Object.assign({ credentials: 'same-origin' }, o || {}));
  let b = null; try { b = await r.json(); } catch {} return { status: r.status, body: b };
}, [path, opts]);

// 1. Планшетов нет вообще: какие кнопки живы и что они говорят.
await p.click('[data-tab="slides"]'); await p.waitForTimeout(600);
const безПланшетов = await p.evaluate(() => ({
  сохранить: { выкл: document.getElementById('saveSlides').disabled,
               подсказка: document.getElementById('saveSlides').getAttribute('title') },
  загрузить: !!document.getElementById('imageUpload'),
  сетка: (document.getElementById('imageGrid').textContent || '').trim().slice(0, 80)
}));
if (!безПланшетов.сохранить.подсказка)
  баг('без планшетов кнопка «Сохранить и показать» ничего не объясняет заранее');
else норм('без планшетов кнопка сохранения объяснена: ' + безПланшетов.сохранить.подсказка.slice(0, 60));
норм('пустая сетка подписана: ' + безПланшетов.сетка);

// 2. Загрузка не-картинки: что скажут оператору.
const загрузить = (имя, тип, данные) => p.evaluate(async ([n, t, d]) => {
  const fd = new FormData();
  fd.append('files', new Blob([d], { type: t }), n);
  const r = await fetch('/api/admin/images', { method: 'POST', credentials: 'same-origin', body: fd });
  return { status: r.status, body: await r.text() };
}, [имя, тип, данные]);
const мусор = await загрузить('dogovor.pdf', 'application/pdf', '%PDF-1.4 not an image');
if (мусор.status === 200 && мусор.body.trim() === '[]')
  баг('загрузка не-картинки принимается с кодом 200 и пустым списком: админка скажет «Картинки загружены», хотя не загрузилось ничего');
else норм('не-картинка отклонена: ' + мусор.status + ' ' + мусор.body.slice(0, 60));

// 3. Огромный файл: есть ли предел.
const большой = 'x'.repeat(12 * 1024 * 1024);
const огромный = await загрузить('big.png', 'image/png', большой);
if (огромный.status === 200)
  баг('картинка в 12 МБ принимается без ограничения: она уйдёт на все планшеты и займёт диск');
else норм('слишком большой файл отклонён: ' + огромный.status);

// 4. Удаление картинки, которая сейчас показывается на планшете.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAFUlEQVR42mNk+M/wn4EIwDiqkL4KAcT9A/1G3AxaAAAAAElFTkSuQmCC';
const залить = (имя) => p.evaluate(async ([b64, n]) => {
  const bin = atob(b64), arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  const fd = new FormData();
  fd.append('files', new Blob([arr], { type: 'image/png' }), n);
  const r = await fetch('/api/admin/images', { method: 'POST', credentials: 'same-origin', body: fd });
  const j = await r.json();
  return (j.added || j)[0];
}, [PNG, имя]);
const a = await залить('a.png'); const b = await залить('b.png');
await call('/playlist', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ target: 'all', imageIds: [a.id, b.id], intervalSec: 5 }) });
const code = (await call('/devices/enroll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"name":"Планшет"}' })).body.code;
const kiosk = await (await browser.newContext({ viewport: { width: 900, height: 1400 } })).newPage();
await kiosk.goto(BASE + '/?enroll=' + encodeURIComponent(code));
await kiosk.waitForFunction(() => !!localStorage.getItem('sk_device_token'), { timeout: 12000 });
await kiosk.waitForTimeout(2000);
const было = await kiosk.evaluate(() => (window.__slidesForTest || []).length);
await call('/images/' + a.id, { method: 'DELETE' });
await kiosk.waitForTimeout(2500);
const стало = await kiosk.evaluate(() => window.__slidesForTest || []);
if (стало.length === было)
  баг('удалённая картинка остаётся в списке на планшете: он продолжает показывать её адрес, а файла уже нет, и клиент видит битую картинку до перезагрузки');
else норм('после удаления список на планшете пересобрался: было ' + было + ', стало ' + стало.length);

// 5. Плейлист из одной картинки, интервал 1 секунда: не мигает ли.
await call('/playlist', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ target: 'all', imageIds: [b.id], intervalSec: 1 }) });
await kiosk.waitForTimeout(2500);
const одна = await kiosk.evaluate(() => ({ список: (window.__slidesForTest || []).length,
  картинок: document.querySelectorAll('#slideshow img').length }));
норм('одна картинка в списке: ' + JSON.stringify(одна));

// 6. Пустой плейлист: что видит клиент.
await call('/playlist', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ target: 'all', imageIds: [], intervalSec: 6 }) });
await kiosk.waitForTimeout(2000);
const пусто = await kiosk.evaluate(() => {
  const s = document.getElementById('slideshow');
  return { видно: s && !s.classList.contains('hidden'), текст: (s ? s.textContent : '').trim().slice(0, 80),
    картинок: document.querySelectorAll('#slideshow img[src]').length };
});
if (пусто.видно && !пусто.текст && пусто.картинок === 0)
  баг('пустой плейлист оставляет планшет с чёрным экраном без единого слова: сотрудник не поймёт, сломался он или так задумано');
else норм('при пустом плейлисте планшет что-то показывает: ' + JSON.stringify(пусто));

// 7. Все картинки вне срока показа: то же самое, но задать это легко случайно.
const c = await залить('c.png');
await call('/images/' + c.id + '/dates', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ showFrom: '2030-01-01', showTo: '2030-12-31' }) });
await call('/playlist', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ target: 'all', imageIds: [c.id], intervalSec: 6 }) });
await p.reload(); await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
await p.click('[data-tab="slides"]'); await p.waitForTimeout(900);
const предупредили = await p.evaluate(() => document.body.textContent.indexOf('ни одна') >= 0
  || document.body.textContent.indexOf('не показыв') >= 0);
if (!предупредили)
  баг('все выбранные картинки вне срока показа, но админка об этом не предупреждает: на планшете будет пусто, а оператор уверен, что реклама идёт');
else норм('о картинках вне срока предупреждают');

// 8. Интервал: границы и мусор.
await p.evaluate(() => { document.getElementById('intervalInput').value = '0'; });
const и0 = await call('/playlist', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ target: 'all', imageIds: [b.id], intervalSec: 0 }) });
const сохранён = (await call('/playlist?target=all')).body;
норм('интервал 0 приведён к ' + сохранён.intervalSec + ' (ответ ' + и0.status + ')');

// 9. Ошибки JS за всё время.
if (ошибкиJS.length) баг('ошибки JavaScript в админке: ' + JSON.stringify(ошибкиJS.slice(0, 3)));
else норм('ошибок JavaScript нет');

await browser.close();
console.log('\nИТОГО НАЙДЕНО: ' + найдено.length);
найдено.forEach((x, i) => console.log((i + 1) + '. ' + x));
if (найдено.length === 0) console.log('\nВСЁ ПРОЙДЕНО');
process.exit(найдено.length === 0 ? 0 : 1);
