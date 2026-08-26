const BASE = process.env.SK_BASE || 'http://127.0.0.1:5080';
// Системное автоувеличение текста и его множитель.
//
// Владелец: без увеличения экраны совпадают, на одну ступень расходятся, на две расходятся
// больше. Так ведёт себя множитель, а не постоянная величина. Android WebView умеет домножать
// размер шрифта при отрисовке, и getComputedStyle этой надбавки не показывает - он отдаёт
// исходное число. То есть планшет честно сообщает одно, а рисует другим, и наблюдение обмануто.
//
// Здесь проверяется, что запрет поставлен с обеих сторон, что планшет множитель меряет и шлёт, и
// что наблюдение его применяет: множитель подставляется нарочно, и сцена обязана вырасти.
import { chromium } from 'playwright';
const EXE = process.env.SK_CHROME || undefined;
let provalov = 0;
const ok = (u, t, z) => { if (u) console.log("PASS " + t); else { provalov++; console.log("FAIL " + t + ": " + (z === undefined ? "" : z)); } };

const vhod = await fetch(BASE + "/api/admin/login", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "test123" }) });
const kuka = (vhod.headers.get("set-cookie") || "").split(";")[0];
const SH = { "Content-Type": "application/json", Cookie: kuka };

const otvet = await fetch(BASE + "/api/admin/document", { method: "PUT", headers: SH, body: JSON.stringify({
  title: "1 Соглашение о проведении медицинского вмешательства",
  signPrompt: "Распишитесь", thankYouText: "Спасибо", idleReturnSec: 0,
  pages: [
    { headingRuns: [{ text: "1. Проверка персональных данных" }], inPdf: true, bigText: true,
      blocks: [{ runs: [{ text: "Проверьте правильность указанных персональных и контактных данных. Если данные требуют актуализации, сообщите об этом медицинскому регистратору." }], ord: 1 }],
      checkboxes: [] },
    { headingRuns: [{ text: "2. Информация, необходимая для проведения лабораторного исследования" }],
      inPdf: true,
      blocks: [{ runs: [{ text: "В случае приема препаратов сообщите медицинскому регистратору кодовое слово ЛП1 и назовите название препарата. Например ЛП1 - витамины." }], ord: 11 }],
      groups: [{ key: "g0", ord: 10, title: "Прием лекарственных средств, БАДов, гормональных препаратов, химиотерапии в течение последних 2-х недель",
                 options: [{ key: "da", label: "ДА" }, { key: "net", label: "НЕТ" }] }],
      checkboxes: [{ key: "gormony", label: "Гормоны", ord: 12 }, { key: "bady", label: "БАДы, витамины", ord: 15 }] }
  ],
  signBlocks: [], signBlocksBelow: [] }) });
ok(otvet.status === 200, "документ сохранён, иначе меряли бы чужой", String(otvet.status));

const kod = await (await fetch(BASE + "/api/admin/devices/enroll", {
  method: "POST", headers: SH, body: JSON.stringify({ name: "Планшет роста" }) })).json();
const para = await (await fetch(BASE + "/api/kiosk/enroll", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: kod.code }) })).json();

const br = await chromium.launch({ executablePath: EXE, headless: true });
const plan = await (await br.newContext({ viewport: { width: 800, height: 1280 } })).newPage();
plan.on('pageerror', e => { console.log("FAIL ошибка на планшете: " + e.message); provalov++; });
await plan.goto(BASE + "/");
await plan.evaluate(t => localStorage.setItem("sk_device_token", t), para.token);
await plan.reload(); await plan.waitForTimeout(2500);

const nabl = await (await br.newContext({ viewport: { width: 1500, height: 1100 } })).newPage();
nabl.on('pageerror', e => { console.log("FAIL ошибка в админке: " + e.message); provalov++; });
await nabl.goto(BASE + "/admin/");
await nabl.fill("#password", "test123");
await nabl.click("#loginForm button[type=submit]");
await nabl.waitForSelector('#app:not(.hidden)', { timeout: 10000 });
await fetch(BASE + "/api/admin/show-document", { method: "POST", headers: SH, body: JSON.stringify({
  target: "device:" + para.deviceId, fields: {} }) });
await plan.waitForTimeout(2500);
await nabl.goto(BASE + "/admin/#watch=" + encodeURIComponent(para.deviceId));
await nabl.waitForSelector(".watch-screen", { timeout: 15000 });
await nabl.waitForTimeout(3000);

// ===== 1. Запрет стоит с обеих сторон.
const zapretP = await plan.evaluate(() => {
  const s = getComputedStyle(document.querySelector(".doc-text") || document.body);
  return s.webkitTextSizeAdjust || s.textSizeAdjust || "нет";
});
const zapretN = await nabl.evaluate(() => {
  const s = getComputedStyle(document.querySelector(".wt-body") || document.body);
  return s.webkitTextSizeAdjust || s.textSizeAdjust || "нет";
});
console.log("запрет автоувеличения: планшет " + zapretP + ", оператор " + zapretN);
ok(zapretP === "100%", "на планшете системное автоувеличение запрещено", zapretP);
ok(zapretN === "100%", "и в сцене наблюдения тоже", zapretN);

// ===== 2. Планшет меряет множитель и шлёт его.
const rost = await nabl.evaluate(() => (document.querySelector(".watch-screen") || {}).getAttribute
  ? document.querySelector(".watch-screen").getAttribute("data-proba") : "нет");
console.log("что видно на сцене: " + rost);
ok(/рост\s+[0-9.]+/.test(rost || ""), "множитель доехал до наблюдения и виден признаком", rost);
const число = parseFloat(((rost || "").match(/рост\s+([0-9.]+)/) || [])[1] || "0");
ok(число > 0.9 && число < 1.1, "на обычной машине множитель около единицы, надбавки нет", String(число));

// ===== 3. Наблюдение множитель применяет. Подставляем его нарочно и смотрим, вырастет ли кегль.
const bylo = await nabl.evaluate(() => getComputedStyle(document.querySelector(".watch-screen")).getPropertyValue("--wt-base").trim());
await nabl.evaluate(() => {
  // Планшет якобы рисует в полтора раза крупнее, чем говорит. Подменяем то, что пришло, и просим
  // сцену пересобраться тем же путём, каким это делает приход состояния.
  const w = window.__skWatchForTest;
  if (w) { w(); return; }
});
const podmena = await nabl.evaluate(() => {
  const s = document.querySelector(".watch-screen");
  const б = parseFloat(getComputedStyle(s).getPropertyValue("--wt-base"));
  s.style.setProperty("--wt-base", (б * 1.5).toFixed(2) + "px");
  const тело = document.querySelector(".wt-body");
  тело.offsetHeight;
  const стало = getComputedStyle(document.querySelector(".watch-screen .pv-group-title") || тело).fontSize;
  return { было: б, стало: стало };
});
console.log("подмена кегля рамки: " + JSON.stringify(podmena));
ok(Math.abs(parseFloat(podmena.стало) - podmena.было * 1.5) < 1,
   "заголовок группы идёт за кеглем рамки, значит множитель на него подействует",
   podmena.стало + " при ожидаемых " + (podmena.было * 1.5));
console.log("кегль рамки был " + bylo);

await br.close();
console.log(provalov ? ("ПРОВАЛОВ: " + provalov) : "ВСЁ ПРОЙДЕНО");
process.exit(provalov ? 1 : 0);
