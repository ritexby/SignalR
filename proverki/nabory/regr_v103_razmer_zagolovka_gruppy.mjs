const BASE = process.env.SK_BASE || 'http://127.0.0.1:5080';
// Свой размер в пунктах у заголовка группы и у подписи пункта.
//
// Владелец на снимке: «С момента последнего…» выросло вместе со ступенью, а «Взятие
// биоматериала…» и «Девственность» остались мелкими. В одном окне часть заголовков крупная, часть
// нет. Так выглядит заголовок, которому задан свой размер в пунктах, если этот размер не множится
// на выбранную клиентом ступень.
//
// В 9.6 это чинилось для текста блоков. Здесь проверяются заголовок группы, подпись варианта и
// подпись пункта - у них свой путь отрисовки.
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
    headingRuns: [{ text: "2. Информация" }], inPdf: true, bigText: true,
    blocks: [{ ord: 1, runs: [{ text: "Пояснение обычным текстом." }] }],
    groups: [
      // Свой размер в пунктах, как у владельца.
      { key: "g0", ord: 10, required: false,
        titleRuns: [{ text: "Взятие биоматериала или осмотр врачом акушером-гинекологом накануне", bold: true, sizePt: 11 }],
        options: [{ key: "da", label: "ДА" }, { key: "net", label: "НЕТ" }] },
      // Без своего размера: этот обязан расти сам по себе.
      { key: "g1", ord: 20, required: false, title: "С момента последнего мочеиспускания прошло не менее 1,5-2 ч",
        options: [{ key: "da", label: "ДА" }, { key: "net", label: "НЕТ" }] }
    ],
    checkboxes: [
      { key: "a", required: false, ord: 30, labelRuns: [{ text: "Гормоны со своим размером", sizePt: 11 }] },
      { key: "b", required: false, ord: 31, label: "Антибиотики обычные" }
    ] }],
  signBlocks: [], signBlocksBelow: [] }) });
ok(otvet.status === 200, "документ сохранён, иначе меряли бы чужой", String(otvet.status));

const kod = await (await fetch(BASE + "/api/admin/devices/enroll", {
  method: "POST", headers: SH, body: JSON.stringify({ name: "Планшет пунктов в группе" }) })).json();
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

const кегльПо = (узел, кусок) => {
  const н = document.querySelector(узел);
  if (!н) return 0;
  const с = кусок ? (н.querySelector("span") || н) : н;
  return Math.round(parseFloat(getComputedStyle(с).fontSize) * 10) / 10;
};
const меркаП = () => plan.evaluate((к) => к, {}).then(() => plan.evaluate(() => {
  const кегль = (s) => { const u = document.querySelector(s); return u ? Math.round(parseFloat(getComputedStyle(u).fontSize) * 10) / 10 : 0; };
  const впт = document.querySelectorAll(".group-title")[0];
  const обычный = document.querySelectorAll(".group-title")[1];
  const подпись = document.querySelectorAll(".check .label")[0];
  return { своиПт: впт ? кегль(".group-title span") : 0,
           обычный: обычный ? Math.round(parseFloat(getComputedStyle(обычный).fontSize) * 10) / 10 : 0,
           подписьПт: подпись ? Math.round(parseFloat(getComputedStyle(подпись.querySelector("span") || подпись).fontSize) * 10) / 10 : 0 };
}));
const меркаН = () => nabl.evaluate(() => {
  const впт = document.querySelectorAll(".watch-screen .pv-group-title")[0];
  const обычный = document.querySelectorAll(".watch-screen .pv-group-title")[1];
  const подпись = document.querySelectorAll(".watch-screen .watch-label")[0];
  const кегль = (u) => u ? Math.round(parseFloat(getComputedStyle(u).fontSize) * 10) / 10 : 0;
  return { своиПт: кегль(впт ? впт.querySelector("span") : null),
           обычный: кегль(обычный),
           подписьПт: кегль(подпись ? подпись.querySelector("span") : null),
           scale: getComputedStyle(document.querySelector(".watch-screen")).getPropertyValue("--wt-scale").trim() };
});

async function сверить(гдe) {
  await nabl.waitForTimeout(2000);
  const p = await меркаП(), n = await меркаН();
  console.log("\n== " + гдe);
  console.log("  планшет:    " + JSON.stringify(p));
  console.log("  наблюдение: " + JSON.stringify(n));
  ok(p.своиПт > 0 && n.своиПт > 0, гдe + ": заголовок со своим размером нашёлся с обеих сторон",
     p.своиПт + " и " + n.своиПт);
  ok(Math.abs(p.своиПт - n.своиПт) < 0.6, гдe + ": заголовок группы со своим размером совпал",
     p.своиПт + " против " + n.своиПт);
  ok(Math.abs(p.обычный - n.обычный) < 0.6, гдe + ": обычный заголовок группы совпал",
     p.обычный + " против " + n.обычный);
  ok(Math.abs(p.подписьПт - n.подписьПт) < 0.6, гдe + ": подпись пункта со своим размером совпала",
     p.подписьПт + " против " + n.подписьПт);
  return { p, n };
}

const б0 = await сверить("обычный размер");
for (const ступень of [1, 2, 3, 4]) {
  const можно = await plan.evaluate(() => { const k = document.getElementById("bigTextPlus"); return !!(k && !k.disabled); });
  if (!можно) break;
  await plan.click("#bigTextPlus"); await plan.waitForTimeout(500);
  const б = await сверить("ступень " + ступень);
  ok(б.p.своиПт > б0.p.своиПт, "на планшете заголовок со своим размером вырос, иначе проверять нечего",
     б0.p.своиПт + " -> " + б.p.своиПт);
}

await br.close();
console.log(provalov ? ("ПРОВАЛОВ: " + provalov) : "ВСЁ ПРОЙДЕНО");
process.exit(provalov ? 1 : 0);
