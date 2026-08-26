import { chromium } from 'playwright';
const BASE = 'http://127.0.0.1:5080';
// Путь к браузеру берётся из окружения: на другой машине он другой, а зашитый путь
// превращал набор в неработающий у всех, кроме одной установки. Пусто значит
// «пусть Playwright возьмёт свой», как он и делает по умолчанию.
const EXE = process.env.SK_CHROME || undefined;
const browser = await chromium.launch({ executablePath: EXE, headless: true });
const ctx = await browser.newContext();
const p = await ctx.newPage();

await p.goto(BASE + '/admin/');
await p.fill('#password', 'test123');
await p.click('#loginForm button[type=submit]');
await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });

// create an enrollment and redeem it -> a device that is OFFLINE (no kiosk connected)
const enr = await p.evaluate(async () => {
  const r = await fetch('/api/admin/devices/enroll', { method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Офлайн-планшет', ttlMinutes: 30 }) });
  return r.json();
});
await p.evaluate(async (code) => {
  await fetch('/api/kiosk/enroll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
}, enr.code);

// go to devices tab and refresh
await p.click('.tab[data-tab="devices"]');
await p.waitForSelector('[data-panel="devices"]:not(.hidden)', { timeout: 4000 });
await p.waitForTimeout(800);

// find every chip and report its text + computed color + class
const chips = await p.evaluate(() => {
  const out = [];
  document.querySelectorAll('#devicesList .dev-item .chip').forEach(c => {
    const cs = getComputedStyle(c);
    out.push({ text: c.textContent.trim(), className: c.className, color: cs.color, background: cs.backgroundColor });
  });
  return out;
});
console.log('CHIPS FOUND:', JSON.stringify(chips, null, 2));

const offline = chips.find(c => c.text === 'офлайн');
if (!offline) { console.log('RESULT: no offline chip found'); }
else {
  // rgb(22,163,74) is the green accent; rgb(107,114,128) is the grey
  const isGreen = /22,\s*163,\s*74/.test(offline.color);
  const isGrey = /107,\s*114,\s*128/.test(offline.color);
  console.log('OFFLINE CHIP color =', offline.color, '| class =', offline.className);
  console.log('VERDICT:', isGreen ? 'ЗЕЛЁНЫЙ (баг)' : isGrey ? 'СЕРЫЙ (правильно)' : 'иной цвет: ' + offline.color);
}
await p.screenshot({ path: '' + (process.env.SK_RABOTA || '.') + '/offline_chip.png' });
await browser.close();
