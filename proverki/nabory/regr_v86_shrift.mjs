const BASE = process.env.SK_BASE || 'http://127.0.0.1:5080';
// Один шрифт на планшет и на сторону оператора.
//
// И планшет, и админка просили у системы «шрифт системы» (system-ui). На Android это Roboto, в
// браузере оператора на Windows это Segoe UI. Объявление одно, шрифты разные, ширина букв разная,
// и один и тот же заголовок на планшете умещался в строку, а в окне наблюдения переносился на
// две. Оператор смотрел на экран клиента и видел не то, что клиент.
//
// Здесь оба окна открыты одним и тем же браузером, поэтому расхождение из-за системы не
// воспроизвести. Проверяется то, что проверить можно и нужно: файлы шрифта отдаются, объявление
// подключено к обеим страницам, обе стороны просят именно Roboto, и он действительно применился,
// а не подменился запасным.
import { chromium } from 'playwright';
const EXE = process.env.SK_CHROME || undefined;
let provalov = 0;
const ok = (u, t, z) => { if (u) console.log("PASS " + t); else { provalov++; console.log("FAIL " + t + ": " + (z === undefined ? "" : z)); } };

// ===== 1. Файлы шрифта отдаются службой.
const fayly = ["/fonts/fonts.css", "/fonts/roboto-cyrillic.woff2", "/fonts/roboto-cyrillic-ext.woff2",
               "/fonts/roboto-latin.woff2", "/fonts/roboto-latin-ext.woff2"];
for (const f of fayly) {
  const o = await fetch(BASE + f);
  const dlina = Number(o.headers.get("content-length") || 0);
  ok(o.status === 200 && dlina > 1000, "отдаётся " + f, o.status + ", " + dlina + " байт");
}
const css = await (await fetch(BASE + "/fonts/fonts.css")).text();
ok((css.match(/@font-face/g) || []).length === 4, "в объявлении четыре подмножества",
   String((css.match(/@font-face/g) || []).length));
ok(/font-weight:\s*100 900/.test(css),
   "начертание переменное: один файл на весь разброс насыщенности, а не восемь файлов");

const vhod = await fetch(BASE + "/api/admin/login", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "test123" }) });
const kuka = (vhod.headers.get("set-cookie") || "").split(";")[0];
const SH = { "Content-Type": "application/json", Cookie: kuka };

await fetch(BASE + "/api/admin/document", { method: "PUT", headers: SH, body: JSON.stringify({
  title: "Соглашение", signPrompt: "Распишитесь", thankYouText: "Спасибо", idleReturnSec: 0,
  pages: [{ headingRuns: [{ text: "2. Информация, необходимая для проведения лабораторного исследования" }],
            inPdf: true,
            blocks: [{ runs: [{ text: "Прием лекарственных средств, БАДов, гормональных препаратов" }], ord: 0 }],
            checkboxes: [{ key: "gormony", label: "Гормоны", ord: 1 }] }],
  signBlocks: [], signBlocksBelow: [] }) });

const kod = await (await fetch(BASE + "/api/admin/devices/enroll", {
  method: "POST", headers: SH, body: JSON.stringify({ name: "Планшет шрифта" }) })).json();
const para = await (await fetch(BASE + "/api/kiosk/enroll", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: kod.code }) })).json();

const br = await chromium.launch({ executablePath: EXE, headless: true });
const plan = await (await br.newContext({ viewport: { width: 800, height: 1280 } })).newPage();
await plan.goto(BASE + "/");
await plan.evaluate(t => localStorage.setItem("sk_device_token", t), para.token);
await plan.reload();
await plan.waitForTimeout(2500);

const nabl = await (await br.newContext({ viewport: { width: 1500, height: 1100 } })).newPage();
await nabl.goto(BASE + "/admin/");
await nabl.fill("#password", "test123");
await nabl.click("#loginForm button[type=submit]");
await nabl.waitForSelector('#app:not(.hidden)', { timeout: 10000 });
await fetch(BASE + "/api/admin/show-document", { method: "POST", headers: SH, body: JSON.stringify({
  target: "device:" + para.deviceId, fields: {} }) });
await plan.waitForTimeout(2500);
await nabl.goto(BASE + "/admin/#watch=" + encodeURIComponent("Планшет шрифта"));
await nabl.waitForSelector(".watch-screen", { timeout: 15000 });
await nabl.waitForTimeout(3000);

// ===== 2. Обе стороны просят Roboto и получают его.
const proShrift = (kusok) => {
  const vse = Array.prototype.slice.call(document.querySelectorAll("*"));
  const u = vse.filter(n => (n.textContent || "").indexOf(kusok) >= 0 && n.children.length === 0).pop();
  if (!u) return null;
  const s = getComputedStyle(u);
  // Загружен ли шрифт по-настоящему: document.fonts знает, что применилось, а не что попросили.
  const est = document.fonts && document.fonts.check(s.fontWeight + " " + s.fontSize + " Roboto");
  return { semya: s.fontFamily, pervoe: (s.fontFamily.split(",")[0] || "").replace(/["']/g, "").trim(),
           zagruzhen: !!est, shrift: Math.round(parseFloat(s.fontSize) * 10) / 10 };
};
const naPlanshete = await plan.evaluate(proShrift, "Информация, необходимая");
const uOperatora = await nabl.evaluate(proShrift, "Информация, необходимая");
console.log("на планшете:  " + JSON.stringify(naPlanshete));
console.log("у оператора:  " + JSON.stringify(uOperatora));

ok(naPlanshete && naPlanshete.pervoe === "Roboto", "планшет просит Roboto первым", JSON.stringify(naPlanshete));
ok(uOperatora && uOperatora.pervoe === "Roboto", "сцена наблюдения просит Roboto первым", JSON.stringify(uOperatora));
ok(naPlanshete && naPlanshete.zagruzhen, "на планшете Roboto действительно загрузился, а не подменился запасным");
ok(uOperatora && uOperatora.zagruzhen, "у оператора Roboto действительно загрузился");
ok(naPlanshete && uOperatora && naPlanshete.semya === uOperatora.semya,
   "обе стороны просят один и тот же список шрифтов",
   JSON.stringify([naPlanshete && naPlanshete.semya, uOperatora && uOperatora.semya]));

// ===== 3. Остальная админка своего шрифта не меняет: она к планшету отношения не имеет.
const shapka = await nabl.evaluate(() => {
  const u = document.querySelector(".topbar") || document.body;
  return (getComputedStyle(u).fontFamily.split(",")[0] || "").replace(/["']/g, "").trim();
});
console.log("шапка админки: " + shapka);
ok(shapka !== "Roboto", "шапка админки осталась на своём шрифте", shapka);

await br.close();
console.log(provalov ? ("ПРОВАЛОВ: " + provalov) : "ВСЁ ПРОЙДЕНО");
process.exit(provalov ? 1 : 0);
