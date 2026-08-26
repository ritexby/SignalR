// Крупная подпись при наблюдении. Проверяем и размер того, что уходит на сервер, и то, что
// планшет не переподключается и не начинает документ заново.
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
await p.goto(BASE + '/admin/');
await p.fill('#password', 'test123'); await p.click('#loginForm button[type=submit]');
await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
const call = (path, opts) => p.evaluate(async ([pa, o]) => {
  const r = await fetch('/api/admin' + pa, Object.assign({ credentials: 'same-origin' }, o || {}));
  let b = null; try { b = await r.json(); } catch {} return { status: r.status, body: b };
}, [path, opts]);

await call('/document', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
  title: 'СОГЛАСИЕ', signPrompt: 'Распишитесь', thankYouText: 'Спасибо, документ подписан', idleReturnSec: 0,
  pages: [{ headingRuns: [{ text: 'Условия' }], blocks: [{ runs: [{ text: 'Текст.' }], ord: 0 }],
    checkboxes: [{ key: 'ok', label: 'Согласен', required: true, ord: 1 }], groups: [], signatures: [], scans: [] }],
  signBlocks: [], signBlocksBelow: [] }) });

// Планшет крупный, как настоящий: подпись на нём тяжелее.
const code = (await call('/devices/enroll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"name":"Крупный планшет"}' })).body.code;
const kioskCtx = await browser.newContext({ viewport: { width: 1600, height: 2560 }, deviceScaleFactor: 2 });
// Счётчик соединений ставится ДО загрузки страницы: иначе SignalR успевает взять ссылку на
// настоящий WebSocket, и подмена уже ничего не видит.
await kioskCtx.addInitScript(() => {
  window.__sockets = 0; window.__closes = [];
  const Orig = window.WebSocket;
  function Spy(url, protocols) {
    window.__sockets++;
    const s = protocols === undefined ? new Orig(url) : new Orig(url, protocols);
    s.addEventListener('close', e => window.__closes.push({ code: e.code, reason: String(e.reason || '').slice(0, 120) }));
    return s;
  }
  Spy.prototype = Orig.prototype;
  Object.setPrototypeOf(Spy, Orig);
  window.WebSocket = Spy;
});
const kiosk = await kioskCtx.newPage();
await kiosk.goto(BASE + '/?enroll=' + encodeURIComponent(code));
await kiosk.waitForFunction(() => !!localStorage.getItem('sk_device_token'), { timeout: 12000 });
let id = null;
for (let i = 0; i < 40; i++) {
  const d = (await call('/devices')).body || []; const on = d.find(x => x.online);
  if (on) { id = on.id; break; }
  await kiosk.waitForTimeout(250);
}

// Считаем, сколько весит то, что планшет шлёт наблюдателю, и ловим переподключения.

await p.click('[data-tab="devices"]'); await p.waitForTimeout(900);
const [окно] = await Promise.all([
  p.context().waitForEvent('page', { timeout: 15000 }),
  p.locator('.dev-item button', { hasText: 'Смотреть' }).first().click()
]);
await окно.waitForLoadState();
await окно.waitForSelector('.watch-screen', { timeout: 15000 });
await call('/show-document', { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ target: 'device:' + id, fields: {} }) });
await kiosk.waitForSelector('.check', { timeout: 8000 });
await kiosk.evaluate(() => {
  document.querySelectorAll('.checks .check input').forEach(x => { x.checked = true; x.dispatchEvent(new Event('change', { bubbles: true })); });
  document.getElementById('btnNext').click();
});
await kiosk.waitForSelector('.sign-screen canvas', { timeout: 8000 });

// Размашистая подпись во всё поле, в несколько штрихов: так расписывается живой человек.
const b = await kiosk.locator('.sign-screen .sign-wrap').boundingBox();
for (let s = 0; s < 6; s++) {
  await kiosk.mouse.move(b.x + 20 + s * 12, b.y + b.height * 0.75);
  await kiosk.mouse.down();
  for (let i = 0; i <= 24; i++) {
    const t = i / 24;
    await kiosk.mouse.move(b.x + 20 + s * 12 + t * (b.width - 60),
      b.y + b.height * (0.75 - 0.5 * Math.sin(t * Math.PI + s)));
  }
  await kiosk.mouse.up();
}
await kiosk.waitForTimeout(1200);

const вес = await kiosk.evaluate(() => {
  const pad = window.__padForTest;
  const png = pad && !pad.isEmpty() ? pad.toDataURL('image/png') : '';
  return { картинка: png.length, пусто: !png };
});
ok(!вес.пусто, 'подпись нарисована');
console.log('вес картинки подписи: ' + Math.round(вес.картинка / 1024) + ' КБ');
ok(вес.картинка > 32 * 1024, 'она крупнее предела сообщения SignalR в 32 КБ: ' + Math.round(вес.картинка / 1024) + ' КБ');

const доПодписи = await kiosk.evaluate(() => window.__sockets);
// Ещё до нажатия «Подписать»: планшет должен оставаться на экране подписи.
const передНажатием = await kiosk.evaluate(() => ({
  кнопкаЕсть: !!document.getElementById('btnSign'),
  перваяСтраница: !!document.querySelector('.checks .check'),
  переподключений: window.__sockets,
  закрытия: window.__closes,
  текст: document.body.textContent.replace(/\s+/g, ' ').slice(0, 120)
}));
console.log('перед нажатием: ' + JSON.stringify(передНажатием));
ok(передНажатием.кнопкаЕсть, 'планшет остался на экране подписи после того, как клиент расписался');
ok(!передНажатием.перваяСтраница, 'и не выбросило на первую страницу');
ok(передНажатием.переподключений === доПодписи, 'соединение не рвалось от крупной подписи: было ' + доПодписи + ', стало ' + передНажатием.переподключений);
if (!передНажатием.кнопкаЕсть) {
  console.log('\nБАГ ВОСПРОИЗВЁЛСЯ: планшет ушёл с экрана подписи сам');
  await browser.close();
  process.exit(1);
}
await kiosk.evaluate(() => document.getElementById('btnSign').click());
await kiosk.waitForTimeout(4000);

const итог = await kiosk.evaluate(() => ({
  текст: document.body.textContent.replace(/\s+/g, ' ').slice(0, 200),
  перваяСтраница: !!document.querySelector('.checks .check'),
  переподключений: window.__sockets
}));
console.log('соединений до подписи: ' + доПодписи + ', после: ' + итог.переподключений);
ok(!итог.перваяСтраница, 'документ не начался заново: ' + итог.текст.slice(0, 90));
ok(итог.переподключений === доПодписи, 'соединение не рвалось: было ' + доПодписи + ', стало ' + итог.переподключений);
ok(/Спасибо, документ подписан/.test(итог.текст), 'показано «Спасибо»');

await browser.close();
console.log(fail === 0 ? '\nВСЁ ПРОЙДЕНО' : '\n' + fail + ' ПРОВЕРОК УПАЛО');
process.exit(fail === 0 ? 0 : 1);
