const BASE = process.env.SK_BASE || 'http://127.0.0.1:5080';
// Страница выше экрана планшета листается пальцем. Оператор в наблюдении обязан видеть то же
// место, куда отлистал клиент: до версии 8.1 планшет вовсе не сообщал положение прокрутки, сцена
// наблюдения обрезалась по краю, и клиент отмечал пункты внизу, а у оператора они были за краем.
// Смотреть за подписанием и не видеть, что человек сейчас отмечает, значит не смотреть вовсе.
import { chromium } from 'playwright';
const EXE = process.env.SK_CHROME || undefined;
let provalov = 0;
const ok = (u, t, z) => { if (u) console.log("PASS " + t); else { provalov++; console.log("FAIL " + t + ": " + (z === undefined ? "" : z)); } };

const vhod = await fetch(BASE + "/api/admin/login", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "test123" }) });
const kuka = (vhod.headers.get("set-cookie") || "").split(";")[0];
const SH = { "Content-Type": "application/json", Cookie: kuka };

// Длинная страница: наверху много текста, внизу отметки. Ровно тот случай из жалобы.
const dlinnyy = [];
for (let i = 1; i <= 25; i++) dlinnyy.push({ runs: [{ text: "Абзац номер " + i + ". " + "Длинный текст для высоты страницы. ".repeat(6) }], ord: i });
const dokument = {
  title: "Длинная страница", signPrompt: "Распишитесь", thankYouText: "Спасибо", idleReturnSec: 0,
  pages: [{
    headingRuns: [{ text: "Страница с прокруткой" }], inPdf: true,
    blocks: dlinnyy,
    checkboxes: [
      { key: "nizhniy1", label: "НИЖНЯЯ ОТМЕТКА ОДИН", ord: 90 },
      { key: "nizhniy2", label: "НИЖНЯЯ ОТМЕТКА ДВА", ord: 91 }
    ]
  }],
  signBlocks: [], signBlocksBelow: []
};
ok((await fetch(BASE + "/api/admin/document", { method: "PUT", headers: SH, body: JSON.stringify(dokument) })).status === 200,
   "длинный документ сохранён");

const kod = await (await fetch(BASE + "/api/admin/devices/enroll", {
  method: "POST", headers: SH, body: JSON.stringify({ name: "Планшет прокрутки" }) })).json();
const para = await (await fetch(BASE + "/api/kiosk/enroll", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: kod.code }) })).json();

const br = await chromium.launch({ executablePath: EXE, headless: true });

// Планшет: узкий и низкий экран, чтобы страница заведомо не уместилась.
const plan = await (await br.newContext({ viewport: { width: 800, height: 900 } })).newPage();
await plan.goto(BASE + "/");
await plan.evaluate(t => localStorage.setItem("sk_device_token", t), para.token);
await plan.reload();
await plan.waitForTimeout(2500);

// Оператор открывает наблюдение.
const nabl = await (await br.newContext({ viewport: { width: 1500, height: 1000 } })).newPage();
await nabl.goto(BASE + "/admin/");
await nabl.fill("#password", "test123");
await nabl.click("#loginForm button[type=submit]");
await nabl.waitForSelector('#app:not(.hidden)', { timeout: 10000 });

await fetch(BASE + "/api/admin/show-document", { method: "POST", headers: SH, body: JSON.stringify({
  target: "device:" + para.deviceId, fields: {} }) });
await plan.waitForTimeout(2500);

await nabl.goto(BASE + "/admin/#watch=" + encodeURIComponent("Планшет прокрутки"));
await nabl.waitForSelector(".watch-screen", { timeout: 15000 });
await nabl.waitForTimeout(2500);

// Сначала убеждаемся, что страница вообще длиннее экрана. Без этого весь набор прошёл бы на
// пустом месте: листать нечего, значит и расхождения быть не может.
const mozhnoListat = await plan.evaluate(() => {
  const b = document.querySelector(".doc-body");
  return b ? { est: b.scrollHeight - b.clientHeight, vsego: b.scrollHeight, vidno: b.clientHeight } : null;
});
console.log("на планшете можно отлистать: " + JSON.stringify(mozhnoListat));
ok(mozhnoListat && mozhnoListat.est > 200,
   "страница длиннее экрана планшета, значит листать есть куда", JSON.stringify(mozhnoListat));

const vNabludenii = async () => await nabl.evaluate(() => {
  const b = document.querySelector(".wt-body");
  return b ? { top: Math.round(b.scrollTop), est: Math.round(b.scrollHeight - b.clientHeight) } : null;
});

const doListania = await vNabludenii();
console.log("в наблюдении до листания: " + JSON.stringify(doListania));
ok(doListania && doListania.est > 100,
   "сцена наблюдения тоже длиннее своего окна, значит ей есть что показать ниже", JSON.stringify(doListania));

// Клиент листает вниз до самого низа, где стоят отметки.
await plan.evaluate(() => { const b = document.querySelector(".doc-body"); b.scrollTop = b.scrollHeight; });
await plan.waitForTimeout(2000);
const naPlanshete = await plan.evaluate(() => {
  const b = document.querySelector(".doc-body");
  return { top: Math.round(b.scrollTop), est: Math.round(b.scrollHeight - b.clientHeight) };
});
console.log("планшет отлистан: " + JSON.stringify(naPlanshete));

await nabl.waitForTimeout(1500);
const posleListania = await vNabludenii();
console.log("в наблюдении после листания: " + JSON.stringify(posleListania));

// ГЛАВНОЕ: наблюдение уехало вслед за клиентом, а не осталось на верху страницы.
ok(posleListania && posleListania.top > 100,
   "наблюдение уехало вслед за клиентом, а не осталось наверху", JSON.stringify(posleListania));
const dolyaKlienta = naPlanshete.est ? naPlanshete.top / naPlanshete.est : 0;
const dolyaOperatora = posleListania.est ? posleListania.top / posleListania.est : 0;
console.log("доля прокрутки: клиент " + dolyaKlienta.toFixed(2) + ", оператор " + dolyaOperatora.toFixed(2));
ok(Math.abs(dolyaKlienta - dolyaOperatora) < 0.25,
   "оператор смотрит примерно на то же место страницы, что и клиент",
   "клиент " + dolyaKlienta.toFixed(2) + ", оператор " + dolyaOperatora.toFixed(2));

// И нижние отметки оператору теперь видны, а не обрезаны краем сцены.
const vidnaLiNizhnyaya = await nabl.evaluate(() => {
  const b = document.querySelector(".wt-body");
  if (!b) return null;
  const uzly = Array.prototype.slice.call(b.querySelectorAll("*"));
  const nash = uzly.filter(u => (u.textContent || "").indexOf("НИЖНЯЯ ОТМЕТКА ДВА") >= 0).pop();
  if (!nash) return { est: false };
  const a = nash.getBoundingClientRect(), r = b.getBoundingClientRect();
  return { est: true, vnutri: a.top < r.bottom && a.bottom > r.top };
});
console.log("нижняя отметка в окне наблюдения: " + JSON.stringify(vidnaLiNizhnyaya));
ok(vidnaLiNizhnyaya && vidnaLiNizhnyaya.est && vidnaLiNizhnyaya.vnutri,
   "нижняя отметка попала в видимую часть сцены, а не осталась за краем", JSON.stringify(vidnaLiNizhnyaya));

// Клиент вернулся наверх: наблюдение обязано вернуться тоже.
await plan.evaluate(() => { const b = document.querySelector(".doc-body"); b.scrollTop = 0; });
await plan.waitForTimeout(2000);
await nabl.waitForTimeout(1200);
const nazad = await vNabludenii();
console.log("после возврата наверх: " + JSON.stringify(nazad));
ok(nazad && nazad.top < 120, "наблюдение вернулось наверх вслед за клиентом", JSON.stringify(nazad));

await br.close();
console.log(provalov ? ("ПРОВАЛОВ: " + provalov) : "ВСЁ ПРОЙДЕНО");
process.exit(provalov ? 1 : 0);
