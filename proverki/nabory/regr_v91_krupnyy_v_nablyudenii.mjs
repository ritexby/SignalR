const BASE = process.env.SK_BASE || 'http://127.0.0.1:5080';
// Крупный текст, выбранный клиентом, в окне наблюдения.
//
// Клиент увеличивает размер на первой странице своим значком и переходит дальше. Планшет с этого
// момента рисует весь документ крупно, на всех страницах. Оператор обязан видеть тот же документ,
// что и клиент, иначе он смотрит на другой экран: у него текст помещается, а у клиента нет, и
// нижние пункты уезжают за край.
import { chromium } from 'playwright';
const EXE = process.env.SK_CHROME || undefined;
let provalov = 0;
const ok = (u, t, z) => { if (u) console.log("PASS " + t); else { provalov++; console.log("FAIL " + t + ": " + (z === undefined ? "" : z)); } };

const vhod = await fetch(BASE + "/api/admin/login", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "test123" }) });
const kuka = (vhod.headers.get("set-cookie") || "").split(";")[0];
const SH = { "Content-Type": "application/json", Cookie: kuka };

const abzacy = (n) => { const o = []; for (let i = 1; i <= n; i++) o.push({ runs: [{ text: "Абзац " + i + ". Текст для высоты страницы, чтобы её было куда листать." }], ord: i }); return o; };
await fetch(BASE + "/api/admin/document", { method: "PUT", headers: SH, body: JSON.stringify({
  title: "1 Соглашение о проведении медицинского вмешательства",
  signPrompt: "Распишитесь", thankYouText: "Спасибо", idleReturnSec: 0,
  pages: [
    // Первая: с управлением размером, как задумано владельцем.
    { headingRuns: [{ text: "1. Проверка персональных данных" }], inPdf: true, bigText: true,
      blocks: abzacy(2), checkboxes: [] },
    // Вторая: та, на которой владелец увидел расхождение.
    { headingRuns: [{ text: "2. Информация, необходимая для проведения лабораторного исследования" }],
      inPdf: true, blocks: abzacy(4),
      groups: [{ key: "g0", title: "С момента последнего мочеиспускания прошло не менее 1,5-2 ч", ord: 20,
                 options: [{ key: "da", label: "ДА" }, { key: "net", label: "НЕТ" }] }],
      checkboxes: [{ key: "gormony", label: "Гормоны", ord: 10 }, { key: "bady", label: "БАДы, витамины", ord: 11 }] }
  ],
  signBlocks: [], signBlocksBelow: [] }) });

const kod = await (await fetch(BASE + "/api/admin/devices/enroll", {
  method: "POST", headers: SH, body: JSON.stringify({ name: "Планшет крупного" }) })).json();
const para = await (await fetch(BASE + "/api/kiosk/enroll", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: kod.code }) })).json();

const br = await chromium.launch({ executablePath: EXE, headless: true });
const plan = await (await br.newContext({ viewport: { width: 800, height: 1280 } })).newPage();
plan.on('pageerror', e => { console.log("FAIL ошибка на планшете: " + e.message); provalov++; });
await plan.goto(BASE + "/");
await plan.evaluate(t => localStorage.setItem("sk_device_token", t), para.token);
await plan.reload();
await plan.waitForTimeout(2500);

const nabl = await (await br.newContext({ viewport: { width: 1500, height: 1100 } })).newPage();
nabl.on('pageerror', e => { console.log("FAIL ошибка в админке: " + e.message); provalov++; });
await nabl.goto(BASE + "/admin/");
await nabl.fill("#password", "test123");
await nabl.click("#loginForm button[type=submit]");
await nabl.waitForSelector('#app:not(.hidden)', { timeout: 10000 });
await fetch(BASE + "/api/admin/show-document", { method: "POST", headers: SH, body: JSON.stringify({
  target: "device:" + para.deviceId, fields: {} }) });
await plan.waitForTimeout(2500);
await nabl.goto(BASE + "/admin/#watch=" + encodeURIComponent("Планшет крупного"));
await nabl.waitForSelector(".watch-screen", { timeout: 15000 });
await nabl.waitForTimeout(3000);

// Кегль основного текста и высота содержимого. offsetHeight и computed font-size преобразованию
// сцены не подвержены, в отличие от рамки.
const merkaP = () => plan.evaluate(() => {
  const t = document.querySelector(".doc-text") || document.querySelector(".doc-body p") || document.querySelector(".doc-body div");
  const b = document.querySelector(".doc-body");
  return { shrift: t ? Math.round(parseFloat(getComputedStyle(t).fontSize) * 10) / 10 : 0,
           vsego: b.scrollHeight, okno: b.clientHeight };
});
const merkaN = () => nabl.evaluate(() => {
  const t = document.querySelector(".watch-screen .pv-text") || document.querySelector(".wt-body div");
  const b = document.querySelector(".wt-body");
  const s = document.querySelector(".watch-screen");
  return { shrift: t ? Math.round(parseFloat(getComputedStyle(t).fontSize) * 10) / 10 : 0,
           vsego: b.scrollHeight, okno: b.clientHeight,
           wtText: getComputedStyle(s).getPropertyValue("--wt-text").trim(),
           wtBase: getComputedStyle(s).getPropertyValue("--wt-base").trim() };
});

// ===== 1. Обычный размер: кегли и высоты совпадают.
const p0 = await merkaP(), n0 = await merkaN();
console.log("обычный размер: планшет " + JSON.stringify(p0) + ", оператор " + JSON.stringify(n0));
ok(Math.abs(p0.shrift - n0.shrift) < 0.6, "при обычном размере кегль совпадает", p0.shrift + " против " + n0.shrift);
ok(Math.abs(p0.okno - n0.okno) <= 8,
   "и окно под содержимое той же высоты: значок размера занимает место у обоих",
   "планшет " + p0.okno + ", оператор " + n0.okno);

// ===== 2. Клиент увеличивает размер до упора.
const estZnachok = await plan.evaluate(() => !!document.getElementById("bigTextPlus"));
ok(estZnachok, "значок размера на первой странице есть");
for (let i = 0; i < 5; i++) {
  const mozhno = await plan.evaluate(() => { const k = document.getElementById("bigTextPlus"); return !!(k && !k.disabled); });
  if (!mozhno) break;
  await plan.click("#bigTextPlus");
  await plan.waitForTimeout(450);
}
await nabl.waitForTimeout(2200);
const p1 = await merkaP(), n1 = await merkaN();
console.log("после увеличения, страница 1: планшет " + JSON.stringify(p1) + ", оператор " + JSON.stringify(n1));
ok(p1.shrift > p0.shrift + 2, "на планшете текст действительно вырос, иначе проверять нечего",
   p0.shrift + " -> " + p1.shrift);
ok(Math.abs(p1.shrift - n1.shrift) < 0.6,
   "и у оператора он вырос так же", "планшет " + p1.shrift + ", оператор " + n1.shrift);
ok(Math.abs(p1.okno - n1.okno) <= 8,
   "и окно осталось той же высоты после увеличения",
   "планшет " + p1.okno + ", оператор " + n1.okno);

// ===== 3. ГЛАВНОЕ: клиент уходит на вторую страницу. Крупный размер держится на всём документе.
await plan.click("#btnNext");
await plan.waitForTimeout(1800);
await nabl.waitForTimeout(2200);
const p2 = await merkaP(), n2 = await merkaN();
console.log("после перехода на страницу 2: планшет " + JSON.stringify(p2) + ", оператор " + JSON.stringify(n2));
const gde2 = await plan.evaluate(() => (document.querySelector(".doc-body") || {}).innerText || "");
ok(/Информация, необходимая/.test(gde2), "перешли на вторую страницу", gde2.slice(0, 50));
ok(p2.shrift > p0.shrift + 2, "на планшете крупный размер держится и на второй странице",
   "обычный " + p0.shrift + ", сейчас " + p2.shrift);
ok(Math.abs(p2.shrift - n2.shrift) < 0.6,
   "и у оператора на второй странице тот же крупный кегль",
   "планшет " + p2.shrift + ", оператор " + n2.shrift);
ok(Math.abs(p2.vsego - n2.vsego) <= 24,
   "и содержимое той же высоты, значит ничего не уехало",
   "планшет " + p2.vsego + ", оператор " + n2.vsego);

await br.close();
console.log(provalov ? ("ПРОВАЛОВ: " + provalov) : "ВСЁ ПРОЙДЕНО");
process.exit(provalov ? 1 : 0);
