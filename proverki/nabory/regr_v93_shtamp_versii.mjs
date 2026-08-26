const BASE = process.env.SK_BASE || 'http://127.0.0.1:5080';
// Отпечаток на ссылках: кэш не должен подсовывать оператору вчерашний admin.js.
//
// Владелец прислал снимки, где на планшете текст крупный, а у оператора обычный, при том что
// прогон на том же коде показывает совпадение. Это признак того, что в браузере оператора
// работает не тот файл, что лежит на сервере. Заголовков сервера мало: перед ним стоит обратный
// прокси, настройка кэша там своя.
//
// Здесь проверяется, что страница отдаётся со ссылками вида /admin/admin.js?v=<отпечаток>, что
// отпечатки у разных файлов разные, что по такому адресу отдаётся тот же самый файл, и главное -
// что админка и планшет с этими адресами живые.
import { chromium } from 'playwright';
const EXE = process.env.SK_CHROME || undefined;
let provalov = 0;
const ok = (u, t, z) => { if (u) console.log("PASS " + t); else { provalov++; console.log("FAIL " + t + ": " + (z === undefined ? "" : z)); } };

// ===== 1. Планшетная страница.
const planStr = await (await fetch(BASE + "/")).text();
const shtamp = (html, adres) => {
  const m = html.match(new RegExp(adres.replace(/[.\/]/g, "\\$&") + "\\?v=([0-9a-f]+)"));
  return m ? m[1] : "";
};
const shKiosk = shtamp(planStr, "/kiosk.js"), shKioskCss = shtamp(planStr, "/kiosk.css");
ok(shKiosk.length > 0, "на странице планшета у kiosk.js есть отпечаток", planStr.match(/src="[^"]*kiosk\.js[^"]*"/) || "ссылки нет вовсе");
ok(shKioskCss.length > 0, "и у kiosk.css тоже", planStr.match(/href="[^"]*kiosk\.css[^"]*"/) || "ссылки нет вовсе");
ok(shKiosk !== shKioskCss, "отпечатки разных файлов разные, значит это не одна общая строка",
   shKiosk + " и " + shKioskCss);

// ===== 2. Страница оператора.
const admStr = await (await fetch(BASE + "/admin/")).text();
const shAdm = shtamp(admStr, "/admin/admin.js"), shAdmCss = shtamp(admStr, "/admin/admin.css");
ok(shAdm.length > 0, "на странице оператора у admin.js есть отпечаток", admStr.match(/src="[^"]*admin\.js[^"]*"/) || "ссылки нет вовсе");
ok(shAdmCss.length > 0, "и у admin.css тоже", admStr.match(/href="[^"]*admin\.css[^"]*"/) || "ссылки нет вовсе");

// ===== 3. По адресу с отпечатком отдаётся тот же файл, а не пусто и не ошибка.
const so = await fetch(BASE + "/admin/admin.js?v=" + shAdm);
const bez = await fetch(BASE + "/admin/admin.js");
const soT = await so.text(), bezT = await bez.text();
ok(so.status === 200, "файл по адресу с отпечатком отдаётся", String(so.status));
ok(soT.length > 1000 && soT === bezT, "и это тот же самый файл, ничего не потерялось",
   "с отпечатком " + soT.length + " знаков, без него " + bezT.length);

// ===== 4. Сама страница не кэшируется, иначе отпечаток в ней тоже застрянет.
const kesh = (await fetch(BASE + "/admin/")).headers.get("cache-control") || "";
ok(/no-cache/.test(kesh), "страница оператора отдаётся с no-cache", kesh || "заголовка нет");
const keshP = (await fetch(BASE + "/")).headers.get("cache-control") || "";
ok(/no-cache/.test(keshP), "страница планшета тоже", keshP || "заголовка нет");

// ===== 5. Главное: с этими адресами обе страницы живые. Ошибка здесь означала бы, что
// разворачивание кладёт систему целиком.
const br = await chromium.launch({ executablePath: EXE, headless: true });
const oshibki = [];
const adm = await (await br.newContext({ viewport: { width: 1400, height: 1000 } })).newPage();
adm.on('pageerror', e => oshibki.push("админка: " + e.message));
adm.on('response', r => { if (r.status() >= 400 && /\.(js|css)/.test(r.url())) oshibki.push("не отдался " + r.url() + ": " + r.status()); });
await adm.goto(BASE + "/admin/");
await adm.fill("#password", "test123");
await adm.click("#loginForm button[type=submit]");
await adm.waitForSelector('#app:not(.hidden)', { timeout: 10000 });
const vkladki = await adm.evaluate(() => document.querySelectorAll(".tab, [data-tab]").length);
ok(vkladki > 0, "админка поднялась и нарисовала вкладки", "вкладок " + vkladki);

const plan = await (await br.newContext({ viewport: { width: 800, height: 1280 } })).newPage();
plan.on('pageerror', e => oshibki.push("планшет: " + e.message));
plan.on('response', r => { if (r.status() >= 400 && /\.(js|css)/.test(r.url())) oshibki.push("не отдался " + r.url() + ": " + r.status()); });
await plan.goto(BASE + "/");
await plan.waitForTimeout(2000);
const estKod = await plan.evaluate(() => !!document.getElementById("enrollCode") || !!document.querySelector(".screen"));
ok(estKod, "страница планшета поднялась");
ok(oshibki.length === 0, "ни один файл не потерялся и ни одна страница не сломалась", oshibki.join("; "));

await br.close();
console.log(provalov ? ("ПРОВАЛОВ: " + provalov) : "ВСЁ ПРОЙДЕНО");
process.exit(provalov ? 1 : 0);
