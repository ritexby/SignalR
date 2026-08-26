// Горизонтальная прокрутка на планшете: содержимое шире экрана. Ищем, что именно вылезает.
import { chromium } from 'playwright';
const BASE = 'http://127.0.0.1:5080';
// Путь к браузеру берётся из окружения: на другой машине он другой, а зашитый путь
// превращал набор в неработающий у всех, кроме одной установки. Пусто значит
// «пусть Playwright возьмёт свой», как он и делает по умолчанию.
const EXE = process.env.SK_CHROME || undefined;
const browser = await chromium.launch({ executablePath: EXE, headless: true });
const admin = await (await browser.newContext()).newPage();
await admin.goto(BASE + '/admin/');
await admin.fill('#password', 'test123'); await admin.click('#loginForm button[type=submit]');
await admin.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
const call = (path, opts) => admin.evaluate(async ([pa, o]) => {
  const r = await fetch('/api/admin' + pa, Object.assign({ credentials: 'same-origin' }, o || {}));
  let b = null; try { b = await r.json(); } catch {} return b;
}, [path, opts]);
await call('/document', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
  title: 'ИНФОРМАЦИОННОЕ СОГЛАШЕНИЕ О ПРЕДОСТАВЛЕНИИ МЕДИЦИНСКИХ УСЛУГ', signPrompt: 'Пожалуйста, поставьте вашу подпись в поле ниже', thankYouText: 'Спасибо! Ваша подпись принята.', idleReturnSec: 0,
  pages: [{ headingRuns: [{ text: '1. Проверка персональных данных и согласие на их обработку' }],
    blocks: [{ runs: [{ text: 'Пациент: Иванова Анна Петровна, 01.01.1990, anna.ivanova.petrovna@example-laboratory.by, г. Минск, ул. Первомайская, дом 129а корпус 2, квартира 145' }], ord: 0 },
             { runs: [{ text: 'Взятие биоматериала из урогенитального тракта на лабораторное исследование у женщин включает в себя проведение манипуляции из цервикального канала, уретры и заднего свода влагалища.' }], ord: 1 }],
    checkboxes: [{ key: 'c1', label: 'ДА / НЕТ Я согласен получать СМС-уведомления о готовности результатов анализов на указанный номер телефона и использовать его как приоритетный способ связи', required: true, ord: 2 }],
    groups: [{ key: 'g1', title: 'Трансграничная передача данных за пределы Республики Беларусь', required: false, ord: 3,
      options: [{ key: 'a', label: 'Разрешаю' }, { key: 'b', label: 'Запрещаю' }] }] }],
  signBlocks: [], signBlocksBelow: [] }) });
const e = await call('/devices/enroll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"name":"Планшет"}' });

for (const [w, h, имя] of [[800, 1280, 'портрет 800'], [1280, 800, 'альбом 1280'], [600, 1024, 'узкий 600'], [1200, 1920, 'крупный портрет']]) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2 });
  const k = await ctx.newPage();
  await k.goto(BASE + '/?enroll=' + encodeURIComponent(e.code));
  await k.waitForFunction(() => !!localStorage.getItem('sk_device_token'), { timeout: 12000 }).catch(() => {});
  let id = null;
  for (let i = 0; i < 40; i++) {
    const d = await call('/devices'); const on = (d || []).find(x => x.online);
    if (on) { id = on.id; break; }
    await k.waitForTimeout(250);
  }
  if (id) {
    await call('/show-document', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: 'device:' + id, fields: {} }) });
    await k.waitForSelector('.doc-body', { timeout: 8000 }).catch(() => {});
  }
  await k.waitForTimeout(400);
  const cont = await k.evaluate(() => {
    const out = [];
    document.querySelectorAll('body *').forEach(el => {
      const st = getComputedStyle(el);
      const прокручивается = /auto|scroll/.test(st.overflowX) || /auto|scroll/.test(st.overflow);
      if (el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0)
        out.push({ cls: (el.className || el.tagName).toString().slice(0, 40),
          scrollW: el.scrollWidth, clientW: el.clientWidth,
          overflowX: st.overflowX, touch: st.touchAction, прокручивается: прокручивается });
    });
    return out.slice(0, 8);
  });
  if (cont.length) console.log('  контейнеры шире себя: ' + JSON.stringify(cont));
  const r = await k.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const out = [];
    document.querySelectorAll('body *').forEach(el => {
      const st = getComputedStyle(el);
      if (st.display === 'none' || st.visibility === 'hidden') return;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0) return;
      if (rect.right > vw + 1 || rect.left < -1)
        out.push({ cls: (el.className || el.tagName).toString().slice(0, 40), left: Math.round(rect.left), right: Math.round(rect.right), w: Math.round(rect.width) });
    });
    return { vw, scrollW: document.documentElement.scrollWidth, bodyScrollW: document.body.scrollWidth,
      прокрутка: document.documentElement.scrollWidth > vw, нарушители: out.slice(0, 6) };
  });
  console.log(имя + ': ' + JSON.stringify(r));
  await ctx.close();
}
await browser.close();
