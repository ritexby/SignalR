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
const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
const p = await ctx.newPage();
const jsErr = []; p.on('pageerror', e => jsErr.push(e.message));
p.on('dialog', d => d.accept());
await p.goto(BASE + '/admin/');
await p.fill('#password', 'test123'); await p.click('#loginForm button[type=submit]');
await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
await отказатьсяОтЧерновика(p);

const версияСтраницы = await p.evaluate(() => (document.querySelector('.version') || {}).textContent);
const версияКода = (await (await fetch('http://127.0.0.1:5080/admin/admin.js')).text()).match(/APP_VERSION = "([^"]+)"/)[1];
ok(версияСтраницы === 'v' + версияКода, 'бейдж версии совпадает с APP_VERSION: ' + версияСтраницы + ' и ' + версияКода);

// ---------- Preview ----------
// A template with a condition on ПОЛ, so the preview must prove conditions are applied.
const doc = {
  title: 'Согласие {{ФИО}}', signPrompt: 'Поставьте подпись', thankYouText: 'Спасибо', idleReturnSec: 0,
  pages: [{
    headingRuns: [{ text: 'Данные ' }, { text: 'клиента', bold: true, color: '#dc2626' }],
    blocks: [
      { runs: [{ text: 'ФИО: {{ФИО}}, телефон: {{telephone}}' }] },
      { runs: [{ text: 'Блок для женщин' }], visibleWhen: { field: 'ПОЛ', op: 'eq', value: 'F' } },
      { runs: [{ text: 'Блок для мужчин' }], visibleWhen: { field: 'ПОЛ', op: 'eq', value: 'M' } }
    ],
    checkboxes: [{ label: 'Согласен', required: true, checked: false }]
  },
  { headingRuns: [{ text: 'Трансграничная' }], blocks: [{ runs: [{ text: 'Только при cross-border=да' }] }],
    visibleWhen: { field: 'cross-border', op: 'eq', value: 'да' }, checkboxes: [] }],
  signBlocks: [{ runs: [{ text: 'Реквизиты компании', bold: true }] }]
};
await p.evaluate(async (d) => { await fetch('/api/admin/document', { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(d) }); }, doc);
// Reload so the editor holds the document we just saved (the preview reads the editor state).
await p.reload();
await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
await отказатьсяОтЧерновика(p);
await p.click('.tab[data-tab="document"]');
await p.waitForSelector('[data-panel="document"]:not(.hidden)', { timeout: 4000 });
await p.waitForTimeout(400);

await p.click('#previewDoc');
await p.waitForSelector('.preview-setup', { timeout: 4000 });
const prefilled = await p.evaluate(() => {
  const ins = Array.from(document.querySelectorAll('.preview-setup input[type=text]'));
  return ins.map(i => i.value);
});
ok(prefilled.some(v => /Иванова/.test(v)), 'preview pre-fills sample values: ' + JSON.stringify(prefilled.slice(0, 3)));

// set ПОЛ = F, cross-border = нет
await p.evaluate(() => {
  const labels = Array.from(document.querySelectorAll('.preview-setup label.field'));
  labels.forEach(l => {
    const t = l.childNodes[0] && l.childNodes[0].textContent;
    // Tags with a fixed set of values are dropdowns now, the rest are still text boxes.
    const i = l.querySelector('input, select');
    if (!i) return;
    if (t === 'ПОЛ') i.value = 'F';
    if (t === 'cross-border') i.value = 'нет';
  });
  const ta = document.querySelector('.preview-setup textarea');
  if (ta) ta.value = '+Согласен на рассылку\nВторой пункт';
});
await p.click('.preview-setup .btn-primary');
await p.waitForSelector('.preview-wrap', { timeout: 6000 });
await p.waitForTimeout(300);

const pv = await p.evaluate(() => {
  const body = document.querySelector('.pv-body');
  const heading = document.querySelector('.pv-heading span:nth-child(2)');
  return {
    title: (document.querySelector('.pv-title') || {}).textContent,
    text: body ? body.textContent : '',
    stats: (document.querySelector('.pv-head .sig-meta') || {}).textContent,
    headingColor: heading ? getComputedStyle(heading).color : '',
    checks: document.querySelectorAll('.pv-check').length,
    checkedOnes: document.querySelectorAll('.pv-check.on').length
  };
});
ok(/Иванова/.test(pv.title), 'preview title substituted: ' + pv.title);
ok(/Блок для женщин/.test(pv.text), 'preview shows the F block');
ok(!/Блок для мужчин/.test(pv.text), 'preview hides the M block');
ok(/Страниц показано: 1 из 2/.test(pv.stats || ''), 'preview reports pages shown vs total: ' + pv.stats);
ok(pv.headingColor === 'rgb(220, 38, 38)', 'preview renders the coloured heading run: ' + pv.headingColor);
ok(pv.checks >= 3, 'preview shows template + API checkboxes (' + pv.checks + ')');
ok(pv.checkedOnes >= 1, 'preview marks the API checkbox that arrived checked');

// navigate to the signature screen of the preview
const steps = await p.evaluate(() => document.querySelectorAll('.pv-footer .btn').length);
ok(steps === 2, 'preview has Назад/Далее navigation');
// Предпросмотр теперь ведёт себя как планшет: «Далее» не пускает, пока не отмечено
// обязательное. Отмечаем так же, как это сделал бы клиент.
await p.evaluate(() => {
  document.querySelectorAll('.pv-live input[type=checkbox]').forEach(i => {
    if (!i.checked) { i.checked = true; i.dispatchEvent(new Event('change', { bubbles: true })); }
  });
});
await p.waitForTimeout(300);
await p.click('.pv-footer .btn-primary');
await p.waitForTimeout(300);
const signScreen = await p.evaluate(() => ({
  text: (document.querySelector('.pv-body') || {}).textContent,
  pad: !!document.querySelector('.pv-pad')
}));
ok(/Реквизиты компании/.test(signScreen.text), 'preview signature page shows custom blocks');
ok(signScreen.pad, 'preview signature page shows the signature pad placeholder');
await p.click('#modalClose');

// ---------- Alerts ----------
await p.click('.tab[data-tab="alerts"]');
await p.waitForSelector('[data-panel="alerts"]:not(.hidden)', { timeout: 4000 });
await p.waitForTimeout(500);
await p.click('#testAlert');
await p.waitForTimeout(700);
const alertsShown = await p.evaluate(() => ({
  items: document.querySelectorAll('#alertsList .log-item').length,
  first: (document.querySelector('#alertsList .log-item') || {}).textContent || '',
  badge: (document.getElementById('alertBadge') || {}).textContent,
  badgeHidden: (document.getElementById('alertBadge') || {}).classList.contains('hidden')
}));
ok(alertsShown.items >= 1, 'alerts tab lists the test alert (' + alertsShown.items + ')');
ok(/Тестовое уведомление/.test(alertsShown.first), 'test alert is shown');
ok(!alertsShown.badgeHidden && parseInt(alertsShown.badge, 10) >= 1, 'unread badge shows a count: ' + alertsShown.badge);

// settings round-trip
await p.fill('#alertOffline', '7');
await p.fill('#alertErrCount', '9');
await p.fill('#alertErrWindow', '3');
await p.click('#saveAlertSettings');
await p.waitForTimeout(600);
const saved = await p.evaluate(async () => (await fetch('/api/admin/alerts/settings', { credentials: 'same-origin' })).json());
ok(saved.offlineMinutes === 7 && saved.errorCount === 9 && saved.errorWindowMinutes === 3,
  'alert settings persisted: ' + JSON.stringify(saved));

// acknowledge clears the badge but keeps the alert
await p.click('#ackAlerts');
await p.waitForTimeout(600);
const acked = await p.evaluate(() => ({
  badgeHidden: (document.getElementById('alertBadge') || {}).classList.contains('hidden'),
  items: document.querySelectorAll('#alertsList .log-item').length
}));
ok(acked.badgeHidden, 'badge cleared after acknowledging');
ok(acked.items >= 1, 'acknowledged alert stays visible until its cause clears');

ok(jsErr.length === 0, 'no admin JS errors (' + JSON.stringify(jsErr) + ')');
await p.screenshot({ path: '' + (process.env.SK_RABOTA || '.') + '/shot_alerts.png', fullPage: true });
await browser.close();
console.log(fail === 0 ? '\nV4.4 PREVIEW + ALERTS PASSED' : `\n${fail} CHECK(S) FAILED`);
process.exit(fail === 0 ? 0 : 1);
