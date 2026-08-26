const BASE = process.env.SK_BASE || 'http://127.0.0.1:5080';
// Шрифт документа обязан доезжать до браузера оператора.
//
// Владелец прислал снимки, где основной текст ломается на строки одинаково, а заголовок группы
// по-разному: у планшета после «гормональных», у оператора после «препаратов,». Одинаковый кегль
// при разной ширине букв это признак другого шрифта, а не другого размера.
//
// Планшет на Android рисует Roboto и без загрузки: это его системный шрифт. Браузер оператора на
// Windows при неудаче берёт Segoe UI, буквы у него уже, и в строку влезает больше. Оператор видит
// не то, что клиент, и никто из них об этом не узнаёт.
//
// Поэтому файлы шрифта проверяются отдельно: отдаются ли, тем ли типом, той ли длины, и объявлены
// ли на обеих страницах.
import { chromium } from 'playwright';
const EXE = process.env.SK_CHROME || undefined;
let provalov = 0;
const ok = (u, t, z) => { if (u) console.log("PASS " + t); else { provalov++; console.log("FAIL " + t + ": " + (z === undefined ? "" : z)); } };

// ===== 1. Сами файлы.
const kuski = ["roboto-cyrillic", "roboto-latin", "roboto-cyrillic-ext", "roboto-latin-ext"];
for (const k of kuski) {
  const o = await fetch(BASE + "/fonts/" + k + ".woff2");
  const dlina = (await o.arrayBuffer()).byteLength;
  const tip = o.headers.get("content-type") || "";
  ok(o.status === 200, k + ": отдаётся", String(o.status));
  ok(dlina > 10000, k + ": не пустой", dlina + " байт");
  ok(/font\/woff2/.test(tip), k + ": отдаётся типом font/woff2, иначе браузер его отвергнет", tip || "типа нет");
}

// ===== 2. Объявление.
const opis = await (await fetch(BASE + "/fonts/fonts.css")).text();
ok(/font-family:\s*'Roboto'/.test(opis), "в fonts.css объявлен Roboto");
ok((opis.match(/@font-face/g) || []).length === 4, "объявлены все четыре куска",
   String((opis.match(/@font-face/g) || []).length));

// ===== 3. Обе страницы его просят.
for (const [gde, adres] of [["страница планшета", "/"], ["страница оператора", "/admin/"]]) {
  const html = await (await fetch(BASE + adres)).text();
  ok(/fonts\.css/.test(html), gde + " подключает fonts.css",
     html.match(/<link[^>]*\.css[^>]*>/g) || "ссылок на css нет вовсе");
}

// ===== 4. Главное: браузер оператора действительно рисует тем же шрифтом, что планшет.
//
// Проверять надо не «загружен ли», а «той же ли ширины буквы»: перенос строки определяется
// шириной, и именно по нему владелец увидел расхождение. Мерка одна на обе стороны: одинаковая
// строка, одинаковое объявление шрифта, одинаковый кегль.
//
// Открывать наблюдение обязательно: Roboto в админке объявлен только для сцены (admin.css),
// и до её появления браузеру он не нужен, поэтому не загружен. Замер без входа врёт.
const vhod = await fetch(BASE + "/api/admin/login", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "test123" }) });
const kuka = (vhod.headers.get("set-cookie") || "").split(";")[0];
const SH = { "Content-Type": "application/json", Cookie: kuka };
await fetch(BASE + "/api/admin/document", { method: "PUT", headers: SH, body: JSON.stringify({
  title: "1 Соглашение о проведении медицинского вмешательства", signPrompt: "П", thankYouText: "С", idleReturnSec: 0,
  pages: [{ headingRuns: [{ text: "2. Информация" }], inPdf: true,
    blocks: [{ runs: [{ text: "В случае приема препаратов сообщите медицинскому регистратору кодовое слово ЛП1" }], ord: 1 }],
    groups: [{ key: "g0", ord: 2, title: "Прием лекарственных средств, БАДов, гормональных препаратов, химиотерапии в течение последних 2-х недель",
               options: [{ key: "da", label: "ДА" }, { key: "net", label: "НЕТ" }] }],
    checkboxes: [{ key: "a", label: "Гормоны", ord: 3 }] }],
  signBlocks: [], signBlocksBelow: [] }) });
const kod = await (await fetch(BASE + "/api/admin/devices/enroll", {
  method: "POST", headers: SH, body: JSON.stringify({ name: "Планшет шрифта" }) })).json();
const para = await (await fetch(BASE + "/api/kiosk/enroll", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: kod.code }) })).json();

const br = await chromium.launch({ executablePath: EXE, headless: true });
const plan = await (await br.newContext({ viewport: { width: 800, height: 1280 } })).newPage();
await plan.goto(BASE + "/");
await plan.evaluate(t => localStorage.setItem("sk_device_token", t), para.token);
await plan.reload(); await plan.waitForTimeout(2500);
const nabl = await (await br.newContext({ viewport: { width: 1500, height: 1100 } })).newPage();
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

const merkaShrifta = () => {
  const p = document.createElement("span");
  p.textContent = "Прием лекарственных средств, БАДов, гормональных препаратов, химиотерапии";
  p.style.cssText = "position:absolute;left:-9999px;top:0;visibility:hidden;white-space:nowrap;" +
                    "font-weight:700;font-size:20px;font-family:'Roboto',system-ui,-apple-system,'Segoe UI',sans-serif";
  document.body.appendChild(p);
  const w = Math.round(p.getBoundingClientRect().width * 100) / 100;
  p.remove();
  return { shirina: w, zagruzhen: document.fonts.check("700 20px Roboto") };
};
const shP = await plan.evaluate(merkaShrifta), shN = await nabl.evaluate(merkaShrifta);
console.log("ширина одной строки: планшет " + JSON.stringify(shP) + ", оператор " + JSON.stringify(shN));
ok(shP.zagruzhen, "на планшете Roboto загружен", String(shP.zagruzhen));
ok(shN.zagruzhen, "у оператора Roboto загружен", String(shN.zagruzhen));
ok(Math.abs(shP.shirina - shN.shirina) < 1,
   "одна и та же строка одного кегля одной ширины, значит шрифт один и переносы совпадут",
   "планшет " + shP.shirina + ", оператор " + shN.shirina);

// И то же самое на настоящем заголовке группы, а не на пробнике.
const nastoyashiy = (im) => {
  const u = document.querySelector(im);
  if (!u) return null;
  const s = getComputedStyle(u);
  return { kegl: s.fontSize, semya: s.fontFamily.split(",")[0].replace(/['"]/g, ""),
           strok: Math.round(u.getBoundingClientRect().height / parseFloat(s.lineHeight || s.fontSize)) };
};
const zP = await plan.evaluate(nastoyashiy, ".group-title");
const zN = await nabl.evaluate(nastoyashiy, ".watch-screen .pv-group-title");
console.log("заголовок группы: планшет " + JSON.stringify(zP) + ", оператор " + JSON.stringify(zN));
ok(zP && zN, "заголовок группы нашёлся с обеих сторон", JSON.stringify(zP) + " / " + JSON.stringify(zN));
ok(zP && zN && zP.semya === zN.semya, "и просит он один и тот же шрифт",
   (zP || {}).semya + " против " + (zN || {}).semya);
await br.close();

console.log(provalov ? ("ПРОВАЛОВ: " + provalov) : "ВСЁ ПРОЙДЕНО");
process.exit(provalov ? 1 : 0);
