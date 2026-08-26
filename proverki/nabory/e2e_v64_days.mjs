// Счёт дней вокруг годовщины. Проверяется двумя способами, потому что они ловят разное.
// Первый: сама функция сервера на выдуманных датах, включая переход через Новый год и 29
// февраля. Такие дни через живую службу не проверить: её «сегодня» не подменить.
// Второй: живая служба целиком, от сохранения документа до разбора условия. Он ловит то, что
// первый пропускает по построению: приведение значений тега, разбор окна, путь через API.
import { chromium } from 'playwright';
import { execSync } from 'node:child_process';
const SP = '' + (process.env.SK_RABOTA || '.') + '';
const BASE = 'http://127.0.0.1:5080';
// Путь к браузеру берётся из окружения: на другой машине он другой, а зашитый путь
// превращал набор в неработающий у всех, кроме одной установки. Пусто значит
// «пусть Playwright возьмёт свой», как он и делает по умолчанию.
const EXE = process.env.SK_CHROME || undefined;
let fail = 0;
const ok = (c, m) => { if (c) console.log('PASS', m); else { console.error('FAIL', m); fail++; } };

// ---------- 1. Края, до которых через живую службу не добраться ----------
let вывод = '';
try {
  вывод = execSync('dotnet run --project ' + SP + '/dayscheck -v q --nologo 2>&1', { encoding: 'utf8' });
} catch (e) { вывод = String((e.stdout || '') + (e.stderr || '')); }
const прошло = вывод.indexOf('ВСЁ ПРОЙДЕНО') >= 0;
if (!прошло) console.error(вывод.split('\n').filter(l => l.indexOf('FAIL') === 0).join('\n'));
ok(прошло, 'края счёта дней: Новый год, 29 февраля, нулевое окно, мусор в дате и в окне');
ok(вывод.indexOf('показывается ровно 15 дней') >= 0, 'окно «7» показывается ровно 15 дней: неделя до, сам день, неделя после');

// ---------- 2. Живая служба целиком ----------
const browser = await chromium.launch({ executablePath: EXE, headless: true });
const admin = await (await browser.newContext()).newPage();
admin.on('pageerror', e => { console.error('FAIL ошибка в админке: ' + e.message); fail++; });
await admin.goto(BASE + '/admin/');
await admin.fill('#password', 'test123');
await admin.click('#loginForm button[type=submit]');
await admin.waitForSelector('#app:not(.hidden)', { timeout: 8000 });

const call = (path, opts) => admin.evaluate(async ([pa, o]) => {
  const r = await fetch('/api/admin' + pa, Object.assign({ credentials: 'same-origin' }, o || {}));
  let body = null; try { body = await r.json(); } catch { body = null; }
  return { status: r.status, body };
}, [path, opts]);
const post = (path, obj) => call(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });

// Часы сервера: сутки считаются по ним, и все ожидания ниже строятся от них же. Считать от часов
// этой машины нельзя: разойдись они с сервером на день, набор ловил бы разницу часов, а не ошибку.
const расписание = (await call('/schedule')).body || {};
ok(!!расписание.serverDate, 'служба сообщает свою дату: ' + расписание.serverDate + ' ' +
  (расписание.serverTime || '') + ' (' + (расписание.serverZone || 'пояс не назван') + ')');
const сегодня = new Date(расписание.serverDate + 'T00:00:00Z');

function док(окно) {
  return {
    title: 'Поздравление', signPrompt: 'Подпись', thankYouText: 'Спасибо', idleReturnSec: 0,
    pages: [{
      headingRuns: [{ text: 'Страница' }],
      blocks: [
        { runs: [{ text: 'общий текст' }] },
        { runs: [{ text: 'ПОЗДРАВЛЯЕМ' }], visibleWhen: { field: 'ДР', op: 'annivwithin', value: окно } }
      ],
      checkboxes: [], includeDynamic: false
    }]
  };
}
// Годовщина, отстоящая от сегодняшнего дня сервера ровно на «сдвиг» дней. Минус это годовщина
// уже прошла, плюс это она впереди. Год рождения берётся давний, чтобы это была именно годовщина.
function дрСоСдвигом(сдвиг) {
  const d = new Date(сегодня.getTime() + сдвиг * 86400000);
  const дд = String(d.getUTCDate()).padStart(2, '0');
  const мм = String(d.getUTCMonth() + 1).padStart(2, '0');
  return дд + '.' + мм + '.1985';
}
async function виден(окно, сдвиг) {
  const r = await post('/document/preview', { document: док(окно), fields: { 'ДР': дрСоСдвигом(сдвиг) } });
  if (r.status !== 200) { console.error('FAIL предпросмотр вернул ' + r.status + ': ' + JSON.stringify(r.body)); fail++; return false; }
  return JSON.stringify(r.body.document).indexOf('ПОЗДРАВЛЯЕМ') >= 0;
}

// Окно «7»: семь дней до годовщины, сам день и семь после.
let сбоев = [];
for (let сдвиг = -10; сдвиг <= 10; сдвиг++) {
  const ждём = Math.abs(сдвиг) <= 7;
  const есть = await виден('7', сдвиг);
  if (есть !== ждём) сбоев.push('сдвиг ' + сдвиг + ': показан=' + есть + ', ждали=' + ждём);
}
ok(сбоев.length === 0, 'окно «7» через живую службу: ровно от семи дней до до семи после' +
  (сбоев.length ? ' :: ' + сбоев.join('; ') : ''));

// Границы отдельными проверками: именно на них ошибка на единицу и видна.
ok(await виден('7', 7) === true, 'седьмой день ДО годовщины ещё показывается');
ok(await виден('7', 8) === false, 'восьмой день до годовщины уже нет');
ok(await виден('7', -7) === true, 'седьмой день ПОСЛЕ годовщины ещё показывается');
ok(await виден('7', -8) === false, 'восьмой день после годовщины уже нет');
ok(await виден('7', 0) === true, 'в сам день годовщины показывается');

// Окно «14/3»: четырнадцать дней до и три после. Раздельные стороны легко перепутать местами,
// поэтому проверяются обе, и именно на границах.
сбоев = [];
for (let сдвиг = -6; сдвиг <= 17; сдвиг++) {
  const ждём = сдвиг >= 0 ? сдвиг <= 14 : -сдвиг <= 3;
  const есть = await виден('14/3', сдвиг);
  if (есть !== ждём) сбоев.push('сдвиг ' + сдвиг + ': показан=' + есть + ', ждали=' + ждём);
}
ok(сбоев.length === 0, 'окно «14/3»: четырнадцать дней до годовщины и три после, стороны не перепутаны' +
  (сбоев.length ? ' :: ' + сбоев.join('; ') : ''));

// Нулевое окно: ровно сам день.
ok(await виден('0', 0) === true, 'нулевое окно: сам день показывается');
ok(await виден('0', 1) === false, 'нулевое окно: накануне нет');
ok(await виден('0', -1) === false, 'нулевое окно: назавтра нет');

// Дата не пришла вовсе: условие не выполняется, и это не ошибка.
const пусто = await post('/document/preview', { document: док('7'), fields: {} });
ok(пусто.status === 200 && JSON.stringify(пусто.body.document).indexOf('ПОЗДРАВЛЯЕМ') < 0,
  'даты нет: поздравление не показывается');

await browser.close();
if (fail === 0) console.log('\nВСЁ ПРОЙДЕНО');
process.exit(fail ? 1 : 0);
