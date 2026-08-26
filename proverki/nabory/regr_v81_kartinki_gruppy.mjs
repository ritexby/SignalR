const BASE = process.env.SK_BASE || 'http://127.0.0.1:5080';
// Реклама по наборам планшетов: у самой картинки задано, в каких наборах её показывать и в каких
// не показывать. Проверяется не пересказ настроек, а то, что реально держит планшет:
// window.__slidesForTest это его собственный список.
import { chromium } from 'playwright';
const EXE = process.env.SK_CHROME || undefined;
let provalov = 0;
const ok = (u, t, z) => { if (u) console.log("PASS " + t); else { provalov++; console.log("FAIL " + t + ": " + z); } };

const vhod = await fetch(BASE + "/api/admin/login", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "test123" }) });
const kuka = (vhod.headers.get("set-cookie") || "").split(";")[0];
const SH = { "Content-Type": "application/json", Cookie: kuka };
const K = { Cookie: kuka };

const PNG = {
  krasnaya: "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAF0lEQVR42mP8z8BQz0AEYBxVSF+FAAoCAf6nzXwPAAAAAElFTkSuQmCC",
  sinyaya: "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAFklEQVR42mNkYPhfz0AEYBxVSF+FAA5+Af5Zf1CDAAAAAElFTkSuQmCC",
  zelenaya: "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAFklEQVR42mNk+M9Qz0AEYBxVSF+FAAeVAf7q3P1QAAAAAElFTkSuQmCC"
};
async function zagruzit(imya, b64) {
  const forma = new FormData();
  forma.append("file", new Blob([Buffer.from(b64, "base64")], { type: "image/png" }), imya + ".png");
  const j = await (await fetch(BASE + "/api/admin/images", { method: "POST", headers: { Cookie: kuka }, body: forma })).json();
  const pervaya = (j.added || [])[0] || {};
  return { id: pervaya.id, url: pervaya.url };
}
const kObschaya = await zagruzit("obshaya", PNG.krasnaya);
const kKab1 = await zagruzit("kabinet1", PNG.sinyaya);
const kKab2 = await zagruzit("kabinet2", PNG.zelenaya);
ok(kObschaya.id && kKab1.id && kKab2.id, "три картинки загружены", JSON.stringify([kObschaya, kKab1, kKab2]));

const nabor = async (imya) => await (await fetch(BASE + "/api/admin/groups", {
  method: "POST", headers: SH, body: JSON.stringify({ name: imya }) })).json();
const g1 = await nabor("Кабинет 1");
const g2 = await nabor("Кабинет 2");

const gde = async (kartinka, tolko, krome) => {
  const o = await fetch(BASE + "/api/admin/images/" + kartinka.id + "/groups", {
    method: "PUT", headers: SH, body: JSON.stringify({ groupIds: tolko || [], exceptGroupIds: krome || [] }) });
  return { status: o.status, telo: await o.json().catch(() => null) };
};
await gde(kKab1, [g1.id], []);
await gde(kKab2, [g2.id], []);

// Противоречивая настройка: один и тот же набор и в «показывать», и в «кроме».
const spor = await gde(kObschaya, [g1.id], [g1.id]);
console.log("спорная настройка: " + spor.status + " " + JSON.stringify(spor.telo));
ok(spor.status === 400 && /Кабинет 1/.test(JSON.stringify(spor.telo)),
   "набор сразу в «показывать» и в «кроме» отвергнут с именем набора", JSON.stringify(spor));

const kod = await (await fetch(BASE + "/api/admin/devices/enroll", {
  method: "POST", headers: SH, body: JSON.stringify({ name: "Планшет кабинета", groupIds: [g1.id] }) })).json();
const para = await (await fetch(BASE + "/api/kiosk/enroll", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: kod.code }) })).json();

const br = await chromium.launch({ executablePath: EXE, headless: true });
const str = await (await br.newContext({ viewport: { width: 800, height: 1334 } })).newPage();
await str.goto(BASE + "/");
await str.evaluate(t => localStorage.setItem("sk_device_token", t), para.token);
await str.reload();
await str.waitForTimeout(2500);

const uPlansheta = async () => await str.evaluate(() => (window.__slidesForTest || []).slice());
const uServera = async () => {
  const j = await (await fetch(BASE + "/api/admin/devices/" + para.deviceId + "/screen", { headers: K })).json();
  return ((j.slides || {}).images) || [];
};
const est = (spisok, k) => spisok.some(i => (i || "").indexOf(k.id) >= 0);
const zhdat = async (uslovie, sek) => {
  for (let i = 0; i < sek * 4; i++) { if (await uslovie()) return true; await str.waitForTimeout(250); }
  return false;
};

// 1. Все три картинки в показе, а до планшета кабинета 1 доходят только две.
await fetch(BASE + "/api/admin/playlist", { method: "PUT", headers: SH, body: JSON.stringify({
  target: "all", imageIds: [kObschaya.id, kKab1.id, kKab2.id], intervalSec: 8 }) });
await zhdat(async () => (await uPlansheta()).length > 0, 8);
const s1 = await uPlansheta();
console.log("у планшета кабинета 1: " + JSON.stringify(s1));
ok(est(s1, kObschaya) && est(s1, kKab1), "планшет получил общую картинку и картинку своего кабинета", JSON.stringify(s1));
ok(!est(s1, kKab2), "картинка чужого кабинета до него НЕ дошла", JSON.stringify(s1));

// 2. Срок показа: вчерашний конец снимает картинку с экрана сам.
const vchera = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
await fetch(BASE + "/api/admin/images/" + kObschaya.id + "/dates", {
  method: "PUT", headers: SH, body: JSON.stringify({ showFrom: "", showTo: vchera }) });
await zhdat(async () => !est(await uPlansheta(), kObschaya), 8);
const s2 = await uPlansheta();
console.log("после истёкшего срока: " + JSON.stringify(s2));
ok(!est(s2, kObschaya), "картинка с истёкшим сроком ушла с планшета сама", JSON.stringify(s2));
ok(est(s2, kKab1), "и своя картинка при этом осталась", JSON.stringify(s2));

const naoborot = await fetch(BASE + "/api/admin/images/" + kObschaya.id + "/dates", {
  method: "PUT", headers: SH, body: JSON.stringify({ showFrom: "2026-12-01", showTo: "2026-01-01" }) });
ok(naoborot.status === 400, "срок с концом раньше начала отвергнут", String(naoborot.status));
await fetch(BASE + "/api/admin/images/" + kObschaya.id + "/dates", {
  method: "PUT", headers: SH, body: JSON.stringify({ showFrom: "", showTo: "" }) });

// 3. Планшет переехал в другой кабинет. Реклама прежнего остаться на нём не может.
await fetch(BASE + "/api/admin/devices/" + para.deviceId, {
  method: "PUT", headers: SH, body: JSON.stringify({ name: "Планшет кабинета", groupIds: [g2.id] }) });
await zhdat(async () => est(await uPlansheta(), kKab2), 10);
const s3 = await uPlansheta();
const serv3 = await uServera();
console.log("после переезда: у планшета " + JSON.stringify(s3) + ", у сервера " + JSON.stringify(serv3));
ok(!est(s3, kKab1), "реклама прежнего кабинета ушла с планшета", JSON.stringify(s3));
ok(est(s3, kKab2), "реклама нового кабинета на планшет пришла", JSON.stringify(s3));
ok(JSON.stringify(s3) === JSON.stringify(serv3),
   "то, что держит планшет, совпадает с тем, что показывает оператору админка",
   JSON.stringify(s3) + " против " + JSON.stringify(serv3));

// 4. Удаление набора не оставляет картинку невидимой навсегда.
await fetch(BASE + "/api/admin/groups/" + g2.id, { method: "DELETE", headers: K });
await zhdat(async () => est(await uPlansheta(), kKab2), 8);
const s4 = await uPlansheta();
ok(est(s4, kKab2), "картинка удалённого набора стала общей, а не пропала молча", JSON.stringify(s4));

await br.close();
console.log(provalov ? ("ПРОВАЛОВ: " + provalov) : "ВСЁ ПРОЙДЕНО");
process.exit(provalov ? 1 : 0);
