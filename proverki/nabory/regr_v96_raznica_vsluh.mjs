const BASE = process.env.SK_BASE || 'http://127.0.0.1:5080';
// Расхождение с планшетом не должно быть молчаливым.
//
// Ширину букв считает система, а системы разные: замер владельца дал 781 точку на строку там, где
// планшет даёт 772, это 1,17%. Заголовок, который у клиента не влез в строку, у оператора влезает,
// и нижние пункты стоят не на одном месте. Причину мы убрали (text-rendering: geometricPrecision),
// но полагаться на то, что убрали везде и навсегда, нельзя.
//
// Поэтому наблюдение сверяет высоту нарисованного с той, что прислал планшет, и при расхождении
// говорит об этом прямо. Здесь проверяется, что оно молчит, когда совпало, и говорит, когда нет.
import { chromium } from 'playwright';
const EXE = process.env.SK_CHROME || undefined;
let provalov = 0;
const ok = (u, t, z) => { if (u) console.log("PASS " + t); else { provalov++; console.log("FAIL " + t + ": " + (z === undefined ? "" : z)); } };

const vhod = await fetch(BASE + "/api/admin/login", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "test123" }) });
const kuka = (vhod.headers.get("set-cookie") || "").split(";")[0];
const SH = { "Content-Type": "application/json", Cookie: kuka };

const abzacy = (n) => { const o = []; for (let i = 1; i <= n; i++) o.push({ runs: [{ text: "Абзац " + i + ". Текст для высоты страницы, чтобы её было куда листать и с чем сверять." }], ord: i }); return o; };
const otvet = await fetch(BASE + "/api/admin/document", { method: "PUT", headers: SH, body: JSON.stringify({
  title: "1 Соглашение о проведении медицинского вмешательства",
  signPrompt: "Распишитесь", thankYouText: "Спасибо", idleReturnSec: 0,
  pages: [{ headingRuns: [{ text: "2. Информация" }], inPdf: true, blocks: abzacy(34),
            checkboxes: [{ key: "gormony", label: "Гормоны", ord: 10 }, { key: "bady", label: "БАДы, витамины", ord: 11 }] }],
  signBlocks: [], signBlocksBelow: [] }) });
ok(otvet.status === 200, "документ сохранён, иначе меряли бы чужой", String(otvet.status));

const kod = await (await fetch(BASE + "/api/admin/devices/enroll", {
  method: "POST", headers: SH, body: JSON.stringify({ name: "Планшет разницы" }) })).json();
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

const znak = () => nabl.evaluate(() => {
  const u = document.querySelector(".watch-raznica");
  if (!u) return { est: false };
  return { est: true, vidno: !u.classList.contains("hidden"), tekst: u.textContent || "", podskazka: u.title || "" };
});

// ===== 1. Совпало: значок молчит.
const z0 = await znak();
console.log("когда совпало: " + JSON.stringify(z0));
ok(z0.est, "значок расхождения существует в шапке окна");
ok(!z0.vidno, "и он молчит, пока нарисованное совпадает с планшетом", z0.tekst);

// Без этого набор проходит на пустом месте: если страница короткая, расхождения не будет никогда.
const dlinnee = await plan.evaluate(() => { const b = document.querySelector(".doc-body"); return Math.round(b.scrollHeight - b.clientHeight); });
ok(dlinnee > 100, "страница длиннее экрана, иначе сверять нечего", String(dlinnee));

// ===== 2. Разошлось: значок говорит, и говорит числом.
// Портим кегль только у оператора: это и есть та беда, ради которой сверка заведена.
await nabl.evaluate(() => {
  const s = document.createElement("style");
  s.id = "porcha";
  s.textContent = ".watch-screen .pv-text { font-size: 46px !important; }";
  document.head.appendChild(s);
});
// Перерисовка идёт по состоянию планшета: отмечаем пункт и ждём.
await plan.click(".check");
await plan.waitForTimeout(1800);
await nabl.waitForTimeout(2200);
const z1 = await znak();
console.log("когда разошлось: " + JSON.stringify(z1));
ok(z1.vidno, "значок сказал о расхождении, а не смолчал", JSON.stringify(z1));
ok(/-?\d+\s*точек/.test(z1.tekst), "и сказал числом, а не общими словами", z1.tekst);
ok(/Содержимое страницы у клиента \d+ точек, здесь \d+/.test(z1.podskazka),
   "в подсказке обе высоты названы прямо", z1.podskazka);
// Общее число говорит «расходится на столько-то», а чинить надо место. Подсказка обязана назвать
// кусок страницы: без этого владелец и я снова гадали бы, что именно поехало.
ok(/Расходятся: «[^»]+»: у клиента \d+, здесь \d+/.test(z1.podskazka),
   "и названо, какой именно кусок страницы разошёлся и на сколько", z1.podskazka);
// Одно наведение мышью обязано давать все числа сразу: кегли, ширину тела, пробу букв, добавку и
// рост. Иначе разбираться придётся перепиской и снимками, как это и было.
ok(/Кегли: у клиента [\d.?]+ и [\d.?]+, здесь [\d.?]+ и [\d.?]+/.test(z1.podskazka),
   "в подсказке названы кегли обеих сторон", z1.podskazka);
ok(/Проба букв: [\d.?]+ и [\d.?]+, добавка [-\d.]+em, рост [\d.?]+/.test(z1.podskazka),
   "и проба букв с добавкой и ростом", z1.podskazka);

// ===== 3. Починили: значок снова молчит.
await nabl.evaluate(() => { const s = document.getElementById("porcha"); if (s) s.remove(); });
await plan.click(".check");
await plan.waitForTimeout(1800);
await nabl.waitForTimeout(2200);
const z2 = await znak();
console.log("после починки: " + JSON.stringify(z2));
ok(!z2.vidno, "как только сошлось, значок замолчал сам", z2.tekst);

await br.close();
console.log(provalov ? ("ПРОВАЛОВ: " + provalov) : "ВСЁ ПРОЙДЕНО");
process.exit(provalov ? 1 : 0);
