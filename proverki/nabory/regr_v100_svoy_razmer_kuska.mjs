const BASE = process.env.SK_BASE || 'http://127.0.0.1:5080';
// Свой размер куска текста в пунктах и ступень, выбранная клиентом.
//
// Владелец: без увеличения экраны совпадают, на одну ступень расходятся, на две больше, и на
// планшете растут все строки, а в наблюдении не все. Найдено в исходнике: планшет пишет такому
// куску calc(Npt * var(--doc-scale)), то есть множит его размер на ступень, а наблюдение писало
// просто Npt и не множило. При обычном размере числа совпадают, поэтому расхождения не было.
//
// Здесь оба края сверяются на каждой ступени по настоящему кеглю куска.
import { chromium } from 'playwright';
const EXE = process.env.SK_CHROME || undefined;
let provalov = 0;
const ok = (u, t, z) => { if (u) console.log("PASS " + t); else { provalov++; console.log("FAIL " + t + ": " + (z === undefined ? "" : z)); } };

const vhod = await fetch(BASE + "/api/admin/login", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "test123" }) });
const kuka = (vhod.headers.get("set-cookie") || "").split(";")[0];
const SH = { "Content-Type": "application/json", Cookie: kuka };

// Блок как у владельца: жирные подписи со своим размером в пунктах и значения обычным текстом.
const otvet = await fetch(BASE + "/api/admin/document", { method: "PUT", headers: SH, body: JSON.stringify({
  title: "1 Соглашение о проведении медицинского вмешательства",
  signPrompt: "Распишитесь", thankYouText: "Спасибо", idleReturnSec: 0,
  pages: [{
    headingRuns: [{ text: "1. Проверка персональных данных" }], inPdf: true, bigText: true,
    blocks: [{ ord: 1, runs: [
      { text: "Пожалуйста, проверьте правильность указанных персональных и контактных данных. Если данные требуют актуализации, сообщите об этом медицинскому регистратору\n\n" },
      { text: "ФИО: ", bold: true, sizePt: 14 },
      { text: "Иванов Иван Иванович\n" },
      { text: "Дата рождения: ", bold: true, sizePt: 14 },
      { text: "01.01.1980\n" },
      { text: "Контактный телефон: ", bold: true, sizePt: 14 },
      { text: "+375291234567\n" }
    ] }],
    checkboxes: [] }],
  signBlocks: [], signBlocksBelow: [] }) });
ok(otvet.status === 200, "документ сохранён, иначе меряли бы чужой", String(otvet.status));

const kod = await (await fetch(BASE + "/api/admin/devices/enroll", {
  method: "POST", headers: SH, body: JSON.stringify({ name: "Планшет пунктов" }) })).json();
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

// Кегль куска со своим размером и высота всего блока. Кусок ищем по тексту, чтобы не зависеть
// от порядка узлов.
const merkaP = () => plan.evaluate(() => {
  const у = Array.prototype.slice.call(document.querySelectorAll(".doc-text span"))
    .filter(s => /ФИО/.test(s.textContent || ""))[0];
  const б = document.querySelector(".doc-text");
  return { kusok: у ? Math.round(parseFloat(getComputedStyle(у).fontSize) * 10) / 10 : 0,
           blok: б ? б.offsetHeight : 0, shirina: б ? б.offsetWidth : 0 };
});
const merkaN = () => nabl.evaluate(() => {
  const у = Array.prototype.slice.call(document.querySelectorAll(".watch-screen .pv-text span"))
    .filter(s => /ФИО/.test(s.textContent || ""))[0];
  const б = document.querySelector(".watch-screen .pv-text");
  return { kusok: у ? Math.round(parseFloat(getComputedStyle(у).fontSize) * 10) / 10 : 0,
           blok: б ? б.offsetHeight : 0, shirina: б ? б.offsetWidth : 0 };
});

async function sverit(gde) {
  await nabl.waitForTimeout(2000);
  const p = await merkaP(), n = await merkaN();
  console.log("\n== " + gde);
  console.log("  планшет:    " + JSON.stringify(p));
  console.log("  наблюдение: " + JSON.stringify(n));
  ok(p.kusok > 0 && n.kusok > 0, gde + ": кусок со своим размером нашёлся с обеих сторон",
     p.kusok + " и " + n.kusok);
  ok(Math.abs(p.kusok - n.kusok) < 0.6, gde + ": свой размер куска тот же",
     p.kusok + " против " + n.kusok);
  ok(Math.abs(p.shirina - n.shirina) <= 2, gde + ": блок той же ширины", p.shirina + " против " + n.shirina);
  ok(Math.abs(p.blok - n.blok) <= 2, gde + ": блок той же высоты, значит переносы совпали",
     p.blok + " против " + n.blok);
  return { p, n };
}

const б0 = await sverit("обычный размер");
const жать = async (n) => { for (let i = 0; i < n; i++) {
  const можно = await plan.evaluate(() => { const k = document.getElementById("bigTextPlus"); return !!(k && !k.disabled); });
  if (!можно) return i;
  await plan.click("#bigTextPlus"); await plan.waitForTimeout(450);
} return n; };

for (const ступень of [1, 2, 3, 4]) {
  const прошло = await жать(1);
  ok(прошло === 1, "ступень " + ступень + ": нажатие прошло", String(прошло));
  const б = await sverit("ступень " + ступень);
  ok(б.p.kusok > б0.p.kusok, "на планшете кусок действительно вырос, иначе проверять нечего",
     б0.p.kusok + " -> " + б.p.kusok);
}

await br.close();
console.log(provalov ? ("ПРОВАЛОВ: " + provalov) : "ВСЁ ПРОЙДЕНО");
process.exit(provalov ? 1 : 0);
