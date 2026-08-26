const BASE = process.env.SK_BASE || 'http://127.0.0.1:5080';
// Куски страницы стоят там же, где у клиента, даже когда переносы разошлись.
//
// Кегли, ширина и текст у владельца совпадают - подсказка значка это подтвердила словами «при том
// же кегле, ширине и тексте». Расходится только перенос строк, и это разница шрифтовых движков:
// у клиента Android, у оператора настольный браузер. Вёрсткой её выровнять не вышло: пробовали
// точную геометрию букв, запрет автоувеличения и одно правило переноса вместо двух.
//
// Поэтому выравнивается не перенос, а положение: планшет присылает высоту, на которой стоит
// каждый кусок, наблюдение подгоняет верхний отступ. Здесь перенос у оператора ломается нарочно,
// и проверяется, что пункты всё равно стоят на своих местах и ничего не потерялось.
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
    blocks: [{ ord: 11, runs: [{ text: "В случае приема препаратов сообщите медицинскому регистратору кодовое слово \"ЛП1\" и назовите название препарата. Например \"ЛП1 - витамины\"" }] }],
    groups: [
      { key: "g0", ord: 10, title: "Прием лекарственных средств, БАДов, гормональных препаратов, химиотерапии  в течение последних 2-х недель",
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
  method: "POST", headers: SH, body: JSON.stringify({ name: "Планшет положений" }) })).json();
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
const pokazat = () => fetch(BASE + "/api/admin/show-document", { method: "POST", headers: SH,
  body: JSON.stringify({ target: "device:" + para.deviceId, fields: {} }) });
await pokazat(); await plan.waitForTimeout(2500);
await nabl.goto(BASE + "/admin/#watch=" + encodeURIComponent(para.deviceId));
await nabl.waitForSelector(".watch-screen", { timeout: 15000 });
await nabl.waitForTimeout(3000);

// Положения кусков от первого: сравнивать надо именно их, а не отступ от края окна.
const положения = (телоИмя) => {
  var тело = document.querySelector(телоИмя);
  if (!тело) return [];
  var узел = тело;
  while (узел && узел.children && узел.children.length === 1) узел = узел.children[0];
  var из = [], первый = null;
  for (var i = 0; i < узел.children.length && i < 40; i++) {
    var д = узел.children[i];
    if (первый === null) первый = д.offsetTop;
    из.push({ t: (д.textContent || "").replace(/\s+/g, " ").trim().slice(0, 16),
              y: Math.round(д.offsetTop - первый), h: Math.round(д.offsetHeight) });
  }
  return из;
};
const виднаЛиВесьТекст = () => nabl.evaluate(() => {
  // Ни один кусок не должен быть обрезан: выравнивание двигает пустое место, а не режет текст.
  var плохо = [];
  Array.prototype.slice.call(document.querySelectorAll(".wt-body *")).forEach(function (u) {
    if (u.scrollHeight - u.clientHeight > 2 && getComputedStyle(u).overflow !== "visible")
      плохо.push((u.className || "?") + " " + u.scrollHeight + ">" + u.clientHeight);
  });
  return плохо;
});

async function сверить(гдe) {
  await nabl.waitForTimeout(2000);
  const p = await plan.evaluate(положения, ".doc-body");
  const n = await nabl.evaluate(положения, ".wt-body");
  const плохие = [];
  for (let i = 0; i < Math.min(p.length, n.length); i++)
    if (Math.abs(p[i].y - n[i].y) > 2) плохие.push("«" + p[i].t + "» " + p[i].y + " против " + n[i].y);
  console.log("\n== " + гдe + ", кусков " + p.length + " и " + n.length);
  if (плохие.length) плохие.forEach(с => console.log("   " + с));
  ok(p.length === n.length, гдe + ": кусков поровну", p.length + " против " + n.length);
  ok(плохие.length === 0, гдe + ": каждый кусок стоит на своём месте", "\n     " + плохие.join("\n     "));
  const обрезано = await виднаЛиВесьТекст();
  ok(обрезано.length === 0, гдe + ": ничего не обрезано и не спрятано", обрезано.join("; "));
}

await сверить("как есть");

// Ломаем перенос только у оператора: именно это и делает чужой шрифтовый движок.
await nabl.evaluate(() => {
  const s = document.createElement("style");
  s.id = "chuzhoy-dvizhok";
  // Внутренний отступ, а не межбуквенное расстояние: он сужает строку, не меняя ширины куска, и
  // потому даёт ровно ту беду, ради которой всё затевалось - тот же текст, та же ширина, другой
  // перенос. Межбуквенное здесь не годилось: заголовок как был в две строки, так и остался.
  s.textContent = ".watch-screen .pv-group-title { padding-right: 520px !important; }";
  document.head.appendChild(s);
});
await plan.click(".check");
await plan.waitForTimeout(1800);
const после = await сверить("перенос у оператора сломан нарочно");

// И убеждаемся, что ломка вправду сработала: иначе проверка ничего не значит.
const высоты = await nabl.evaluate(() => {
  const g = document.querySelector(".watch-screen .pv-group-title");
  return g ? g.offsetHeight : 0;
});
const высотыП = await plan.evaluate(() => {
  const g = document.querySelector(".group-title");
  return g ? g.offsetHeight : 0;
});
console.log("\nзаголовок группы: планшет " + высотыП + ", оператор " + высоты);
ok(высоты !== высотыП, "переносы действительно разошлись, иначе выравнивать было бы нечего",
   высотыП + " и " + высоты);

await br.close();
console.log(provalov ? ("ПРОВАЛОВ: " + provalov) : "ВСЁ ПРОЙДЕНО");
process.exit(provalov ? 1 : 0);
