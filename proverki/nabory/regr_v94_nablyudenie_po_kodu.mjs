const BASE = process.env.SK_BASE || 'http://127.0.0.1:5080';
// То же, что regr_v92, но наблюдение открыто по коду планшета, а не по имени.
//
// Владелец открывает окно по адресу вида #watch=dev-c765ffd530. Все прочие наборы открывают его
// по имени, и этот путь до сих пор не мерился ни разу.
//
// Владелец увидел расхождение на втором шаге после увеличения на первом и потребовал проверить
// не только крайнее положение, а одиночное, двойное и тройное увеличение. Прежний набор жал
// «Крупнее» до упора и на промежуточных ступенях не проверял ничего.
//
// Здесь для каждой ступени клиент увеличивает текст на первой странице, сверяется первая
// страница, затем клиент уходит на вторую, и сверяется она. Меряется не одно только кегль
// основного текста, а всё, что задаёт раскладку: заголовок раздела, заголовок группы, подпись
// отметки, размер квадратика, высота окна, высота содержимого и набор пунктов, целиком попавших
// в видимую часть.
import { chromium } from 'playwright';
const EXE = process.env.SK_CHROME || undefined;
let provalov = 0;
const ok = (u, t, z) => { if (u) console.log("PASS " + t); else { provalov++; console.log("FAIL " + t + ": " + (z === undefined ? "" : z)); } };

const vhod = await fetch(BASE + "/api/admin/login", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "test123" }) });
const kuka = (vhod.headers.get("set-cookie") || "").split(";")[0];
const SH = { "Content-Type": "application/json", Cookie: kuka };

// Вторая страница взята с фотографии владельца: длинные заголовки групп, пояснения между ними,
// столбик отметок. Такая страница длиннее экрана, значит расхождение видно сразу.
const gruppy = [
  ["Прием лекарственных средств, БАДов, гормональных препаратов, химиотерапии  в течение последних 2-х недель", 10],
  ["С момента последнего мочеиспускания прошло не менее 1,5-2 ч", 20],
  ["Взятие биоматериала или осмотр врачом акушером-гинекологом накануне или в день сдачи анализов", 21],
  ["Девственность", 22]
].map(([t, o], i) => ({ key: "g" + i, title: t, ord: o,
  options: [{ key: "da", label: "ДА" }, { key: "net", label: "НЕТ" }] }));

const otvet = await fetch(BASE + "/api/admin/document", { method: "PUT", headers: SH, body: JSON.stringify({
  title: "1 Соглашение о проведении медицинского вмешательства",
  signPrompt: "Распишитесь", thankYouText: "Спасибо", idleReturnSec: 0,
  pages: [
    { headingRuns: [{ text: "1. Проверка персональных данных" }], inPdf: true, bigText: true,
      blocks: [{ runs: [{ text: "Проверьте свои данные. Если что-то указано неверно, сообщите регистратору." }], ord: 1 }],
      checkboxes: [] },
    { headingRuns: [{ text: "2. Информация, необходимая для проведения лабораторного исследования" }],
      inPdf: true,
      blocks: [
        { runs: [{ text: "В случае приема препаратов сообщите медицинскому регистратору кодовое слово \"ЛП1\" и назовите название препарата. Например \"ЛП1 - витамины\"" }], ord: 11 },
        { runs: [{ text: "При наличии беременности сообщите медицинскому регистратору кодовое слово Б1 и назовите срок в неделях. Например, Б1 = 14" }], ord: 23 }
      ],
      groups: gruppy,
      checkboxes: [
        { key: "gormony", label: "Гормоны", ord: 12 },
        { key: "antibiotiki", label: "Антибиотики", ord: 13 },
        { key: "himio", label: "Химиотерапия", ord: 14 },
        { key: "bady", label: "БАДы, витамины", ord: 15 },
        { key: "drugoe", label: "Другое", ord: 16 }
      ] }
  ],
  signBlocks: [], signBlocksBelow: [] }) });
ok(otvet.status === 200, "документ сохранён, иначе меряли бы чужой", otvet.status + " " + (await otvet.text()).slice(0, 160));

const kod = await (await fetch(BASE + "/api/admin/devices/enroll", {
  method: "POST", headers: SH, body: JSON.stringify({ name: "Планшет по коду" }) })).json();
const para = await (await fetch(BASE + "/api/kiosk/enroll", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: kod.code }) })).json();

const br = await chromium.launch({ executablePath: EXE, headless: true });
const plan = await (await br.newContext({ viewport: { width: 800, height: 1280 } })).newPage();
plan.on('pageerror', e => { console.log("FAIL ошибка на планшете: " + e.message); provalov++; });
await plan.goto(BASE + "/");
await plan.evaluate(t => localStorage.setItem("sk_device_token", t), para.token);
await plan.reload();
await plan.waitForTimeout(2500);

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

// Одна мерка на обе стороны: имена узлов разные, смысл один. offsetHeight и computed font-size
// сжатию сцены (0.815) не подвержены, в отличие от getBoundingClientRect.
const merka = (im) => {
  const kegl = (s) => { const u = document.querySelector(s); return u ? Math.round(parseFloat(getComputedStyle(u).fontSize) * 10) / 10 : 0; };
  const b = document.querySelector(im.telo);
  const r = b.getBoundingClientRect();
  const vidno = Array.prototype.slice.call(b.querySelectorAll(im.punkt))
    .filter(u => { const a = u.getBoundingClientRect(); return a.top >= r.top - 2 && a.bottom <= r.bottom + 2; })
    .map(u => (u.textContent || "").replace(/\s+/g, "").trim().slice(0, 26));
  const kv = document.querySelector(im.kvadrat);
  const vys = (s) => { const u = document.querySelector(s); return u ? Math.round(u.offsetHeight * 10) / 10 : 0; };
  return { tekst: kegl(im.tekst), razdel: kegl(im.razdel), gruppa: kegl(im.gruppa), podpis: kegl(im.podpis),
           kvadrat: kv ? Math.round(kv.offsetWidth) : 0,
           shapka: vys(im.shapka), podval: vys(im.podval), ramka: vys(im.ramka),
           okno: Math.round(b.clientHeight), vsego: Math.round(b.scrollHeight), vidno: vidno };
};
const IM_P = { telo: ".doc-body", tekst: ".doc-text", razdel: ".doc-body h2", gruppa: ".group-title",
               podpis: ".check .label", kvadrat: ".check input", punkt: ".check, .group",
               shapka: ".doc-header", podval: ".doc-footer", ramka: ".doc-frame" };
const IM_N = { telo: ".wt-body", tekst: ".watch-screen .pv-text", razdel: ".watch-screen .pv-heading",
               gruppa: ".watch-screen .pv-group-title", podpis: ".watch-label", kvadrat: ".watch-box",
               punkt: ".watch-check, .pv-group",
               shapka: ".wt-head", podval: ".wt-foot", ramka: ".wt-frame" };

async function sverit(gde, stupen) {
  await nabl.waitForTimeout(2000);
  const p = await plan.evaluate(merka, IM_P), n = await nabl.evaluate(merka, IM_N);
  const im = "ступень " + stupen + ", " + gde;
  console.log("\n== " + im);
  console.log("  планшет:    " + JSON.stringify({ tekst: p.tekst, razdel: p.razdel, gruppa: p.gruppa, podpis: p.podpis, kvadrat: p.kvadrat, shapka: p.shapka, podval: p.podval, okno: p.okno, vsego: p.vsego }));
  console.log("  наблюдение: " + JSON.stringify({ tekst: n.tekst, razdel: n.razdel, gruppa: n.gruppa, podpis: n.podpis, kvadrat: n.kvadrat, shapka: n.shapka, podval: n.podval, okno: n.okno, vsego: n.vsego }));
  const kegli = [["основной текст", "tekst"], ["заголовок раздела", "razdel"], ["заголовок группы", "gruppa"], ["подпись отметки", "podpis"]];
  for (const [imya, klyuch] of kegli)
    ok(Math.abs(p[klyuch] - n[klyuch]) < 0.6, im + ": " + imya + " того же кегля", p[klyuch] + " против " + n[klyuch]);
  ok(Math.abs(p.kvadrat - n.kvadrat) <= 2, im + ": квадратик отметки того же размера", p.kvadrat + " против " + n.kvadrat);
  ok(Math.abs(p.shapka - n.shapka) <= 1, im + ": шапка той же высоты", p.shapka + " против " + n.shapka);
  ok(Math.abs(p.podval - n.podval) <= 1, im + ": подвал той же высоты", p.podval + " против " + n.podval);
  ok(Math.abs(p.okno - n.okno) <= 8, im + ": окно той же высоты", p.okno + " против " + n.okno);
  ok(Math.abs(p.vsego - n.vsego) <= 24, im + ": содержимое той же высоты", p.vsego + " против " + n.vsego);
  ok(JSON.stringify(p.vidno) === JSON.stringify(n.vidno), im + ": целиком видно одно и то же",
     "\n     планшет  " + JSON.stringify(p.vidno) + "\n     оператор " + JSON.stringify(n.vidno));
  return { p, n };
}

const zhat = async (kuda, skolko) => {
  for (let i = 0; i < skolko; i++) {
    const mozhno = await plan.evaluate(id => { const k = document.getElementById(id); return !!(k && !k.disabled); }, kuda);
    if (!mozhno) return i;
    await plan.click("#" + kuda);
    await plan.waitForTimeout(400);
  }
  return skolko;
};

// Ступени: одна, две, три и до упора. Между заходами возвращаемся на первую страницу и
// уменьшаем обратно до обычного, чтобы каждая ступень проверялась начисто.
const bylo = [];
for (const stupen of [1, 2, 4]) {
  const podnyali = await zhat("bigTextPlus", stupen);
  ok(podnyali === stupen, "ступень " + stupen + ": нажатий прошло столько, сколько нужно", "прошло " + podnyali);
  const s1 = await sverit("первая страница", stupen);
  bylo.push(s1.p.tekst);
  await plan.click("#btnNext");
  await plan.waitForTimeout(1600);
  await sverit("вторая страница", stupen);
  await plan.click(".doc-footer .btn-ghost");
  await plan.waitForTimeout(1600);
  await zhat("bigTextMinus", stupen);
  await plan.waitForTimeout(400);
}
console.log("\nкегли по ступеням: " + JSON.stringify(bylo));
ok(bylo[0] < bylo[1] && bylo[1] < bylo[2], "ступени действительно разные, иначе сверять нечего", JSON.stringify(bylo));

await br.close();
console.log(provalov ? ("ПРОВАЛОВ: " + provalov) : "ВСЁ ПРОЙДЕНО");
process.exit(provalov ? 1 : 0);
