// Нагрузка: 200 планшетов одновременно. Смотрим на память, задержки и поведение при массовом
// подключении, веерной рассылке и одновременном переподключении.
import { HubConnectionBuilder, LogLevel, HttpTransportType } from '@microsoft/signalr';
import { execSync } from 'node:child_process';

const BASE = 'http://127.0.0.1:5080';
const N = parseInt(process.env.N || '200', 10);
const PASS = 'test123';

// Свой адрес каждому планшету. В бою планшеты стоят в той же сети и приходят к обратному прокси
// каждый со своего адреса; ограничитель активации считает попытки по адресу и пропускает двадцать
// в минуту с одного. С общего адреса заводились ровно двадцать планшетов из двухсот, и это была
// особенность стенда, а не службы.
const адрес = (i) => '10.77.' + Math.floor(i / 250) + '.' + (i % 250 + 1);

const jar = [];
const post = async (path, body, headers) => {
  const r = await fetch(BASE + path, {
    method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json', cookie: jar.join('; ') }, headers || {}),
    body: JSON.stringify(body), redirect: 'manual'
  });
  const set = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
  set.forEach(c => jar.push(c.split(';')[0]));
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, body: j };
};
const get = async (path) => {
  const r = await fetch(BASE + path, { headers: { cookie: jar.join('; ') } });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, body: j };
};

const мс = () => Number(process.hrtime.bigint() / 1000000n);
const память = () => {
  try {
    // Именно процесс службы, а не оболочка, в командной строке которой попалось это же имя:
    // такая оболочка весит пять мегабайт, и замер показывал их вместо ста тридцати.
    const pid = execSync("pgrep -x dotnet | while read p; do tr '\\0' ' ' < /proc/$p/cmdline | grep -q SignatureKiosk.dll && echo $p; done | head -1").toString().trim();
    if (!pid) return 0;
    const rss = execSync('ps -o rss= -p ' + pid).toString().trim();
    return Math.round(parseInt(rss, 10) / 1024);
  } catch { return 0; }
};

await post('/api/admin/login', { password: PASS });
console.log('вход в админку выполнен');
const базоваяПамять = память();
console.log('память службы до нагрузки: ' + базоваяПамять + ' МБ');

// Документ и реклама, чтобы было что рассылать.
await fetch(BASE + '/api/admin/document', {
  method: 'PUT', headers: { 'Content-Type': 'application/json', cookie: jar.join('; ') },
  body: JSON.stringify({ title: 'НАГРУЗКА', signPrompt: 'x', thankYouText: 'x', idleReturnSec: 0,
    pages: [{ headingRuns: [{ text: 'Условия' }], blocks: [{ runs: [{ text: 'Текст соглашения.' }], ord: 0 }],
      checkboxes: [{ key: 'ok', label: 'Согласен', required: true, ord: 1 }], groups: [], signatures: [], scans: [] }],
    signBlocks: [], signBlocksBelow: [] })
});

// Заводим N планшетов и держим их соединения.
const токены = [];
const t0 = мс();
for (let i = 0; i < N; i++) {
  const e = await post('/api/admin/devices/enroll', { name: 'Планшет ' + (i + 1) });
  const a = await post('/api/kiosk/enroll', { code: e.body.code }, { 'X-Forwarded-For': адрес(i) });
  if (a.status !== 200) console.log('планшет ' + (i + 1) + ': активация вернула ' + a.status);
  токены.push(a.body && a.body.token);
}
console.log('заведено планшетов: ' + токены.filter(Boolean).length + ' за ' + (мс() - t0) + ' мс');

const соединения = [];
const ошибки = [];
const подключить = async (token, i) => {
  const c = new HubConnectionBuilder()
    .withUrl(BASE + '/hub/kiosk?access_token=' + encodeURIComponent(token), {
      transport: HttpTransportType.WebSockets, skipNegotiation: true,
      headers: { 'X-Forwarded-For': адрес(i || 0) } })
    .configureLogging(LogLevel.None)
    .build();
  c.on('ShowSlides', () => { c.__slides = (c.__slides || 0) + 1; });
  c.on('ShowDocument', () => { c.__docs = (c.__docs || 0) + 1; });
  c.on('WatchOn', () => {});
  c.on('WatchOff', () => {});
  c.on('Identify', () => {});
  c.on('StartScan', () => {});
  c.on('StopScan', () => {});
  await c.start();
  await c.invoke('RegisterKiosk');
  return c;
};

// Открытая админка. Она нужна не для украшения счётчиков: на каждое подключение планшета
// рассылается «список изменился», а админка в ответ запрашивает полный список. Двести
// планшетов, поднявшихся разом, дают двести таких кругов, если уведомления не собирать в пачку.
let уведомлений = 0;
const админка = new HubConnectionBuilder()
  .withUrl(BASE + '/hub/kiosk', { headers: { cookie: jar.join('; ') } })
  .configureLogging(LogLevel.None).build();
админка.on('DevicesChanged', () => { уведомлений++; });
админка.on('SignatureAdded', () => {});
админка.on('DocumentShown', () => {});
админка.on('WatchState', () => {});
await админка.start();
await админка.invoke('RegisterAdmin');
console.log('админка подключена');

const t1 = мс();
const пачка = 25;
for (let i = 0; i < токены.length; i += пачка) {
  const часть = токены.slice(i, i + пачка).filter(Boolean);
  const res = await Promise.allSettled(часть.map((t, j) => подключить(t, i + j)));
  res.forEach(r => { if (r.status === 'fulfilled') соединения.push(r.value); else ошибки.push(String(r.reason).slice(0, 80)); });
}
const времяПодключения = мс() - t1;
await new Promise(r => setTimeout(r, 1200));
const уведомленийНаПодключении = уведомлений;
console.log('уведомлений «список изменился» на ' + соединения.length + ' подключений: ' + уведомленийНаПодключении);
console.log('подключено: ' + соединения.length + ' из ' + N + ' за ' + времяПодключения + ' мс' +
  (ошибки.length ? (', ошибок ' + ошибки.length + ': ' + ошибки[0]) : ''));
console.log('память после подключения: ' + память() + ' МБ (прирост ' + (память() - базоваяПамять) + ' МБ)');

// Список планшетов: сколько времени он занимает при 200 подключённых.
const замер = async (что, f, раз) => {
  const t = мс();
  for (let i = 0; i < раз; i++) await f();
  const всего = мс() - t;
  console.log(что + ': ' + раз + ' раз за ' + всего + ' мс, в среднем ' + Math.round(всего / раз) + ' мс');
  return Math.round(всего / раз);
};
const списокМс = await замер('запрос списка планшетов', () => get('/api/admin/devices'), 10);

// Веерная рассылка рекламы на всех.
const before = соединения.reduce((s, c) => s + (c.__slides || 0), 0);
const t2 = мс();
await fetch(BASE + '/api/admin/playlist', {
  method: 'PUT', headers: { 'Content-Type': 'application/json', cookie: jar.join('; ') },
  body: JSON.stringify({ target: 'all', imageIds: [], intervalSec: 6 })
});
await new Promise(r => setTimeout(r, 3000));
const after = соединения.reduce((s, c) => s + (c.__slides || 0), 0);
console.log('веерная рассылка рекламы: дошло до ' + (after - before) + ' из ' + соединения.length +
  ' за ' + (мс() - t2) + ' мс');

// Показ документа на один планшет при 200 подключённых.
const списокУстройств = (await get('/api/admin/devices')).body || [];
const первый = списокУстройств.find(d => d.online);
const t3 = мс();
await post('/api/admin/show-document', { target: 'device:' + первый.id, fields: {} });
await new Promise(r => setTimeout(r, 1500));
const доков = соединения.reduce((s, c) => s + (c.__docs || 0), 0);
console.log('документ на один планшет при ' + соединения.length + ' подключённых: ' + (мс() - t3) +
  ' мс, получателей документа: ' + доков);
if (доков !== 1) console.log('ВНИМАНИЕ: документ получил не один планшет, а ' + доков);

// Массовое переподключение: рвём все и поднимаем заново.
const t4 = мс();
await Promise.allSettled(соединения.map(c => c.stop()));
console.log('все отключены за ' + (мс() - t4) + ' мс');
await new Promise(r => setTimeout(r, 1500));
const памятьПослеОтключения = память();
console.log('память после отключения всех: ' + памятьПослеОтключения + ' МБ');

const t5 = мс();
const снова = [];
for (let i = 0; i < токены.length; i += пачка) {
  const часть = токены.slice(i, i + пачка).filter(Boolean);
  const res = await Promise.allSettled(часть.map((t, j) => подключить(t, i + j)));
  res.forEach(r => { if (r.status === 'fulfilled') снова.push(r.value); });
}
console.log('массовое переподключение: ' + снова.length + ' за ' + (мс() - t5) + ' мс');
await new Promise(r => setTimeout(r, 1200));
console.log('уведомлений «список изменился» за разрыв и переподключение всех: ' + (уведомлений - уведомленийНаПодключении));
console.log('память после переподключения: ' + память() + ' МБ');
const списокМс2 = await замер('запрос списка после переподключения', () => get('/api/admin/devices'), 10);

await Promise.allSettled(снова.map(c => c.stop()));
await админка.stop();
await new Promise(r => setTimeout(r, 2000));
console.log('память в покое: ' + память() + ' МБ');
console.log('\nИТОГ: подключение ' + времяПодключения + ' мс, список ' + списокМс + ' мс, после переподключения ' + списокМс2 + ' мс');
process.exit(0);
