const BASE = process.env.SK_BASE || 'http://127.0.0.1:5080';
// Вставка из Word приходит без чужого оформления.
//
// Word помечает своим шрифтом, кеглем в пунктах, цветом и заливкой каждый абзац, а иногда и каждое
// слово. Всё это приезжало в документ как есть, и он переставал выглядеть так, как задан в
// конструкторе. Именно отсюда у владельца в заголовке группы оказался относительный размер
// «крупнее», из-за которого экраны расходились: внутренний кегль 26 против 20.
//
// Здесь в редактор вставляется настоящая разметка Word, а потом проверяется, что чужого шрифта,
// кегля, цвета и заливки не осталось, а насыщенность и курсив уцелели: это смысл, а не оформление.
import { chromium } from 'playwright';
const EXE = process.env.SK_CHROME || undefined;
let provalov = 0;
const ok = (u, t, z) => { if (u) console.log("PASS " + t); else { provalov++; console.log("FAIL " + t + ": " + (z === undefined ? "" : z)); } };

const vhod = await fetch(BASE + "/api/admin/login", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "test123" }) });
const kuka = (vhod.headers.get("set-cookie") || "").split(";")[0];
const SH = { "Content-Type": "application/json", Cookie: kuka };

await fetch(BASE + "/api/admin/document", { method: "PUT", headers: SH, body: JSON.stringify({
  title: "Документ для вставки", signPrompt: "Распишитесь", thankYouText: "Спасибо", idleReturnSec: 0,
  pages: [{ headingRuns: [{ text: "Страница" }], inPdf: true, blocks: [{ ord: 1, runs: [{ text: "старое" }] }], checkboxes: [] }],
  signBlocks: [], signBlocksBelow: [] }) });

const br = await chromium.launch({ executablePath: EXE, headless: true });
const adm = await (await br.newContext({ viewport: { width: 1500, height: 1100 } })).newPage();
adm.on('pageerror', e => { console.log("FAIL ошибка в админке: " + e.message); provalov++; });
await adm.goto(BASE + "/admin/");
await adm.fill("#password", "test123");
await adm.click("#loginForm button[type=submit]");
await adm.waitForSelector('#app:not(.hidden)', { timeout: 10000 });
await adm.waitForTimeout(2000);

// Разметка, какую кладёт в буфер настоящий Word: свой шрифт, кегль в пунктах, цвет, заливка.
const ИЗ_WORD = [
  '<html><body><!--StartFragment-->',
  '<p style="margin:0cm;font-size:16.0pt;font-family:Calibri,sans-serif;color:#C00000">',
  '<b><span style="font-size:16.0pt;font-family:Times New Roman,serif;color:#1F4E79">Взятие биоматериала</span></b>',
  '<span style="font-size:11.0pt;font-family:Calibri;background:yellow"> или осмотр врачом</span></p>',
  '<p style="font-size:11.0pt;font-family:Calibri"><i><span style="font-size:11.0pt">накануне или в день сдачи</span></i></p>',
  '<!--EndFragment--></body></html>'
].join("");

const редакторЕсть = await adm.evaluate(() => !!document.querySelector('[contenteditable="true"]'));
ok(редакторЕсть, "редактор текста на странице есть, иначе вставлять некуда");

await adm.evaluate((html) => {
  const ed = document.querySelector('[contenteditable="true"]');
  ed.focus();
  const r = document.createRange(); r.selectNodeContents(ed); r.collapse(false);
  const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
  const dt = new DataTransfer();
  dt.setData("text/html", html);
  dt.setData("text/plain", "Взятие биоматериала или осмотр врачом накануне или в день сдачи");
  ed.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
}, ИЗ_WORD);
await adm.waitForTimeout(1000);

const вРедакторе = await adm.evaluate(() => {
  const ed = document.querySelector('[contenteditable="true"]');
  const плохо = [];
  Array.prototype.slice.call(ed.querySelectorAll("*")).forEach(function (n) {
    const s = n.getAttribute("style") || "";
    if (/font-size|font-family|color|background/i.test(s)) плохо.push(n.tagName + " " + s);
    if (n.classList && (n.classList.contains("rt-l") || n.classList.contains("rt-h")))
      плохо.push(n.tagName + " класс " + n.className);
  });
  return { плохо: плохо, текст: (ed.textContent || "").slice(0, 70),
           // Редактор хранит насыщенность и курсив стилем, а не тегами b и i: считаем по тому,
           // как это выглядит на самом деле, а не по именам тегов.
           жирных: Array.prototype.slice.call(ed.querySelectorAll("*"))
             .filter(n => parseInt(getComputedStyle(n).fontWeight, 10) >= 600).length,
           курсивных: Array.prototype.slice.call(ed.querySelectorAll("*"))
             .filter(n => getComputedStyle(n).fontStyle === "italic").length };
});
console.log("в редакторе после вставки: " + JSON.stringify(вРедакторе));
ok(/Взятие биоматериала/.test(вРедакторе.текст), "текст вставился", вРедакторе.текст);
ok(вРедакторе.плохо.length === 0, "чужого шрифта, кегля, цвета и заливки не осталось",
   вРедакторе.плохо.join(" | "));
ok(вРедакторе.жирных > 0, "насыщенность уцелела: это смысл, а не оформление", String(вРедакторе.жирных));
ok(вРедакторе.курсивных > 0, "и курсив тоже", String(вРедакторе.курсивных));

await br.close();
console.log(provalov ? ("ПРОВАЛОВ: " + provalov) : "ВСЁ ПРОЙДЕНО");
process.exit(provalov ? 1 : 0);
