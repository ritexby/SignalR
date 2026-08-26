const BASE = process.env.SK_BASE || 'http://127.0.0.1:5080';
// Кнопка «Ниже есть ещё» на планшете. Страница выше экрана листается пальцем, но человек об этом
// не догадывается: он видит низ экрана, кнопку «Далее» и уходит дальше, не прочитав середину и
// не отметив то, что там стоит. Кнопка обязана появляться только там, где ниже действительно
// что-то есть, и уходить у самого низа: постоянная кнопка перестаёт что-либо значить.
//
// Порядок страниц выбран не случайно. Управление размером текста продукт показывает только на
// первой странице (так задумано владельцем), поэтому средняя страница, которая помещается при
// обычном размере и перестаёт помещаться при крупном, обязана быть первой.
import { chromium } from 'playwright';
const EXE = process.env.SK_CHROME || undefined;
let provalov = 0;
const ok = (u, t, z) => { if (u) console.log("PASS " + t); else { provalov++; console.log("FAIL " + t + ": " + (z === undefined ? "" : z)); } };

const vhod = await fetch(BASE + "/api/admin/login", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "test123" }) });
const kuka = (vhod.headers.get("set-cookie") || "").split(";")[0];
const SH = { "Content-Type": "application/json", Cookie: kuka };

const abzacy = (skolko, povtor) => {
  const out = [];
  for (let i = 1; i <= skolko; i++)
    out.push({ runs: [{ text: "Абзац номер " + i + ". " + "Текст для высоты страницы. ".repeat(povtor) }], ord: i });
  return out;
};
await fetch(BASE + "/api/admin/document", { method: "PUT", headers: SH, body: JSON.stringify({
  title: "Проверка кнопки", signPrompt: "Распишитесь", thankYouText: "Спасибо", idleReturnSec: 0,
  pages: [
    // Первая: помещается при обычном размере, перестаёт помещаться при крупном. С управлением размером.
    { headingRuns: [{ text: "Средняя страница" }], inPdf: true, bigText: true,
      blocks: abzacy(4, 4), checkboxes: [] },
    // Вторая: заведомо длиннее экрана.
    { headingRuns: [{ text: "Длинная страница" }], inPdf: true, blocks: abzacy(25, 6),
      checkboxes: [{ key: "nizhniy", label: "НИЖНЯЯ ОТМЕТКА", ord: 90 }] }
  ],
  signBlocks: [], signBlocksBelow: [] }) });

const kod = await (await fetch(BASE + "/api/admin/devices/enroll", {
  method: "POST", headers: SH, body: JSON.stringify({ name: "Планшет кнопки" }) })).json();
const para = await (await fetch(BASE + "/api/kiosk/enroll", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: kod.code }) })).json();

const br = await chromium.launch({ executablePath: EXE, headless: true });
const plan = await (await br.newContext({ viewport: { width: 800, height: 900 } })).newPage();
plan.on('pageerror', e => { console.log("FAIL ошибка на планшете: " + e.message); provalov++; });
await plan.goto(BASE + "/");
await plan.evaluate(t => localStorage.setItem("sk_device_token", t), para.token);
await plan.reload();
await plan.waitForTimeout(2500);
await fetch(BASE + "/api/admin/show-document", { method: "POST", headers: SH, body: JSON.stringify({
  target: "device:" + para.deviceId, fields: {} }) });
await plan.waitForTimeout(2500);

const proKnopku = async () => await plan.evaluate(() => {
  const k = document.getElementById("btnScrollDown");
  const b = document.querySelector(".doc-body");
  if (!k || !b) return { est: !!k, telo: !!b };
  const a = k.getBoundingClientRect();
  return {
    est: true,
    vidna: !k.classList.contains("hidden") && a.width > 0 && a.height > 0,
    tekst: (k.textContent || "").trim(),
    shirina: Math.round(a.width), vysota: Math.round(a.height),
    ostalos: Math.round(b.scrollHeight - b.scrollTop - b.clientHeight),
    verh: Math.round(b.scrollTop)
  };
});
const zagolovok = async () => (await plan.textContent(".doc-body h2, .doc-heading, .doc-body h1").catch(() => "")) || "";

// ===== Первая страница: помещается целиком.
const gde1 = await plan.evaluate(() => (document.querySelector(".doc-body") || {}).innerText || "");
ok(/Средняя страница/.test(gde1), "открыта первая страница", gde1.slice(0, 60));
const k0 = await proKnopku();
console.log("первая страница при обычном размере: " + JSON.stringify(k0));
ok(k0.est, "кнопка вообще есть на экране планшета", JSON.stringify(k0));
ok(k0.ostalos <= 24, "страница при обычном размере помещается целиком, иначе проверять нечего", JSON.stringify(k0));
ok(!k0.vidna, "на помещающейся странице кнопки нет", JSON.stringify(k0));

// ===== Клиент увеличивает шрифт. Высота меняется не от прокрутки и не от смены экрана.
const razmerEst = await plan.evaluate(() => !!document.getElementById("bigTextPlus"));
ok(razmerEst, "управление размером текста на первой странице есть");
if (razmerEst) {
  for (let i = 0; i < 4; i++) {
    const mozhno = await plan.evaluate(() => { const k = document.getElementById("bigTextPlus"); return !!(k && !k.disabled); });
    if (!mozhno) break;
    await plan.click("#bigTextPlus");
    await plan.waitForTimeout(450);
  }
  const posleUvel = await proKnopku();
  console.log("после увеличения шрифта: " + JSON.stringify(posleUvel));
  ok(posleUvel.ostalos > 24, "крупный шрифт вывел страницу за экран, иначе проверять нечего", JSON.stringify(posleUvel));
  ok(posleUvel.vidna, "кнопка появилась сама, когда клиент увеличил шрифт", JSON.stringify(posleUvel));

  for (let i = 0; i < 5; i++) {
    const mozhno = await plan.evaluate(() => { const k = document.getElementById("bigTextMinus"); return !!(k && !k.disabled); });
    if (!mozhno) break;
    await plan.click("#bigTextMinus");
    await plan.waitForTimeout(450);
  }
  const posleUmen = await proKnopku();
  console.log("после возврата обычного размера: " + JSON.stringify(posleUmen));
  ok(posleUmen.ostalos <= 24 && !posleUmen.vidna,
     "вернули обычный размер, кнопка ушла вместе с надобностью", JSON.stringify(posleUmen));
}

// ===== Вторая страница: длиннее экрана.
await plan.click("#btnNext");
await plan.waitForTimeout(1800);
const gde2 = await plan.evaluate(() => (document.querySelector(".doc-body") || {}).innerText || "");
ok(/Длинная страница/.test(gde2), "перешли на вторую страницу", gde2.slice(0, 60));

const k1 = await proKnopku();
console.log("длинная страница сверху: " + JSON.stringify(k1));
ok(k1.ostalos > 100, "странице есть куда листать, иначе проверять нечего", JSON.stringify(k1));
ok(k1.vidna, "кнопка видна, когда ниже есть непрочитанное", JSON.stringify(k1));
ok(/ниже/i.test(k1.tekst), "на кнопке написано словами, что ниже есть ещё", k1.tekst);
ok(k1.vysota >= 40 && k1.shirina >= 120, "кнопка крупная, её трудно не заметить", k1.shirina + "x" + k1.vysota);

// Кнопка не наезжает на «Далее» и «Назад».
const nakladka = await plan.evaluate(() => {
  const k = document.getElementById("btnScrollDown");
  const nazad = document.querySelector(".doc-footer .btn-ghost");
  const dalee = document.getElementById("btnNext");
  const meshaet = (a, b) => !(a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom);
  const ak = k.getBoundingClientRect();
  return { naDalee: dalee ? meshaet(ak, dalee.getBoundingClientRect()) : false,
           naNazad: nazad ? meshaet(ak, nazad.getBoundingClientRect()) : false };
});
console.log("наложение: " + JSON.stringify(nakladka));
ok(!nakladka.naDalee && !nakladka.naNazad, "кнопка не наезжает ни на «Далее», ни на «Назад»", JSON.stringify(nakladka));

// Нажатие листает вниз само: пожилому человеку нажать проще, чем тянуть пальцем.
await plan.click("#btnScrollDown");
await plan.waitForTimeout(900);
const k2 = await proKnopku();
console.log("после нажатия: " + JSON.stringify(k2));
ok(k2.verh > k1.verh + 200, "нажатие пролистало страницу вниз", k1.verh + " -> " + k2.verh);

// У самого низа кнопка уходит.
await plan.evaluate(() => { const b = document.querySelector(".doc-body"); b.scrollTop = b.scrollHeight; });
await plan.waitForTimeout(700);
const k3 = await proKnopku();
console.log("у самого низа: " + JSON.stringify(k3));
ok(!k3.vidna, "у самого низа кнопка убирается", JSON.stringify(k3));

// Вернулись наверх, кнопка вернулась.
await plan.evaluate(() => { const b = document.querySelector(".doc-body"); b.scrollTop = 0; });
await plan.waitForTimeout(700);
ok((await proKnopku()).vidna, "вернулись наверх, кнопка вернулась");

await plan.screenshot({ path: (process.env.SK_RABOTA || ".") + "/knopka_vniz.png" });
await br.close();
console.log(provalov ? ("ПРОВАЛОВ: " + provalov) : "ВСЁ ПРОЙДЕНО");
process.exit(provalov ? 1 : 0);
