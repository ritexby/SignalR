// Подпись должна оказаться в PDF ровно там, куда её поставили мышью. Проверяем не по коду,
// а по картинке: страница растрируется и смотрим, в какой четверти листа появились чернила.
import { chromium } from 'playwright';
const BASE = 'http://127.0.0.1:5080';
// Путь к браузеру берётся из окружения: на другой машине он другой, а зашитый путь
// превращал набор в неработающий у всех, кроме одной установки. Пусто значит
// «пусть Playwright возьмёт свой», как он и делает по умолчанию.
const EXE = process.env.SK_CHROME || undefined;
const SP = '' + (process.env.SK_RABOTA || '.') + '';
let fail = 0;
const ok = (c, m) => { if (c) console.log('PASS', m); else { console.error('FAIL', m); fail++; } };

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const p = await (await browser.newContext()).newPage();
await p.goto(BASE + '/admin/');
await p.fill('#password', 'test123'); await p.click('#loginForm button[type=submit]');
await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
const call = (path, opts) => p.evaluate(async ([pa, o]) => {
  const r = await fetch('/api/admin' + pa, Object.assign({ credentials: 'same-origin' }, o || {}));
  let b = null; try { b = await r.json(); } catch {} return { status: r.status, body: b };
}, [path, opts]);

// Документ из одной короткой страницы: весь текст остаётся в верхней четверти, поэтому
// чернила в правом нижнем углу могут появиться только от поставленной подписи.
async function поставить(places) {
  return call('/document', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
    title: 'АКТ', signPrompt: 'Распишитесь', thankYouText: 'Спасибо', idleReturnSec: 0,
    pages: [{ headingRuns: [{ text: 'Условия' }], blocks: [{ runs: [{ text: 'Коротко.' }], ord: 0 }],
      checkboxes: [{ key: 'c1', label: 'Согласен', required: true, ord: 1 }], groups: [], signatures: [], scans: [] }],
    signBlocks: [], signBlocksBelow: [], signaturePlacements: places }) });
}

async function подписать() {
  const code = (await call('/devices/enroll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"name":"Планшет"}' })).body.code;
  const kiosk = await (await browser.newContext({ viewport: { width: 800, height: 1200 } })).newPage();
  await kiosk.goto(BASE + '/?enroll=' + encodeURIComponent(code));
  await kiosk.waitForFunction(() => !!localStorage.getItem('sk_device_token'), { timeout: 12000 });
  let id = null;
  for (let i = 0; i < 40; i++) {
    const d = (await call('/devices')).body || []; const on = d.find(x => x.online && !x.usedInTest);
    if (on) { id = on.id; break; }
    await kiosk.waitForTimeout(250);
  }
  await call('/show-document', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ target: 'device:' + id, fields: {} }) });
  await kiosk.waitForSelector('.check', { timeout: 8000 });
  await kiosk.evaluate(() => {
    document.querySelectorAll('.checks .check input').forEach(x => { x.checked = true; x.dispatchEvent(new Event('change', { bubbles: true })); });
    document.getElementById('btnNext').click();
  });
  await kiosk.waitForSelector('.sign-screen canvas', { timeout: 8000 });
  const b = await kiosk.locator('.sign-screen .sign-wrap').boundingBox();
  await kiosk.mouse.move(b.x + 25, b.y + b.height / 2);
  await kiosk.mouse.down();
  await kiosk.mouse.move(b.x + b.width - 30, b.y + b.height / 2 - 20, { steps: 12 });
  await kiosk.mouse.up();
  await kiosk.waitForTimeout(300);
  await kiosk.evaluate(() => document.getElementById('btnSign').click());
  await kiosk.waitForTimeout(2500);
  await kiosk.close();
  const sigs = (await call('/signatures')).body || [];
  return sigs[0];
}

async function чернила(sigId, файл) {
  const bytes = await p.evaluate(async (sid) => {
    const res = await fetch('/api/admin/signatures/' + sid + '/pdf', { credentials: 'same-origin' });
    return Array.from(new Uint8Array(await res.arrayBuffer()));
  }, sigId);
  const fs = await import('fs'); const { execSync } = await import('child_process');
  fs.writeFileSync(SP + '/' + файл, Buffer.from(bytes));
  const out = execSync('python3 ' + SP + '/ink.py ' + SP + '/' + файл + ' 1').toString().trim().split(/\s+/).map(Number);
  return { w: out[0], h: out[1], лв: out[2], пв: out[3], лн: out[4], пн: out[5] };
}

// 1. Подпись в правом нижнем углу.
await поставить([{ key: '', page: 0, x: 0.60, y: 0.78, w: 0.32, h: 0.10 }]);
const s1 = await подписать();
ok(!!s1, 'документ с подписью в правом нижнем углу подписан');
const и1 = await чернила(s1.id, 'stamp-rb.pdf');
ok(и1.пн > 50, 'чернила есть в правом нижнем углу: ' + и1.пн);
ok(и1.лн < 10, 'в левом нижнем пусто: ' + и1.лн);
ok(и1.лв > 50, 'текст документа остался вверху слева: ' + и1.лв);

// 2. Та же подпись, но в левом верхнем углу: чернила должны переехать вслед за координатами.
await поставить([{ key: '', page: 0, x: 0.05, y: 0.30, w: 0.32, h: 0.10 }]);
const s2 = await подписать();
const и2 = await чернила(s2.id, 'stamp-lt.pdf');
ok(и2.пн < 10 && и2.лн < 10, 'внизу листа пусто: ' + и2.лн + '/' + и2.пн);
ok(и2.лв > и1.лв, 'подпись поднялась в левую верхнюю четверть: ' + и2.лв + ' против ' + и1.лв);

// 3. Без раскладки подпись печатается в потоке, сразу под текстом.
await поставить([]);
const s3 = await подписать();
const и3 = await чернила(s3.id, 'stamp-flow.pdf');
ok(и3.лв > 50, 'подпись в потоке осталась в верхней части листа: ' + и3.лв);
ok(и3.пн < 10, 'в правом нижнем углу без раскладки пусто: ' + и3.пн);

await browser.close();
console.log(fail === 0 ? '\nВСЁ ПРОЙДЕНО' : '\n' + fail + ' ПРОВЕРОК УПАЛО');
process.exit(fail === 0 ? 0 : 1);
