const BASE = process.env.SK_BASE || 'http://127.0.0.1:5080';
// Управление планшетом из админки: перезагрузка, экран, яркость, громкость, голос, снимок экрана,
// показания. Настоящего планшета с FreeKiosk здесь нет, его роль играет свой сервер: он
// записывает, что именно к нему пришло. Проверяется не «ответ 200», а путь, заголовок с ключом и
// тело каждого запроса.
//
// Адрес подставного планшета берётся из SK_TABLET_IP. По умолчанию 192.0.2.2 (документационная
// сеть). Петля 127.0.0.1 не годится нарочно: служба её отвергает как адрес планшета.
import { createServer } from 'node:http';
let provalov = 0;
const ok = (u, t, z) => { if (u) console.log("PASS " + t); else { provalov++; console.log("FAIL " + t + ": " + (z === undefined ? "" : z)); } };

const PORT = Number(new URL(BASE).port) + 1000;
const ADRES = process.env.SK_TABLET_IP || "192.0.2.2";
const PRISHLO = [];
const SNIMOK = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

const planshet = createServer((req, res) => {
  let telo = "";
  req.on("data", ch => { telo += ch; });
  req.on("end", () => {
    PRISHLO.push({ metod: req.method, put: req.url, kluch: req.headers["x-api-key"] || null, telo });
    if (req.url === "/api/status") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({
        battery: { level: 64, charging: true }, wifi: { signal: 71, ssid: "Klinika-WiFi" },
        storage: { free: 3000000000, total: 12000000000 }, memory: { freePercent: 41 },
        brightness: 80, screenOn: true, deviceOwner: true,
        appVersion: "1.2.3", androidVersion: "13", model: "Lenovo Tab M10"
      }));
    }
    if (req.url === "/api/screenshot") { res.writeHead(200, { "Content-Type": "image/png" }); return res.end(SNIMOK); }
    if (req.url === "/api/clearCache") { res.writeHead(500); return res.end("boom"); }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
});
try {
  await new Promise((gotovo, beda) => { planshet.on("error", beda); planshet.listen(PORT, ADRES, gotovo); });
} catch (e) {
  console.log("НАБОР НЕ ПРИМЕНИМ: не удалось занять " + ADRES + ":" + PORT + " (" + e.message + ").");
  console.log("Задайте SK_TABLET_IP адресом этой машины в локальной сети, не петлёй.");
  process.exit(0);
}
console.log("подставной планшет слушает " + ADRES + ":" + PORT);

const vhod = await fetch(BASE + "/api/admin/login", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "test123" }) });
const kuka = (vhod.headers.get("set-cookie") || "").split(";")[0];
const SH = { "Content-Type": "application/json", Cookie: kuka };
const K = { Cookie: kuka };

const kod = await (await fetch(BASE + "/api/admin/devices/enroll", {
  method: "POST", headers: SH, body: JSON.stringify({ name: "Планшет управления" }) })).json();
const para = await (await fetch(BASE + "/api/kiosk/enroll", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: kod.code }) })).json();
const D = para.deviceId;
const nastroit = (vkl, kluch) => fetch(BASE + "/api/admin/kiosk-control/settings", { method: "PUT", headers: SH, body: JSON.stringify({
  enabled: vkl, port: PORT, timeoutSec: 5, autoHeal: false, autoHealAfterMinutes: 10,
  batteryWarnPercent: 20, storageWarnPercent: 10, apiKey: kluch }) });

// 1. Пока управление выключено, ни одна команда не должна уходить наружу.
await nastroit(false, "kluch-upravlenia");
await fetch(BASE + "/api/admin/devices/" + D + "/control-address", {
  method: "PUT", headers: SH, body: JSON.stringify({ ip: ADRES, port: PORT }) });
const bylo = PRISHLO.length;
const vykl = await fetch(BASE + "/api/admin/devices/" + D + "/kiosk/reboot", { method: "POST", headers: SH, body: "{}" });
const vyklTelo = await vykl.json().catch(() => null);
console.log("при выключенном управлении: " + vykl.status + " " + JSON.stringify(vyklTelo));
ok(vykl.status === 502 && /выключено/i.test(JSON.stringify(vyklTelo)),
   "выключенное управление отвечает причиной, а не общей ошибкой", JSON.stringify(vyklTelo));
ok(PRISHLO.length === bylo, "и до планшета при этом ничего не ушло", String(PRISHLO.length - bylo));

// 2. Негодный ключ отвергается сразу, а не превращается в «планшет не отвечает».
const plohoy = await nastroit(true, "ключ по-русски");
const plohoeTelo = await plohoy.json().catch(() => null);
ok(plohoy.status === 400 && /ключ/i.test(JSON.stringify(plohoeTelo)),
   "ключ, который нельзя послать в заголовке, отвергнут при сохранении", JSON.stringify(plohoeTelo));
await nastroit(true, "kluch-upravlenia");

const poslednee = () => PRISHLO[PRISHLO.length - 1] || {};
const komanda = async (imya, telo) => {
  const o = await fetch(BASE + "/api/admin/devices/" + D + "/kiosk/" + imya, {
    method: "POST", headers: SH, body: JSON.stringify(telo || {}) });
  return { status: o.status, telo: await o.json().catch(() => null) };
};

// 3. Каждая команда уходит по своему пути и с ключом.
const puti = [["reboot", "/api/reboot"], ["restart-app", "/api/restart-ui"], ["reload", "/api/reload"],
              ["screen-on", "/api/screen/on"], ["screen-off", "/api/screen/off"],
              ["beep", "/api/audio/beep"], ["wake", "/api/wake"]];
let vsePuti = true, vseKluchi = true;
for (const [imya, put] of puti) {
  const o = await komanda(imya);
  const p = poslednee();
  if (o.status !== 200 || p.put !== put) { vsePuti = false; console.log("  .. " + imya + " -> " + o.status + " " + p.put); }
  if (p.kluch !== "kluch-upravlenia") { vseKluchi = false; console.log("  .. " + imya + " без ключа: " + p.kluch); }
}
ok(vsePuti, "каждая команда ушла на планшет по своему пути", "см. строки выше");
ok(vseKluchi, "каждая команда ушла с ключом управления в заголовке", "см. строки выше");

// 4. Выдуманная команда не превращается в произвольный вызов планшета.
const byloDo = PRISHLO.length;
const vydumka = await komanda("opasno");
ok(vydumka.status === 400, "выдуманная команда отвергнута", String(vydumka.status));
ok(PRISHLO.length === byloDo, "и до планшета не дошла вовсе", String(PRISHLO.length - byloDo));

// 5. Планшет ответил ошибкой: оператор должен узнать об этом.
const sboy = await komanda("clear-cache");
console.log("планшет ответил 500: " + sboy.status + " " + JSON.stringify(sboy.telo));
ok(sboy.status === 502 && /50[0-9]/.test(JSON.stringify(sboy.telo)),
   "отказ планшета показан отказом, а не успехом", JSON.stringify(sboy.telo));
const zhurnal = await (await fetch(BASE + "/api/admin/logs?level=warn", { headers: K })).json();
ok(JSON.stringify(zhurnal).indexOf("Очистка кэша") >= 0,
   "неудавшаяся команда попала в журнал", JSON.stringify(zhurnal).slice(0, 200));

// 6. Яркость и громкость приводятся к границам, и ответ говорит какое число взято.
const yarkost = await komanda("brightness", { value: 999 });
console.log("яркость 999: " + JSON.stringify(yarkost.telo) + " тело запроса: " + poslednee().telo);
ok(yarkost.telo && yarkost.telo.value === 100, "яркость приведена к сотне", JSON.stringify(yarkost.telo));
ok((poslednee().telo || "").indexOf("100") >= 0, "и на планшет ушло именно это число", poslednee().telo);
const gromkost = await komanda("volume", { value: -20 });
ok(gromkost.telo && gromkost.telo.value === 0, "громкость приведена к нулю", JSON.stringify(gromkost.telo));

// 7. Голос и всплывашка.
ok((await komanda("say", { text: "   " })).status === 400, "пустой текст для голоса отвергнут");
ok((await komanda("say", { text: "я".repeat(501) })).status === 400, "слишком длинный текст для голоса отвергнут");
const golos = await komanda("say", { text: "Пройдите в кабинет три" });
// Русские буквы уходят экранированными, вида Про. Это тот же самый текст в записи
// JSON, а не поломка, поэтому сравнивается разобранное тело, а не подстрока в сыром.
const teloGolosa = JSON.parse(poslednee().telo || "{}");
ok(golos.status === 200 && teloGolosa.text === "Пройдите в кабинет три" && teloGolosa.locale === "ru-RU",
   "текст для голоса дошёл до планшета целиком и с русским языком", poslednee().telo);
const vsplyvashka = await komanda("toast", { text: "Ваша очередь" });
ok(vsplyvashka.status === 200 && poslednee().put === "/api/toast", "всплывашка дошла", poslednee().put);

// 8. Показания планшета разобраны, а не пересказаны как есть.
const zdorovie = await (await fetch(BASE + "/api/admin/devices/" + D + "/kiosk/health", { headers: K })).json();
console.log("показания: " + JSON.stringify(zdorovie).slice(0, 200));
ok(zdorovie.reachable === true, "планшет считается доступным", JSON.stringify(zdorovie));
ok(zdorovie.batteryPercent === 64 && zdorovie.charging === true, "заряд и зарядка разобраны", JSON.stringify(zdorovie));
ok(zdorovie.wifiSsid === "Klinika-WiFi" && zdorovie.wifiSignalPercent === 71, "сеть разобрана", JSON.stringify(zdorovie));
ok(zdorovie.storageFreePercent === 25, "свободное место посчитано из долей, а не взято чужое поле", String(zdorovie.storageFreePercent));
ok(zdorovie.memoryFreePercent === 41, "свободная память разобрана", String(zdorovie.memoryFreePercent));
ok(zdorovie.model === "Lenovo Tab M10" && zdorovie.androidVersion === "13", "модель и версия разобраны", JSON.stringify(zdorovie));

// 9. Снимок экрана доходит картинкой.
const snimok = await fetch(BASE + "/api/admin/devices/" + D + "/kiosk/screenshot", { headers: K });
const tip = snimok.headers.get("content-type") || "";
const bayty = Buffer.from(await snimok.arrayBuffer());
console.log("снимок: " + snimok.status + " " + tip + " " + bayty.length + " байт");
ok(snimok.status === 200 && tip.indexOf("image/png") >= 0 && bayty.length === SNIMOK.length,
   "снимок экрана дошёл до админки картинкой", snimok.status + " " + tip + " " + bayty.length);

// 10. Планшета нет по сети: причина по-русски.
await fetch(BASE + "/api/admin/devices/" + D + "/control-address", {
  method: "PUT", headers: SH, body: JSON.stringify({ ip: "192.0.2.77", port: PORT }) });
const mimo = await komanda("reboot");
console.log("планшет не отвечает: " + mimo.status + " " + JSON.stringify(mimo.telo));
ok(mimo.status === 502 && /планшет/i.test(JSON.stringify(mimo.telo)),
   "недоступный планшет объяснён оператору по-русски", JSON.stringify(mimo.telo));

// 11. Адрес управления это адрес планшета, а не что угодно.
const svoy = await fetch(BASE + "/api/admin/devices/" + D + "/control-address", {
  method: "PUT", headers: SH, body: JSON.stringify({ ip: "127.0.0.1", port: PORT }) });
ok(svoy.status === 400, "петля на сам сервер как адрес планшета отвергнута", String(svoy.status));
const imya = await fetch(BASE + "/api/admin/devices/" + D + "/control-address", {
  method: "PUT", headers: SH, body: JSON.stringify({ ip: "example.com", port: PORT }) });
ok(imya.status === 400, "имя узла вместо адреса отвергнуто", String(imya.status));

planshet.close();
console.log(provalov ? ("ПРОВАЛОВ: " + provalov) : "ВСЁ ПРОЙДЕНО");
process.exit(provalov ? 1 : 0);
