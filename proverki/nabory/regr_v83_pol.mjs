const BASE = process.env.SK_BASE || 'http://127.0.0.1:5080';
// Условие по тегу «Пол», написанному в заказе как «ПОЛ». Служба сравнивает имена тегов без учёта
// регистра, и редактор обязан считать так же. До версии 7.9 прожектор сравнивал строки точно,
// значения не находил и на любое значение писал «а сейчас пусто»: оператор видел «блок скрыт»
// там, где на планшете блок показывался, и правильно показывался.
import { chromium } from 'playwright';
const EXE = process.env.SK_CHROME || undefined;
let provalov = 0;
const ok = (u, t, z) => { if (u) console.log("PASS " + t); else { provalov++; console.log("FAIL " + t + ": " + (z === undefined ? "" : z)); } };

const vhod = await fetch(BASE + "/api/admin/login", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "test123" }) });
const kuka = (vhod.headers.get("set-cookie") || "").split(";")[0];
const SH = { "Content-Type": "application/json", Cookie: kuka };
const K = { Cookie: kuka };

// В тексте тег {{ПОЛ}}, а условие на поле «Пол» из списка редактора: разное написание нарочно.
const dokument = {
  title: "Согласие", signPrompt: "Распишитесь", thankYouText: "Спасибо", idleReturnSec: 0,
  pages: [{
    headingRuns: [{ text: "Шаг 1" }], inPdf: true,
    blocks: [{ runs: [{ text: "Пациент: {{ФИО}}, пол {{ПОЛ}}" }], ord: 0 }],
    groups: [{
      key: "devstvennost", title: "Девственность", ord: 1,
      options: [{ key: "da", label: "ДА" }, { key: "net", label: "НЕТ" }],
      visibleWhen: { field: "Пол", op: "eq", value: "F", and: [{ field: "UG", op: "eq", value: "true" }] }
    }],
    checkboxes: []
  }],
  signBlocks: [], signBlocksBelow: []
};
ok((await fetch(BASE + "/api/admin/document", { method: "PUT", headers: SH, body: JSON.stringify(dokument) })).status === 200,
   "документ сохранён");

const kod = await (await fetch(BASE + "/api/admin/devices/enroll", {
  method: "POST", headers: SH, body: JSON.stringify({ name: "Планшет пола" }) })).json();
const para = await (await fetch(BASE + "/api/kiosk/enroll", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: kod.code }) })).json();

const naEkrane = async () => {
  const j = await (await fetch(BASE + "/api/admin/devices/" + para.deviceId + "/screen", { headers: K })).json();
  const str = (((j.document || {}).pages) || [])[0] || {};
  return { grupp: (str.groups || []).length, imena: (str.groups || []).map(g => g.key) };
};
const poslat = (polya) => fetch(BASE + "/api/admin/show-document", { method: "POST", headers: SH,
  body: JSON.stringify(Object.assign({ target: "device:" + para.deviceId }, polya === null ? {} : { fields: polya })) });

// 1. Заказ с тегом в ДРУГОМ написании: ПОЛ вместо Пол.
await poslat({ "ФИО": "Тест", "ПОЛ": "F", "UG": "true" });
const e1 = await naEkrane();
console.log("заказ {ПОЛ:F, UG:true}: групп " + e1.grupp + " " + JSON.stringify(e1.imena));
ok(e1.grupp === 1, "тег в другом написании узнан, группа показана", JSON.stringify(e1));

// 2. Заказ с тем же написанием, что в условии.
await poslat({ "ФИО": "Тест", "Пол": "F", "UG": "true" });
ok((await naEkrane()).grupp === 1, "тег в том же написании узнан");

// 3. Мужчина: женская группа показаться НЕ должна.
await poslat({ "ФИО": "Тест", "ПОЛ": "M", "UG": "true" });
ok((await naEkrane()).grupp === 0, "мужчине женская группа НЕ показана");

// 4. Отправка без тегов вовсе: условие по тегу не выполнено.
await poslat({});
ok((await naEkrane()).grupp === 0, "без тегов группа НЕ показана");
await poslat(null);
ok((await naEkrane()).grupp === 0, "без поля fields группа тоже НЕ показана");

// 5. Прожектор в редакторе.
const br = await chromium.launch({ executablePath: EXE, headless: true });
const p = await (await br.newContext({ viewport: { width: 1500, height: 1000 } })).newPage();
p.on('pageerror', e => { console.log("FAIL ошибка в админке: " + e.message); provalov++; });
await p.goto(BASE + "/admin/");
await p.fill('#password', 'test123');
await p.click('#loginForm button[type=submit]');
await p.waitForSelector('#app:not(.hidden)', { timeout: 10000 });
const otkaz = p.locator('.modal button', { hasText: 'Отказаться от черновика' });
try { await otkaz.waitFor({ state: 'visible', timeout: 2500 }); await otkaz.click(); } catch {}
await p.click('.tab[data-tab="document"]');
await p.waitForSelector('[data-panel="document"]:not(.hidden)', { timeout: 5000 });
await p.check('input[data-role="spoton"]');
await p.waitForTimeout(800);

const polya = await p.evaluate(() => Array.prototype.slice.call(
  document.querySelectorAll('.spotlight-fields label.field-sm')).map(l => l.childNodes[0].nodeValue));
console.log("поля в панели прожектора: " + JSON.stringify(polya));
ok(polya.length > 0, "панель прожектора построена", JSON.stringify(polya));

async function zadat(imya, znachenie) {
  return await p.evaluate(function (para) {
    var metki = Array.prototype.slice.call(document.querySelectorAll('.spotlight-fields label.field-sm'));
    for (var i = 0; i < metki.length; i++) {
      if ((metki[i].childNodes[0].nodeValue || "").trim() === para[0]) {
        var pole = metki[i].querySelector('input, select');
        if (!pole) return false;
        pole.value = para[1];
        pole.dispatchEvent(new Event('input', { bubbles: true }));
        pole.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }
    }
    return false;
  }, [imya, znachenie]);
}
await zadat("ПОЛ", "F");
await zadat("UG", "true");
await p.waitForTimeout(700);

const proGruppu = async () => await p.evaluate(() => {
  var uzly = Array.prototype.slice.call(document.querySelectorAll('[data-spot-why], .spot-off'));
  var svoi = uzly.filter(function (u) { return (u.textContent || "").indexOf("Девственность") >= 0; });
  var u = svoi[0] || null;
  return { pogasheno: !!(u && u.classList.contains("spot-off")),
           pochemu: u ? (u.getAttribute("data-spot-why") || "") : "" };
});

const zh = await proGruppu();
console.log("при ПОЛ=F, UG=true: " + JSON.stringify(zh));
ok(!zh.pogasheno, "при подходящих значениях группа в редакторе не гаснет", JSON.stringify(zh));

// ГЛАВНОЕ: подсказка обязана назвать настоящее значение, а не «пусто».
await zadat("ПОЛ", "M");
await p.waitForTimeout(700);
const m = await proGruppu();
console.log("при ПОЛ=M, UG=true: " + JSON.stringify(m));
ok(m.pogasheno, "при неподходящем поле группа в редакторе гаснет", JSON.stringify(m));
ok(/сейчас/.test(m.pochemu) && !/сейчас пусто/.test(m.pochemu),
   "подсказка называет настоящее значение поля, а не «пусто»", JSON.stringify(m));
ok(/m/i.test(m.pochemu), "и это именно то значение, которое задано", JSON.stringify(m));

await br.close();
console.log(provalov ? ("ПРОВАЛОВ: " + provalov) : "ВСЁ ПРОЙДЕНО");
process.exit(provalov ? 1 : 0);
