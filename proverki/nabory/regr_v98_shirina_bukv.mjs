const BASE = process.env.SK_BASE || 'http://127.0.0.1:5080';
// Наблюдение догоняет ширину букв планшета.
//
// Кегли и ширина тела к этому моменту уже совпадают: планшет присылает их числами. Осталось то,
// что не задаётся ни кеглем, ни шрифтом - как система считает ширину каждой буквы. Замер
// владельца: одна и та же строка тем же Roboto того же кегля даёт у планшета одно число, у
// оператора другое, разница около процента. Копится она по буквам, и из-за неё жирные заголовки
// у клиента переносились на две строки, а у оператора влезали в одну: значок расхождения
// показывал «+81 точка содержимого» при полностью совпавших кеглях.
//
// Здесь ширина букв планшета меняется нарочно, и проверяется, что наблюдение идёт следом.
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
    blocks: [
      { runs: [{ text: "В случае приема препаратов сообщите медицинскому регистратору кодовое слово \"ЛП1\" и назовите название препарата. Например \"ЛП1 - витамины\"" }], ord: 11 },
      { runs: [{ text: "При наличии беременности сообщите медицинскому регистратору кодовое слово Б1 и назовите срок в неделях. Например, Б1 = 14. Это нужно, чтобы подобрать порядок взятия биоматериала." }], ord: 22 },
      { runs: [{ text: "Если вы принимаете лекарственные препараты постоянно, назовите их медицинскому регистратору до начала взятия биоматериала, а не после." }], ord: 30 },
      { runs: [{ text: "Результаты исследования будут доступны в личном кабинете, а также могут быть отправлены на указанный вами адрес электронной почты." }], ord: 31 }
    ],
    groups: [
      { key: "g0", ord: 10, title: "Прием лекарственных средств, БАДов, гормональных препаратов, химиотерапии в течение последних 2-х недель",
        options: [{ key: "da", label: "ДА" }, { key: "net", label: "НЕТ" }] },
      { key: "g1", ord: 20, title: "С момента последнего мочеиспускания прошло не менее 1,5-2 ч",
        options: [{ key: "da", label: "ДА" }, { key: "net", label: "НЕТ" }] },
      { key: "g2", ord: 21, title: "Взятие биоматериала или осмотр врачом акушером-гинекологом накануне или в день сдачи анализов",
        options: [{ key: "da", label: "ДА" }, { key: "net", label: "НЕТ" }] }
    ],
    checkboxes: [{ key: "gormony", label: "Гормоны", ord: 12 }, { key: "antibiotiki", label: "Антибиотики", ord: 13 },
                 { key: "himio", label: "Химиотерапия", ord: 14 }, { key: "bady", label: "БАДы, витамины", ord: 15 },
                 { key: "drugoe", label: "Другое", ord: 16 }] }],
  signBlocks: [], signBlocksBelow: [] }) });
ok(otvet.status === 200, "документ сохранён, иначе меряли бы чужой", String(otvet.status));

const kod = await (await fetch(BASE + "/api/admin/devices/enroll", {
  method: "POST", headers: SH, body: JSON.stringify({ name: "Планшет букв" }) })).json();
const para = await (await fetch(BASE + "/api/kiosk/enroll", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: kod.code }) })).json();

const br = await chromium.launch({ executablePath: EXE, headless: true });
const ctx = await br.newContext({ viewport: { width: 800, height: 1280 } });
const plan = await ctx.newPage();
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
await pokazat();
await plan.waitForTimeout(2500);
await nabl.goto(BASE + "/admin/#watch=" + encodeURIComponent(para.deviceId));
await nabl.waitForSelector(".watch-screen", { timeout: 15000 });
await nabl.waitForTimeout(3000);

// Высоты жирных заголовков: именно на них расхождение и видно. Переносится заголовок или нет,
// сразу видно по его высоте.
const merkaP = () => plan.evaluate(() => {
  const b = document.querySelector(".doc-body");
  const z = document.querySelector(".group-title");
  return { zagolovki: Array.prototype.slice.call(document.querySelectorAll(".group-title")).map(u => u.offsetHeight),
           razdel: (document.querySelector(".doc-body h2") || {}).offsetHeight || 0,
           vsego: b.scrollHeight, okno: b.clientHeight,
           interval: z ? getComputedStyle(z).letterSpacing : "нет заголовка",
           vnutriTela: z ? b.contains(z) : false };
});
const merkaN = () => nabl.evaluate(() => {
  const b = document.querySelector(".wt-body");
  const s = document.querySelector(".watch-screen");
  const r = document.querySelector(".watch-raznica");
  return { zagolovki: Array.prototype.slice.call(document.querySelectorAll(".watch-screen .pv-group-title")).map(u => u.offsetHeight),
           razdel: (document.querySelector(".watch-screen .pv-heading") || {}).offsetHeight || 0,
           vsego: b.scrollHeight, okno: b.clientHeight,
           track: getComputedStyle(s).getPropertyValue("--wt-track").trim(),
           proba: s.getAttribute("data-proba") || "нет",
           raznica: !!(r && !r.classList.contains("hidden")), raznicaTekst: r ? r.textContent : "" };
});

async function sverit(gde) {
  await nabl.waitForTimeout(2200);
  const p = await merkaP(), n = await merkaN();
  console.log("\n== " + gde);
  console.log("  планшет:    " + JSON.stringify(p));
  console.log("  наблюдение: " + JSON.stringify(n));
  ok(p.zagolovki.length > 0 && p.zagolovki.length === n.zagolovki.length,
     gde + ": заголовков групп поровну", p.zagolovki.length + " против " + n.zagolovki.length);
  ok(JSON.stringify(p.zagolovki) === JSON.stringify(n.zagolovki),
     gde + ": каждый заголовок занял столько же строк",
     "\n     планшет  " + JSON.stringify(p.zagolovki) + "\n     оператор " + JSON.stringify(n.zagolovki));
  ok(Math.abs(p.razdel - n.razdel) <= 2, gde + ": заголовок раздела той же высоты",
     p.razdel + " против " + n.razdel);
  ok(p.vsego > p.okno + 40, gde + ": содержимое не помещается в окно, иначе меряли бы окно",
     "содержимое " + p.vsego + " при окне " + p.okno);
  ok(Math.abs(p.vsego - n.vsego) <= 24, gde + ": содержимое той же высоты", p.vsego + " против " + n.vsego);
  ok(!n.raznica, gde + ": значок расхождения молчит", n.raznicaTekst);
  return { p, n };
}

// ===== 1. Обычные буквы.
const a0 = await sverit("буквы планшета обычной ширины");
const однаСтрока = Math.min.apply(null, a0.p.zagolovki);
ok(a0.p.zagolovki.some(h => h > однаСтрока * 1.5), "хоть один заголовок переносится, иначе сверять нечего",
   JSON.stringify(a0.p.zagolovki) + ", одна строка это " + однаСтрока);

// ===== 2. Буквы планшета шире. Доля от кегля, а не точки: разница шрифтовых движков растёт
// вместе с кеглем, и подгонка устроена так же. Перезагрузка обязательна: ширина пробной строки
// меряется один раз, подсунуть её задним числом нельзя.
await plan.addInitScript(() => {
  document.addEventListener("DOMContentLoaded", function () {
    var s = document.createElement("style");
    s.textContent = ".doc-frame, .doc-frame * { letter-spacing: 0.04em !important; }";
    document.head.appendChild(s);
  });
});
await plan.reload();
await plan.waitForTimeout(2000);
await pokazat();
await plan.waitForTimeout(2500);
const a1 = await sverit("буквы планшета стали шире");
ok(a1.p.interval !== "normal", "на планшете буквы действительно раздвинулись, иначе проверять нечего",
   a1.p.interval);
ok(parseFloat(a1.n.track) > 0.03, "наблюдение подобрало добавку под эту разницу", a1.n.track);

// ===== 3. Доказательство, что работает именно подгонка: убираем её и смотрим, разойдётся ли.
// Без этого набор зеленел бы и на пустом месте, если бы совпадение брало́сь откуда-то ещё.
// Прямое доказательство: одна и та же строка одного кегля должна выйти одной ширины. Перепадом
// строк это не доказать - строка перескакивает только тогда, когда стоит у самого края, и на
// произвольных данных этого не случается. А ширина видна всегда.
const шир = await nabl.evaluate((строка) => {
  const s = document.querySelector(".watch-screen"), b = document.querySelector(".wt-body");
  const мерить = () => {
    const п = document.createElement("span");
    п.textContent = строка;
    п.style.cssText = "position:absolute;left:-9999px;top:0;visibility:hidden;white-space:nowrap;" +
                      "font-weight:700;font-size:20px";
    b.appendChild(п);
    // offsetWidth: сцена наблюдения сжата преобразованием, рамка отдала бы сжатое число.
    const ш = п.offsetWidth;
    п.remove();
    return ш;
  };
  const было = s.style.getPropertyValue("--wt-track");
  const сПодгонкой = мерить();
  s.style.setProperty("--wt-track", "0em");
  const безПодгонки = мерить();
  s.style.setProperty("--wt-track", было);
  return { сПодгонкой, безПодгонки };
}, "Прием лекарственных средств, БАДов, гормональных препаратов, химиотерапии");
const наПланшете = await plan.evaluate((строка) => {
  const b = document.querySelector(".doc-body");
  const п = document.createElement("span");
  п.textContent = строка;
  п.style.cssText = "position:absolute;left:-9999px;top:0;visibility:hidden;white-space:nowrap;" +
                    "font-weight:700;font-size:20px";
  b.appendChild(п);
  const ш = п.offsetWidth;
  п.remove();
  return ш;
}, "Прием лекарственных средств, БАДов, гормональных препаратов, химиотерапии");
console.log("\nширина одной строки: планшет " + наПланшете
  + ", оператор с подгонкой " + шир.сПодгонкой + ", без подгонки " + шир.безПодгонки);
ok(Math.abs(шир.безПодгонки - наПланшете) > 20,
   "без подгонки ширина строки заметно расходится, иначе доказывать нечего",
   шир.безПодгонки + " против " + наПланшете);
ok(Math.abs(шир.сПодгонкой - наПланшете) <= 2,
   "с подгонкой одна и та же строка выходит одной ширины, значит и переносы будут одни",
   шир.сПодгонкой + " против " + наПланшете);

// ===== 4. Вернули обычные буквы: подгонка уходит сама.
await plan.addInitScript(() => {
  document.addEventListener("DOMContentLoaded", function () {
    var s = document.createElement("style");
    s.textContent = ".doc-frame, .doc-frame * { letter-spacing: normal !important; }";
    document.head.appendChild(s);
  });
});
await plan.reload();
await plan.waitForTimeout(2000);
await pokazat();
await plan.waitForTimeout(2500);
const a2 = await sverit("буквы вернулись к обычным");
ok(Math.abs(parseFloat(a2.n.track)) < 0.01, "добавка вернулась почти к нулю", a2.n.track);

await br.close();
console.log(provalov ? ("ПРОВАЛОВ: " + provalov) : "ВСЁ ПРОЙДЕНО");
process.exit(provalov ? 1 : 0);
