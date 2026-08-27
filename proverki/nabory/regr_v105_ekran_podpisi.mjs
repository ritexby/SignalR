const BASE = process.env.SK_BASE || 'http://127.0.0.1:5080';
// Экран подписи один в один.
//
// Подсказка значка у владельца: «кусков страницы у клиента 9, здесь 6», «Распишитесь здесь» при
// длине текста 17 и 24, поле подписи 379 против 213, и «Положение НЕ выравнивается: списки кусков
// разошлись, «Распишитесьздесь» против «Клиентещёнерасписался»».
//
// То есть наблюдение писало в поле подписи свою надпись вместо клиентской и считало высоту поля
// заново, а не брало с планшета. Здесь сверяются надпись, высота поля и списки кусков.
import { chromium } from 'playwright';
const EXE = process.env.SK_CHROME || undefined;
let provalov = 0;
const ok = (u, t, z) => { if (u) console.log("PASS " + t); else { provalov++; console.log("FAIL " + t + ": " + (z === undefined ? "" : z)); } };

const vhod = await fetch(BASE + "/api/admin/login", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "test123" }) });
const kuka = (vhod.headers.get("set-cookie") || "").split(";")[0];
const SH = { "Content-Type": "application/json", Cookie: kuka };

await fetch(BASE + "/api/admin/document", { method: "PUT", headers: SH, body: JSON.stringify({
  title: "Соглашение", signPrompt: "Пожалуйста, поставьте вашу подпись в поле ниже",
  thankYouText: "Спасибо", idleReturnSec: 0,
  pages: [{ headingRuns: [{ text: "Страница" }], inPdf: true,
            blocks: [{ ord: 1, runs: [{ text: "Текст данного информационного согласия мною прочитан." }] }],
            checkboxes: [] }],
  signBlocks: [{ ord: 1, runs: [{ text: "Прошу направить СМС о готовности результатов." }] }],
  signBlocksBelow: [] }) });

const kod = await (await fetch(BASE + "/api/admin/devices/enroll", {
  method: "POST", headers: SH, body: JSON.stringify({ name: "Планшет подписи" }) })).json();
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
await nabl.waitForTimeout(2500);

// Клиент доходит до экрана подписи.
await plan.click("#btnNext");
await plan.waitForTimeout(1800);
await nabl.waitForTimeout(2500);

const наПланшете = await plan.evaluate(() => {
  const h = document.querySelector(".sign-hint"), w = document.querySelector(".sign-wrap");
  const p = document.querySelector(".sign-prompt");
  return { подсказка: h ? (h.textContent || "").trim() : "нет",
           поле: w ? Math.round(w.offsetHeight) : 0,
           призыв: p ? (p.textContent || "").trim() : "нет",
           экран: document.querySelector(".doc-body") ? "документ" : "иной" };
});
const уОператора = await nabl.evaluate(() => {
  const и = document.querySelector(".watch-screen .watch-ink");
  const p = document.querySelector(".watch-screen .wt-sign-prompt");
  return { подсказка: и ? (и.textContent || "").trim() : "нет",
           поле: и ? Math.round(и.offsetHeight) : 0,
           призыв: p ? (p.textContent || "").trim() : "нет" };
});
console.log("планшет:    " + JSON.stringify(наПланшете));
console.log("наблюдение: " + JSON.stringify(уОператора));

ok(наПланшете.подсказка !== "нет", "экран подписи открылся на планшете", наПланшете.подсказка);
ok(наПланшете.подсказка === уОператора.подсказка,
   "надпись в поле подписи та же, что видит клиент",
   "«" + наПланшете.подсказка + "» против «" + уОператора.подсказка + "»");
ok(наПланшете.призыв === уОператора.призыв, "призыв над полем тот же",
   "«" + наПланшете.призыв + "» против «" + уОператора.призыв + "»");
ok(наПланшете.поле > 0 && Math.abs(наПланшете.поле - уОператора.поле) <= 4,
   "поле подписи той же высоты", наПланшете.поле + " против " + уОператора.поле);

await br.close();
console.log(provalov ? ("ПРОВАЛОВ: " + provalov) : "ВСЁ ПРОЙДЕНО");
process.exit(provalov ? 1 : 0);
