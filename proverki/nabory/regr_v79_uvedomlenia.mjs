const BASE = process.env.SK_BASE || 'http://127.0.0.1:5080';
const DANNYE = process.env.SK_DATA;
// Уведомления оператору: пропавший планшет и лавина ошибок. Если сторож молчит, парк стоит
// незамеченным. Набор долгий: внутри две выдержки по минуте с лишним, столько ждёт сам сторож.
import { readFileSync, writeFileSync } from 'node:fs';
const EXE = process.env.SK_CHROME || undefined;
let provalov = 0;
const ok = (u, t, z) => { if (u) console.log("PASS " + t); else { provalov++; console.log("FAIL " + t + ": " + (z === undefined ? "" : z)); } };
// Спящий sleep в переднем плане в некоторых средах не работает, поэтому ждём запросами.
const zhdat = async (ms) => { const t = Date.now(); while (Date.now() - t < ms) await fetch(BASE + "/healthz").catch(() => {}); };

if (!DANNYE) { console.log("НАБОР НЕ ПРИМЕНИМ: не задан SK_DATA, каталог данных прогона неизвестен"); process.exit(0); }

const vhod = await fetch(BASE + "/api/admin/login", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "test123" }) });
const kuka = (vhod.headers.get("set-cookie") || "").split(";")[0];
const SH = { "Content-Type": "application/json", Cookie: kuka };
const K = { Cookie: kuka };
const uvedomlenia = async () => await (await fetch(BASE + "/api/admin/alerts", { headers: K })).json();

// 1. Настройки читаются, пишутся и приводятся к разумным границам.
const nast0 = await (await fetch(BASE + "/api/admin/alerts/settings", { headers: K })).json();
console.log("настройки по умолчанию: " + JSON.stringify(nast0));
ok(nast0.offlineMinutes > 0 && nast0.errorCount > 0, "настройки отдаются", JSON.stringify(nast0));

const zapisat = (telo) => fetch(BASE + "/api/admin/alerts/settings", { method: "PUT", headers: SH, body: JSON.stringify(telo) });
const nast1 = await (await zapisat({ enabled: true, offlineMinutes: 1, errorCount: 3, errorWindowMinutes: 10 })).json();
ok(nast1.offlineMinutes === 1 && nast1.errorCount === 3, "настройки сохраняются", JSON.stringify(nast1));

const plohie = await (await zapisat({ enabled: true, offlineMinutes: -5, errorCount: 0, errorWindowMinutes: 99999 })).json();
console.log("негодные настройки стали: " + JSON.stringify(plohie));
ok(plohie.offlineMinutes >= 1 && plohie.errorCount >= 1 && plohie.errorWindowMinutes <= 1440,
   "негодные настройки приведены к разумным, а не приняты как есть", JSON.stringify(plohie));
await zapisat({ enabled: true, offlineMinutes: 1, errorCount: 3, errorWindowMinutes: 10 });

// 2. Всплеск ошибок поднимает уведомление.
const kod = await (await fetch(BASE + "/api/admin/devices/enroll", {
  method: "POST", headers: SH, body: JSON.stringify({ name: "Планшет уведомлений" }) })).json();
const para = await (await fetch(BASE + "/api/kiosk/enroll", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: kod.code }) })).json();
for (let i = 0; i < 5; i++) {
  await fetch(BASE + "/api/log", { method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + para.token },
    body: JSON.stringify({ level: "error", message: "поломка номер " + i, detail: "проверка сторожа" }) });
}
await zhdat(35000);
const u1 = await uvedomlenia();
const proOshibki = (u1.alerts || []).filter(a => a.kind === "errors");
console.log("уведомлений всего: " + (u1.alerts || []).length + ", про ошибки: " + proOshibki.length);
ok(proOshibki.length >= 1, "всплеск ошибок поднимает уведомление", JSON.stringify(u1).slice(0, 300));

// 3. Подтверждение уменьшает счётчик непрочитанных.
const byloNeprochitannyh = u1.unacknowledged;
await fetch(BASE + "/api/admin/alerts/ack", { method: "POST", headers: SH, body: JSON.stringify({}) });
const u2 = await uvedomlenia();
console.log("непрочитанных было " + byloNeprochitannyh + ", стало " + u2.unacknowledged);
ok(u2.unacknowledged < byloNeprochitannyh || byloNeprochitannyh === 0,
   "подтверждение уменьшает счётчик непрочитанных", byloNeprochitannyh + " -> " + u2.unacknowledged);
ok((u2.alerts || []).every(a => a.acknowledged), "и само уведомление помечено прочитанным");

// 4. Пропавший планшет. Состариваем последний выход на связь прямо в файле.
const put = DANNYE + "/devices.json";
const spisok = JSON.parse(readFileSync(put, "utf8"));
const nash = spisok.find(d => d.Id === para.deviceId || d.id === para.deviceId);
const staroe = new Date(Date.now() - 30 * 60000).toISOString();
if (nash) { if ("LastSeenUtc" in nash) nash.LastSeenUtc = staroe; else nash.lastSeenUtc = staroe; }
writeFileSync(put, JSON.stringify(spisok, null, 2));
console.log("последний раз на связи состарен на полчаса, жду выдержку сторожа...");
await zhdat(140000);
const u3 = await uvedomlenia();
const oflayn = (u3.alerts || []).filter(a => a.kind === "offline");
console.log("про офлайн: " + JSON.stringify(oflayn.map(a => a.title)));
ok(oflayn.length >= 1, "уведомление об ушедшем со связи планшете поднято", JSON.stringify(u3).slice(0, 300));
ok(oflayn.some(a => (a.title || "").indexOf("Планшет уведомлений") >= 0),
   "уведомление называет планшет по имени, чтобы оператор знал, куда идти", JSON.stringify(oflayn.map(a => a.title)));

// 5. Вернувшийся планшет снимает уведомление сам.
const { chromium } = await import('playwright');
const br = await chromium.launch({ executablePath: EXE, headless: true });
const str = await (await br.newContext({ viewport: { width: 800, height: 1334 } })).newPage();
await str.goto(BASE + "/");
await str.evaluate(t => localStorage.setItem("sk_device_token", t), para.token);
await str.reload();
await zhdat(40000);
const oflayn2 = ((await uvedomlenia()).alerts || []).filter(a => a.kind === "offline");
console.log("после возвращения про офлайн: " + oflayn2.length);
ok(oflayn2.length === 0, "вернувшийся планшет снимает уведомление сам", JSON.stringify(oflayn2));

await br.close();
console.log(provalov ? ("ПРОВАЛОВ: " + provalov) : "ВСЁ ПРОЙДЕНО");
process.exit(provalov ? 1 : 0);
