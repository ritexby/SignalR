const BASE = process.env.SK_BASE || 'http://127.0.0.1:5080';
// Подвал планшета: сообщение о перезагрузке и остающееся от него оформление.
//
// Две беды с боевого сервера, обе показал владелец.
// 1. Клиент получал «Страница обновилась, заполненное не сохранилось» на пустом месте: документ
//    просто лежал на планшете дольше пяти секунд, никто к нему не подходил, страницу обновил
//    оператор при смене версии. Первый же клиент читал о потере того, чего не вводил.
// 2. После этого сообщения он отмечал пункт, текст сообщения исчезал, а серая рамка с фоном
//    оставалась: в подвале висела пустая плашка непонятно о чём.
import { chromium } from 'playwright';
const EXE = process.env.SK_CHROME || undefined;
let provalov = 0;
const ok = (u, t, z) => { if (u) console.log("PASS " + t); else { provalov++; console.log("FAIL " + t + ": " + (z === undefined ? "" : z)); } };

const vhod = await fetch(BASE + "/api/admin/login", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "test123" }) });
const kuka = (vhod.headers.get("set-cookie") || "").split(";")[0];
const SH = { "Content-Type": "application/json", Cookie: kuka };

await fetch(BASE + "/api/admin/document", { method: "PUT", headers: SH, body: JSON.stringify({
  title: "Соглашение", signPrompt: "Распишитесь", thankYouText: "Спасибо", idleReturnSec: 0,
  pages: [{ headingRuns: [{ text: "Проверка данных" }], inPdf: true,
            blocks: [{ runs: [{ text: "Проверьте правильность данных." }], ord: 0 }],
            checkboxes: [{ key: "podtverzhdayu", label: "Я подтверждаю корректность введенных данных", required: true, ord: 1 }] }],
  signBlocks: [], signBlocksBelow: [] }) });

const kod = await (await fetch(BASE + "/api/admin/devices/enroll", {
  method: "POST", headers: SH, body: JSON.stringify({ name: "Планшет подвала" }) })).json();
const para = await (await fetch(BASE + "/api/kiosk/enroll", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: kod.code }) })).json();

const br = await chromium.launch({ executablePath: EXE, headless: true });
const plan = await (await br.newContext({ viewport: { width: 800, height: 1280 } })).newPage();
plan.on('pageerror', e => { console.log("FAIL ошибка на планшете: " + e.message); provalov++; });
await plan.goto(BASE + "/");
await plan.evaluate(t => localStorage.setItem("sk_device_token", t), para.token);
await plan.reload();
await plan.waitForTimeout(2500);

const proPodval = async () => await plan.evaluate(() => {
  const n = document.getElementById("footerNote");
  if (!n) return { est: false };
  const a = n.getBoundingClientRect();
  const s = getComputedStyle(n);
  return { est: true, tekst: (n.textContent || "").trim(), trevoga: n.classList.contains("note-warn"),
           shirina: Math.round(a.width), vysota: Math.round(a.height),
           ramka: s.borderTopWidth, fon: s.backgroundColor };
});

// ===== 1. Документ лежит на планшете, к нему никто не подходил, страницу обновили.
await fetch(BASE + "/api/admin/show-document", { method: "POST", headers: SH, body: JSON.stringify({
  target: "device:" + para.deviceId, fields: {} }) });
await plan.waitForTimeout(2500);
// Ждём, чтобы документ заведомо пролежал дольше пяти секунд: прежде именно это и было условием.
await plan.waitForTimeout(7000);
await plan.reload();
await plan.waitForTimeout(3500);

const p1 = await proPodval();
console.log("после обновления, когда никто ничего не вводил: " + JSON.stringify(p1));
ok(p1.est, "подвал на месте", JSON.stringify(p1));
ok(!/обновилась/i.test(p1.tekst),
   "клиенту не говорят о потере того, чего он не вводил", "«" + p1.tekst + "»");
ok(!p1.trevoga, "и тревожного оформления в подвале нет", JSON.stringify(p1));

// ===== 2. Теперь клиент действительно отмечает пункт, и страницу обновляют снова.
await plan.click(".check input[type=checkbox]");
await plan.waitForTimeout(800);
const otmecheno = await plan.evaluate(() => !!document.querySelector(".check input[type=checkbox]").checked);
ok(otmecheno, "клиент отметил пункт, иначе проверять нечего");
await plan.reload();
await plan.waitForTimeout(3500);

const p2 = await proPodval();
console.log("после обновления, когда клиент отмечал: " + JSON.stringify(p2));
ok(/обновилась/i.test(p2.tekst),
   "о настоящей потере заполненного клиенту говорят", "«" + p2.tekst + "»");
ok(p2.trevoga, "и говорят заметно, тревожным оформлением", JSON.stringify(p2));

// ===== 3. ГЛАВНОЕ: клиент отмечает пункт, сообщение уходит целиком, а не только текст.
await plan.click(".check input[type=checkbox]");
await plan.waitForTimeout(900);
const p3 = await proPodval();
console.log("после отметки: " + JSON.stringify(p3));
ok(p3.tekst === "", "текст сообщения ушёл", "«" + p3.tekst + "»");
ok(!p3.trevoga, "и оформление ушло вместе с ним, пустой плашки не осталось", JSON.stringify(p3));
ok(p3.vysota < 12 || p3.fon === "rgba(0, 0, 0, 0)",
   "пустой подвал ничего собой не занимает и ничем не выделен",
   "высота " + p3.vysota + ", фон " + p3.fon);

// ===== 4. Признак не переживает уход клиента: следующий не должен получить чужое сообщение.
await fetch(BASE + "/api/admin/show-slides", { method: "POST", headers: SH, body: JSON.stringify({
  target: "device:" + para.deviceId }) });
await plan.waitForTimeout(2000);
await fetch(BASE + "/api/admin/show-document", { method: "POST", headers: SH, body: JSON.stringify({
  target: "device:" + para.deviceId, fields: {} }) });
await plan.waitForTimeout(2500);
await plan.reload();
await plan.waitForTimeout(3500);
const p4 = await proPodval();
console.log("следующий клиент после ухода прежнего: " + JSON.stringify(p4));
ok(!/обновилась/i.test(p4.tekst),
   "следующий клиент не получает сообщение о потере, которой у него не было", "«" + p4.tekst + "»");

await br.close();
console.log(provalov ? ("ПРОВАЛОВ: " + provalov) : "ВСЁ ПРОЙДЕНО");
process.exit(provalov ? 1 : 0);
