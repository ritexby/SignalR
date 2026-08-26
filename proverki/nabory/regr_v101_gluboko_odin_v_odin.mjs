const BASE = process.env.SK_BASE || 'http://127.0.0.1:5080';
// Один в один вглубь: каждый кусок страницы и каждая его часть, на каждой ступени размера.
//
// Прежние наборы сверяли куски целиком и общую высоту. Владелец же на 9.6 показал остаток:
// «2. Информация, нео» 108 против 112, «Прием лекарственны» 217 против 220, «Взятие биоматериал»
// 219 против 169. То есть расходится ВНУТРИ кусков, а этого прежние наборы не видели.
//
// Здесь страница взята с его снимков слово в слово, и сверяются высоты и ширины всех кусков и их
// частей на всех пяти положениях размера.
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
      blocks: [{ ord: 1, runs: [
        { text: "Пожалуйста, проверьте правильность указанных персональных и контактных данных. Если данные требуют актуализации или вы обнаружили ошибку, сообщите об этом медицинскому регистратору\n\n" },
        { text: "ФИО: ", bold: true, sizePt: 14 }, { text: "Иванов Иван Иванович\n" },
        { text: "Дата рождения: ", bold: true, sizePt: 14 }, { text: "01.01.1980\n" },
        { text: "Пол: ", bold: true, sizePt: 14 }, { text: "Мужской\n" },
        { text: "Контактный телефон: ", bold: true, sizePt: 14 }, { text: "+375291234567\n" },
        { text: "E-mail: ", bold: true, sizePt: 14 }, { text: "ivanov.ivan@example.com" }
      ] }],
      checkboxes: [] },
    { headingRuns: [{ text: "2. Информация, необходимая для проведения лабораторного исследования" }],
      inPdf: true,
      blocks: [
        { ord: 11, runs: [{ text: "В случае приема препаратов сообщите медицинскому регистратору кодовое слово \"ЛП1\" и назовите название препарата. Например \"ЛП1 - витамины\"" }] },
        { ord: 23, runs: [{ text: "При наличии беременности сообщите медицинскому регистратору кодовое слово Б1 и назовите срок в неделях. Например, Б1 = 14" }] }
      ],
      groups: [
        { key: "g0", ord: 10, title: "Прием лекарственных средств, БАДов, гормональных препаратов, химиотерапии  в течение последних 2-х недель",
          options: [{ key: "da", label: "ДА" }, { key: "net", label: "НЕТ" }] },
        { key: "g1", ord: 20, title: "С момента последнего мочеиспускания прошло не менее 1,5-2 ч",
          options: [{ key: "da", label: "ДА" }, { key: "net", label: "НЕТ" }] },
        { key: "g2", ord: 21, title: "Взятие биоматериала или осмотр врачом акушером-гинекологом накануне или в день сдачи анализов",
          options: [{ key: "da", label: "ДА" }, { key: "net", label: "НЕТ" }] },
        { key: "g3", ord: 22, title: "Девственность",
          options: [{ key: "da", label: "ДА" }, { key: "net", label: "НЕТ" }] }
      ],
      checkboxes: [
        { key: "gormony", label: "Гормоны", ord: 12 }, { key: "antibiotiki", label: "Антибиотики", ord: 13 },
        { key: "himio", label: "Химиотерапия", ord: 14 }, { key: "bady", label: "БАДы, витамины", ord: 15 },
        { key: "drugoe", label: "Другое", ord: 16 }
      ] }
  ],
  signBlocks: [], signBlocksBelow: [] }) });
ok(otvet.status === 200, "документ сохранён, иначе меряли бы чужой", String(otvet.status));

const kod = await (await fetch(BASE + "/api/admin/devices/enroll", {
  method: "POST", headers: SH, body: JSON.stringify({ name: "Планшет вглубь" }) })).json();
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

// Тот же обход, что в изделии: один уровень вглубь.
const обход = (телоИмя) => {
  var тело = document.querySelector(телоИмя);
  if (!тело) return [];
  var узел = тело;
  while (узел && узел.children && узел.children.length === 1) узел = узел.children[0];
  var из = [];
  for (var i = 0; i < узел.children.length && i < 40; i++) {
    var д = узел.children[i];
    из.push({ t: (д.textContent || "").replace(/\s+/g, " ").trim().slice(0, 18),
              h: Math.round(д.offsetHeight), w: Math.round(д.offsetWidth) });
    if (из.length < 60 && д.children && д.children.length > 1 && д.children.length <= 6) {
      for (var j = 0; j < д.children.length; j++) {
        var в = д.children[j];
        из.push({ t: "  " + (в.textContent || "").replace(/\s+/g, " ").trim().slice(0, 16),
                  h: Math.round(в.offsetHeight), w: Math.round(в.offsetWidth) });
      }
    }
  }
  return из;
};

async function сверить(гдe) {
  await nabl.waitForTimeout(2000);
  const p = await plan.evaluate(обход, ".doc-body");
  const n = await nabl.evaluate(обход, ".wt-body");
  const расхождения = [];
  const меньше = Math.min(p.length, n.length);
  for (let i = 0; i < меньше; i++) {
    if (Math.abs(p[i].h - n[i].h) > 2 || Math.abs(p[i].w - n[i].w) > 2)
      расхождения.push("«" + p[i].t + "» " + p[i].h + "x" + p[i].w + " против " + n[i].h + "x" + n[i].w);
  }
  console.log("\n== " + гдe + ", кусков " + p.length + " и " + n.length);
  if (расхождения.length) расхождения.forEach(с => console.log("   " + с));
  ok(p.length === n.length, гдe + ": кусков поровну", p.length + " против " + n.length);
  ok(расхождения.length === 0, гдe + ": все куски совпали", "\n     " + расхождения.join("\n     "));
}

const жать = async () => {
  const можно = await plan.evaluate(() => { const k = document.getElementById("bigTextPlus"); return !!(k && !k.disabled); });
  if (!можно) return false;
  await plan.click("#bigTextPlus"); await plan.waitForTimeout(450); return true;
};
const наСтраницу2 = async () => { await plan.click("#btnNext"); await plan.waitForTimeout(1600); };
const назад = async () => { await plan.click(".doc-footer .btn-ghost"); await plan.waitForTimeout(1600); };

await сверить("страница 1, обычный размер");
await наСтраницу2(); await сверить("страница 2, обычный размер"); await назад();
for (const ступень of [1, 2, 3, 4]) {
  if (!(await жать())) break;
  await сверить("страница 1, ступень " + ступень);
  await наСтраницу2();
  await сверить("страница 2, ступень " + ступень);
  await назад();
}

await br.close();
console.log(provalov ? ("ПРОВАЛОВ: " + provalov) : "ВСЁ ПРОЙДЕНО");
process.exit(provalov ? 1 : 0);
