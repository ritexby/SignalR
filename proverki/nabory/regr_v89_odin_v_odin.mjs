const BASE = process.env.SK_BASE || 'http://127.0.0.1:5080';
// Один в один: что на планшете, то и в наблюдении.
//
// Владелец показал парой снимков: при одинаковой прокрутке на планшете виден весь блок
// «Девственность» с двумя отметками и строкой под ним, а у оператора те же отметки обрезаны
// краем сцены. Значит содержимое у оператора выше или окно ниже, и оператор смотрит не на то,
// на что смотрит клиент.
//
// Здесь меряются числа, а не впечатление: высота содержимого, высота окна и подвала, положение
// прокрутки, и главное - совпадает ли набор элементов, попавших в видимую часть.
import { chromium } from 'playwright';
const EXE = process.env.SK_CHROME || undefined;
let provalov = 0;
const ok = (u, t, z) => { if (u) console.log("PASS " + t); else { provalov++; console.log("FAIL " + t + ": " + (z === undefined ? "" : z)); } };

const vhod = await fetch(BASE + "/api/admin/login", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "test123" }) });
const kuka = (vhod.headers.get("set-cookie") || "").split(";")[0];
const SH = { "Content-Type": "application/json", Cookie: kuka };

// Страница как у владельца: пары ДА/НЕТ, длинные надписи, пояснения между ними.
const gruppy = [
  ["Прием лекарственных средств, БАДов, гормональных препаратов, химиотерапии в течение последних 2-х недель", 10],
  ["С момента последнего мочеиспускания прошло не менее 1,5-2 ч", 20],
  ["Взятие биоматериала или осмотр врачом акушером-гинекологом накануне или в день сдачи анализов", 21],
  ["Девственность", 22]
].map(([t, o], i) => ({ key: "g" + i, title: t, ord: o,
  options: [{ key: "da", label: "ДА" }, { key: "net", label: "НЕТ" }] }));

await fetch(BASE + "/api/admin/document", { method: "PUT", headers: SH, body: JSON.stringify({
  title: "1 Соглашение о проведении медицинского вмешательства",
  signPrompt: "Распишитесь", thankYouText: "Спасибо", idleReturnSec: 0,
  pages: [{
    headingRuns: [{ text: "2. Информация, необходимая для проведения лабораторного исследования" }],
    inPdf: true,
    blocks: [
      { runs: [{ text: "В случае приема препаратов сообщите медицинскому регистратору кодовое слово ЛП1 и назовите название препарата. Например ЛП1 - витамины" }], ord: 11 },
      { runs: [{ text: "При наличии беременности сообщите медицинскому регистратору кодовое слово Б1 и назовите срок в неделях. Например, Б1 = 14" }], ord: 23 }
    ],
    groups: gruppy,
    checkboxes: [
      { key: "gormony", label: "Гормоны", ord: 12 },
      { key: "antibiotiki", label: "Антибиотики", ord: 13 },
      { key: "himio", label: "Химиотерапия", ord: 14 },
      { key: "bady", label: "БАДы, витамины", ord: 15 },
      { key: "drugoe", label: "Другое", ord: 16 },
      { key: "lishnee1", label: "Ещё один пункт для высоты страницы", ord: 17 },
      { key: "lishnee2", label: "И ещё один пункт для высоты страницы", ord: 18 },
      { key: "lishnee3", label: "И третий пункт для высоты страницы", ord: 19 },
      { key: "dostavka", required: true, ord: 24,
        label: "Доставка приносного материала произведена самостоятельно в пробирке или контейнере, позволяющем провести соответствующее исследование." }
    ]
  }],
  signBlocks: [], signBlocksBelow: [] }) }).then(async o => {
  // Прежде эта проверка отсутствовала, служба отвечала 400 с пустым телом, документ не
  // сохранялся, а набор мерил чужой и зеленел на пустом месте.
  const t = await o.text();
  ok(o.status === 200, "документ сохранён, иначе меряли бы чужой", o.status + " " + t.slice(0, 160));
});

const kod = await (await fetch(BASE + "/api/admin/devices/enroll", {
  method: "POST", headers: SH, body: JSON.stringify({ name: "Планшет один в один" }) })).json();
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
await nabl.goto(BASE + "/admin/#watch=" + encodeURIComponent("Планшет один в один"));
await nabl.waitForSelector(".watch-screen", { timeout: 15000 });
await nabl.waitForTimeout(3000);

// Что попало в видимую часть: берём только надписи, чтобы сравнивать смысл, а не разметку.
const chtoVidno = (imena) => {
  const telo = imena.telo, punkt = imena.punkt;
  const b = document.querySelector(telo);
  const r = b.getBoundingClientRect();
  const vidno = Array.prototype.slice.call(b.querySelectorAll(punkt))
    .filter(u => { const a = u.getBoundingClientRect(); return a.top >= r.top - 2 && a.bottom <= r.bottom + 2; })
    .map(u => (u.textContent || "").replace(/\s+/g, "").trim().slice(0, 26));
  const noga = document.querySelector(telo === ".doc-body" ? ".doc-footer" : ".wt-foot");
  // offsetHeight, а не рамка: сцена наблюдения сжата преобразованием 0.815, и рамка отдавала
  // сжатые числа. Прежде набор из-за этого сообщал о разнице подвала 71 против 57, которой нет:
  // 71 * 0.815 = 58. Раскладочные свойства сжатию не подвержены.
  return { verh: Math.round(b.scrollTop), vsego: Math.round(b.scrollHeight), okno: Math.round(b.clientHeight),
           podval: noga ? noga.offsetHeight : 0, vidno: vidno };
};
const merkaP = () => plan.evaluate(chtoVidno, { telo: ".doc-body", punkt: ".check, .group" });
const merkaN = () => nabl.evaluate(chtoVidno, { telo: ".wt-body", punkt: ".watch-check, .pv-group" });

async function sverit(gde) {
  await nabl.waitForTimeout(1800);
  const p = await merkaP(), n = await merkaN();
  console.log("\n== " + gde);
  console.log("  планшет:    прокрутка " + p.verh + ", содержимое " + p.vsego + ", окно " + p.okno + ", подвал " + p.podval);
  console.log("  наблюдение: прокрутка " + n.verh + ", содержимое " + n.vsego + ", окно " + n.okno + ", подвал " + n.podval);
  ok(Math.abs(p.okno - n.okno) <= 8, gde + ": окно той же высоты", p.okno + " против " + n.okno);
  ok(Math.abs(p.podval - n.podval) <= 8, gde + ": подвал той же высоты", p.podval + " против " + n.podval);
  ok(Math.abs(p.vsego - n.vsego) <= 24, gde + ": содержимое той же высоты", p.vsego + " против " + n.vsego);
  ok(Math.abs(p.verh - n.verh) <= 24, gde + ": прокрутка на том же месте", p.verh + " против " + n.verh);
  const odinakovo = JSON.stringify(p.vidno) === JSON.stringify(n.vidno);
  ok(odinakovo, gde + ": целиком видно одно и то же",
     "\n     планшет  " + JSON.stringify(p.vidno) + "\n     оператор " + JSON.stringify(n.vidno));
  return { p: p, n: n };
}

// Без этого набор проходит на пустом месте: если всё умещается, «видно одно и то же»
// выполняется само собой.
const dlinnee = await plan.evaluate(() => { const b = document.querySelector(".doc-body");
  return Math.round(b.scrollHeight - b.clientHeight); });
console.log("на планшете можно отлистать: " + dlinnee);
ok(dlinnee > 150, "страница длиннее экрана, иначе сверять нечего", String(dlinnee));

await sverit("страница только открыта");
await plan.evaluate(() => { const b = document.querySelector(".doc-body"); b.scrollTop = b.scrollHeight; });
await sverit("клиент отлистал вниз");

// Красная подсветка: надпись обязана уходить под текст пункта, а не теснить его вбок.
await plan.evaluate(() => { const b = document.querySelector(".doc-body"); b.scrollTop = 0; });
await plan.click("#btnNext");
await plan.waitForTimeout(1500);
await nabl.waitForTimeout(2000);
const stroki = await Promise.all([
  plan.evaluate(() => {
    const m = document.querySelector(".miss");
    if (!m) return null;
    const n = m.querySelector(".miss-note"), l = m.querySelector(".label") || m.lastElementChild;
    return { podNadpisyu: !!(n && l && n.getBoundingClientRect().top >= l.getBoundingClientRect().bottom - 4) };
  }),
  nabl.evaluate(() => {
    const m = document.querySelector(".watch-screen .wt-miss");
    if (!m) return null;
    const n = m.querySelector(".wt-miss-note"), l = m.querySelector(".watch-label");
    return { podNadpisyu: !!(n && l && n.getBoundingClientRect().top >= l.getBoundingClientRect().bottom - 4) };
  })
]);
console.log("\nкрасная надпись под текстом пункта: планшет " + JSON.stringify(stroki[0]) + ", оператор " + JSON.stringify(stroki[1]));
ok(stroki[0] && stroki[0].podNadpisyu, "на планшете надпись стоит под текстом пункта", JSON.stringify(stroki[0]));
ok(stroki[1] && stroki[1].podNadpisyu, "и у оператора она тоже под текстом, а не сбоку", JSON.stringify(stroki[1]));

await br.close();
console.log(provalov ? ("ПРОВАЛОВ: " + provalov) : "ВСЁ ПРОЙДЕНО");
process.exit(provalov ? 1 : 0);
