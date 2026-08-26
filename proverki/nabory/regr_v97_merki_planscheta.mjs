const BASE = process.env.SK_BASE || 'http://127.0.0.1:5080';
// Наблюдение берёт числа с планшета, а не выводит их по формуле.
//
// Формула повторяет выражения из kiosk.css и знает только про сам документ. Про среду планшета
// она не знает ничего: ни про настройку размера шрифта в системе, ни про поведение WebView, ни
// про ширину, которая осталась телу документа. На этом экраны и разошлись у владельца: значок
// расхождения показал «у клиента иначе: +86 точек содержимого», то есть три лишних переноса.
//
// Здесь среда планшета меняется нарочно так, как формула предсказать не может, и проверяется, что
// наблюдение идёт за настоящими числами.
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
  pages: [{
    headingRuns: [{ text: "2. Информация, необходимая для проведения лабораторного исследования" }],
    inPdf: true,
    blocks: [{ runs: [{ text: "В случае приема препаратов сообщите медицинскому регистратору кодовое слово \"ЛП1\" и назовите название препарата. Например \"ЛП1 - витамины\"" }], ord: 11 }],
    groups: [
      { key: "g0", ord: 10, title: "Прием лекарственных средств, БАДов, гормональных препаратов, химиотерапии, а равно любых иных препаратов, назначенных врачом, в течение последних 2-х недель до дня сдачи биоматериала",
        options: [{ key: "da", label: "ДА" }, { key: "net", label: "НЕТ" }] },
      { key: "g1", ord: 20, title: "С момента последнего мочеиспускания прошло не менее 1,5-2 ч",
        options: [{ key: "da", label: "ДА" }, { key: "net", label: "НЕТ" }] },
      { key: "g2", ord: 21, title: "Взятие биоматериала или осмотр врачом акушером-гинекологом накануне или в день сдачи анализов",
        options: [{ key: "da", label: "ДА" }, { key: "net", label: "НЕТ" }] }
    ],
    checkboxes: [
      { key: "gormony", label: "Гормоны", ord: 12 }, { key: "antibiotiki", label: "Антибиотики", ord: 13 },
      { key: "himio", label: "Химиотерапия", ord: 14 }, { key: "bady", label: "БАДы, витамины", ord: 15 },
      { key: "drugoe", label: "Другое", ord: 16 }
    ] }],
  signBlocks: [], signBlocksBelow: [] }) });
ok(otvet.status === 200, "документ сохранён, иначе меряли бы чужой", String(otvet.status));

const kod = await (await fetch(BASE + "/api/admin/devices/enroll", {
  method: "POST", headers: SH, body: JSON.stringify({ name: "Планшет мерок" }) })).json();
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

const merkaP = () => plan.evaluate(() => {
  const f = document.querySelector(".doc-frame"), b = document.querySelector(".doc-body");
  return { base: Math.round(parseFloat(getComputedStyle(f).fontSize) * 100) / 100,
           bodyW: b.clientWidth, vsego: b.scrollHeight, okno: b.clientHeight,
           zagH: (document.querySelector(".group-title") || {}).offsetHeight || 0,
           zagKegl: document.querySelector(".group-title")
                    ? Math.round(parseFloat(getComputedStyle(document.querySelector(".group-title")).fontSize)) : 0 };
});
const merkaN = () => nabl.evaluate(() => {
  const s = document.querySelector(".watch-screen"), b = document.querySelector(".wt-body");
  const r = document.querySelector(".watch-raznica");
  const g = document.querySelector(".watch-screen .pv-group-title");
  return { base: Math.round(parseFloat(getComputedStyle(s).getPropertyValue("--wt-base")) * 100) / 100,
           bodyW: b.clientWidth, vsego: b.scrollHeight, okno: b.clientHeight,
           zagH: g ? g.offsetHeight : 0,
           zagKegl: g ? Math.round(parseFloat(getComputedStyle(g).fontSize)) : 0,
           raznica: !!(r && !r.classList.contains("hidden")), raznicaTekst: r ? r.textContent : "" };
});

async function sverit(gde) {
  await nabl.waitForTimeout(2200);
  const p = await merkaP(), n = await merkaN();
  console.log("\n== " + gde);
  console.log("  планшет:    " + JSON.stringify(p));
  console.log("  наблюдение: " + JSON.stringify(n));
  ok(Math.abs(p.base - n.base) < 0.6, gde + ": кегль рамки тот же", p.base + " против " + n.base);
  ok(Math.abs(p.bodyW - n.bodyW) <= 2, gde + ": тело документа той же ширины", p.bodyW + " против " + n.bodyW);
  ok(p.zagH > 0 && Math.abs(p.zagH - n.zagH) <= 2, gde + ": длинный заголовок занял столько же строк",
     "высота " + p.zagH + " против " + n.zagH);
  ok(Math.abs(p.vsego - n.vsego) <= 24, gde + ": содержимое той же высоты", p.vsego + " против " + n.vsego);
  ok(!n.raznica, gde + ": значок расхождения молчит", n.raznicaTekst);
  return { p, n };
}

// ===== 1. Как есть.
const b0 = await sverit("обычная среда планшета");
ok(b0.p.zagH > b0.p.zagKegl * 1.8, "заголовок группы переносится, иначе сверять нечего",
   "высота " + b0.p.zagH + " при кегле " + b0.p.zagKegl);

// ===== 2. Среда планшета меняется так, как формула предсказать не может.
// Это подстановка настройки размера шрифта в системе планшета: кегль рамки меняется помимо
// ступени, выбранной клиентом, и никакое выражение из kiosk.css такого не даст.
await plan.evaluate(() => {
  const s = document.createElement("style");
  s.id = "chuzhaya-sreda";
  s.textContent = ".doc-frame { font-size: 23px !important; } .doc-frame { padding: 52px !important; }";
  document.head.appendChild(s);
});
await plan.click(".check");
await plan.waitForTimeout(1800);
const b1 = await sverit("кегль и отступы планшета изменились помимо формулы");
ok(Math.abs(b1.p.base - b0.p.base) > 2, "среда планшета действительно изменилась, иначе проверять нечего",
   b0.p.base + " -> " + b1.p.base);
ok(Math.abs(b1.p.bodyW - b0.p.bodyW) > 20, "и ширина тела тоже", b0.p.bodyW + " -> " + b1.p.bodyW);

// ===== 3. Вернули как было: наблюдение возвращается следом.
await plan.evaluate(() => { const s = document.getElementById("chuzhaya-sreda"); if (s) s.remove(); });
await plan.click(".check");
await plan.waitForTimeout(1800);
await sverit("среда вернулась к обычной");

await br.close();
console.log(provalov ? ("ПРОВАЛОВ: " + provalov) : "ВСЁ ПРОЙДЕНО");
process.exit(provalov ? 1 : 0);
