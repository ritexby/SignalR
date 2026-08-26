const BASE = process.env.SK_BASE || 'http://127.0.0.1:5080';
// Красная подсветка «не отмечено» в окне наблюдения.
//
// Клиент жмёт «Далее», не отметив обязательный пункт: планшет красит сам пункт рамкой и пишет
// под ним, чего не хватает. У оператора в наблюдении этого не было вовсе, он видел спокойный
// пункт и не понимал, почему человек застрял. Оператор обязан видеть то же, что клиент.
//
// Заодно проверяется, что надписи про обязательные пункты в подвале больше нет ни там, ни там:
// она повторяла то же самое в третий раз и стояла далеко от пункта.
import { chromium } from 'playwright';
const EXE = process.env.SK_CHROME || undefined;
let provalov = 0;
const ok = (u, t, z) => { if (u) console.log("PASS " + t); else { provalov++; console.log("FAIL " + t + ": " + (z === undefined ? "" : z)); } };

const vhod = await fetch(BASE + "/api/admin/login", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "test123" }) });
const kuka = (vhod.headers.get("set-cookie") || "").split(";")[0];
const SH = { "Content-Type": "application/json", Cookie: kuka };

await fetch(BASE + "/api/admin/document", { method: "PUT", headers: SH, body: JSON.stringify({
  title: "Соглашение", signPrompt: "Распишитесь", thankYouText: "Спасибо", idleReturnSec: 0,
  pages: [{
    headingRuns: [{ text: "Согласие" }], inPdf: true,
    blocks: [{ runs: [{ text: "Подписывая данное соглашение, Вы подтверждаете это." }], ord: 0 }],
    checkboxes: [{ key: "soglasie", label: "Я выражаю согласие на медицинское вмешательство.", required: true, ord: 1 }]
  }],
  signBlocks: [], signBlocksBelow: [] }) });

const kod = await (await fetch(BASE + "/api/admin/devices/enroll", {
  method: "POST", headers: SH, body: JSON.stringify({ name: "Планшет подсветки" }) })).json();
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
await nabl.goto(BASE + "/admin/#watch=" + encodeURIComponent("Планшет подсветки"));
await nabl.waitForSelector(".watch-screen", { timeout: 15000 });
await nabl.waitForTimeout(3000);

const naPlanshete = async () => await plan.evaluate(() => {
  const m = document.querySelector(".miss");
  const podval = document.getElementById("footerNote");
  return { pokrasheno: !!m, nadpis: m ? ((m.querySelector(".miss-note") || {}).textContent || "").trim() : "",
           podval: (podval ? podval.textContent : "").trim() };
});
const uOperatora = async () => await nabl.evaluate(() => {
  const m = document.querySelector(".watch-screen .wt-miss");
  const podval = document.querySelector(".watch-screen .wt-note");
  return { pokrasheno: !!m, nadpis: m ? ((m.querySelector(".wt-miss-note") || {}).textContent || "").trim() : "",
           podval: (podval ? podval.textContent : "").trim() };
});

// ===== 1. До нажатия «Далее» краснеть нечему ни там, ни там.
const p0 = await naPlanshete(), o0 = await uOperatora();
console.log("до нажатия: планшет " + JSON.stringify(p0) + ", оператор " + JSON.stringify(o0));
ok(!p0.pokrasheno, "до нажатия на планшете ничего не покрашено", JSON.stringify(p0));
ok(!o0.pokrasheno, "до нажатия у оператора ничего не покрашено", JSON.stringify(o0));

// ===== 2. Надписи в подвале нет: она убрана с обеих сторон.
ok(p0.podval === "", "подвал планшета пуст, надписи про пункты там нет", "«" + p0.podval + "»");
ok(o0.podval === "", "подвал наблюдения тоже пуст", "«" + o0.podval + "»");

// ===== 3. Клиент жмёт «Далее», не отметив обязательный пункт.
await plan.click("#btnNext");
await plan.waitForTimeout(1200);
const p1 = await naPlanshete();
console.log("после нажатия на планшете: " + JSON.stringify(p1));
ok(p1.pokrasheno, "на планшете пункт покраснел", JSON.stringify(p1));
ok(/отметить/i.test(p1.nadpis), "и под ним написано, чего не хватает", p1.nadpis);
ok(p1.podval === "", "и после нажатия подвал пуст: объяснение стоит у самого пункта", "«" + p1.podval + "»");

// ===== 4. ГЛАВНОЕ: то же самое видит оператор.
await nabl.waitForTimeout(1800);
const o1 = await uOperatora();
console.log("после нажатия у оператора: " + JSON.stringify(o1));
ok(o1.pokrasheno, "у оператора пункт тоже покраснел", JSON.stringify(o1));
ok(o1.nadpis === p1.nadpis, "и надпись под ним слово в слово та же, что у клиента",
   "клиент «" + p1.nadpis + "», оператор «" + o1.nadpis + "»");

// Цвет рамки тот же самый, а не «примерно красный».
const cveta = (!p1.pokrasheno || !o1.pokrasheno) ? null : await Promise.all([
  plan.evaluate(() => { const s = getComputedStyle(document.querySelector(".miss")); return [s.borderColor, s.backgroundColor]; }),
  nabl.evaluate(() => { const s = getComputedStyle(document.querySelector(".watch-screen .wt-miss")); return [s.borderColor, s.backgroundColor]; })
]);
if (!cveta) console.log("   .. цвета не сравниваются: красить нечего, выше уже провал");
else {
  console.log("цвета: планшет " + JSON.stringify(cveta[0]) + ", оператор " + JSON.stringify(cveta[1]));
  ok(cveta[0][0] === cveta[1][0] && cveta[0][1] === cveta[1][1],
     "цвет рамки и заливки тот же самый, а не примерно такой", JSON.stringify(cveta));
}

// ===== 5. Клиент отметил: подсветка гаснет у обоих.
await plan.click(".check input[type=checkbox]");
await plan.waitForTimeout(1500);
const p2 = await naPlanshete();
await nabl.waitForTimeout(1800);
const o2 = await uOperatora();
console.log("после отметки: планшет " + JSON.stringify(p2) + ", оператор " + JSON.stringify(o2));
ok(!p2.pokrasheno, "клиент отметил, подсветка на планшете погасла", JSON.stringify(p2));
ok(!o2.pokrasheno, "и у оператора погасла тоже", JSON.stringify(o2));

await br.close();
console.log(provalov ? ("ПРОВАЛОВ: " + provalov) : "ВСЁ ПРОЙДЕНО");
process.exit(provalov ? 1 : 0);
