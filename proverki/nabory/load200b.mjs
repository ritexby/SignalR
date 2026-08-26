// Два вопроса, на которые первый замер не отвечает.
// Первый: сколько на самом деле занимает веерная рассылка. Там она была смешана с моим же
// ожиданием в три секунды, и число не значило ничего.
// Второй: не растёт ли память от цикла к циклу. Один цикл подключения ничего не доказывает:
// утечка на соединении видна только тогда, когда соединения поднимают и роняют несколько раз.
import { HubConnectionBuilder, LogLevel, HttpTransportType } from '@microsoft/signalr';
import { execSync } from 'node:child_process';

const BASE = 'http://127.0.0.1:5080';
const N = 200;
const jar = [];
const post = async (path, body, headers) => {
  const r = await fetch(BASE + path, {
    method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json', cookie: jar.join('; ') }, headers || {}),
    body: JSON.stringify(body), redirect: 'manual'
  });
  (r.headers.getSetCookie ? r.headers.getSetCookie() : []).forEach(c => jar.push(c.split(';')[0]));
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, body: j };
};
const мс = () => Number(process.hrtime.bigint() / 1000000n);
const память = () => {
  try {
    const pid = execSync("pgrep -x dotnet | while read p; do tr '\\0' ' ' < /proc/$p/cmdline | grep -q SignatureKiosk.dll && echo $p; done | head -1").toString().trim();
    return Math.round(parseInt(execSync('ps -o rss= -p ' + pid).toString().trim(), 10) / 1024);
  } catch { return 0; }
};
const адрес = (i) => '10.77.' + Math.floor(i / 250) + '.' + (i % 250 + 1);

await post('/api/admin/login', { password: 'test123' });
const токены = [];
for (let i = 0; i < N; i++) {
  const e = await post('/api/admin/devices/enroll', { name: 'Т' + (i + 1) });
  const a = await post('/api/kiosk/enroll', { code: e.body.code }, { 'X-Forwarded-For': адрес(i) });
  if (a.body && a.body.token) токены.push(a.body.token);
}
console.log('заведено: ' + токены.length);

let приход = [];
const подключить = async (token, i) => {
  const c = new HubConnectionBuilder()
    .withUrl(BASE + '/hub/kiosk?access_token=' + encodeURIComponent(token), {
      transport: HttpTransportType.WebSockets, skipNegotiation: true,
      headers: { 'X-Forwarded-For': адрес(i) } })
    .configureLogging(LogLevel.None).build();
  // Отметка ставится в тот момент, когда сообщение действительно дошло до планшета: только так
  // видно настоящее время рассылки, а не длину моего ожидания.
  c.on('ShowSlides', () => приход.push(мс()));
  c.on('ShowDocument', () => приход.push(мс()));
  ['Identify', 'StartScan', 'StopScan', 'WatchOn', 'WatchOff'].forEach(m => c.on(m, () => {}));
  await c.start();
  await c.invoke('RegisterKiosk');
  return c;
};
const поднять = async () => {
  const все = [];
  for (let i = 0; i < токены.length; i += 25) {
    const r = await Promise.allSettled(токены.slice(i, i + 25).map((t, j) => подключить(t, i + j)));
    r.forEach(x => { if (x.status === 'fulfilled') все.push(x.value); });
  }
  return все;
};

console.log('память до всего: ' + память() + ' МБ');
let соединения = await поднять();
console.log('поднято: ' + соединения.length);

// Настоящее время веерной рассылки: от отправки до прихода последнему планшету.
for (const попытка of [1, 2]) {
  приход = [];
  const t = мс();
  await fetch(BASE + '/api/admin/playlist', {
    method: 'PUT', headers: { 'Content-Type': 'application/json', cookie: jar.join('; ') },
    body: JSON.stringify({ target: 'all', imageIds: [], intervalSec: 5 + попытка })
  });
  const ждать = async () => { for (let k = 0; k < 100; k++) { if (приход.length >= соединения.length) return; await new Promise(r => setTimeout(r, 50)); } };
  await ждать();
  приход.sort((a, b) => a - b);
  console.log('рассылка на ' + соединения.length + ' планшетов, попытка ' + попытка + ': дошло ' + приход.length +
    ', первому за ' + (приход[0] - t) + ' мс, последнему за ' + (приход[приход.length - 1] - t) + ' мс');
}

// Утечка: три круга «подняли двести, уронили двести».
for (let круг = 1; круг <= 3; круг++) {
  await Promise.allSettled(соединения.map(c => c.stop()));
  await new Promise(r => setTimeout(r, 800));
  соединения = await поднять();
  console.log('круг ' + круг + ': поднято ' + соединения.length + ', память ' + память() + ' МБ');
}
await Promise.allSettled(соединения.map(c => c.stop()));
await new Promise(r => setTimeout(r, 3000));
console.log('память после всего, соединений нет: ' + память() + ' МБ');
process.exit(0);
