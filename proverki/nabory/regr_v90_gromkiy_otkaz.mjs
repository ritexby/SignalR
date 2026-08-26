const BASE = process.env.SK_BASE || 'http://127.0.0.1:5080';
// Отказ обязан объяснять себя.
//
// Тело запроса, которое платформа не смогла разобрать, до обработчика не доходит вовсе: она сама
// отвечает 400 и не пишет ничего. Ни причины, ни следа в журнале. Разобраться в этом снаружи
// нельзя ничем, кроме догадки, и это стоило целого разбирательства: документ с дробным порядком
// элемента («ord»: 12.5) отвергался молча, а выглядело это как «сохранение перестало работать».
// Хуже того, набор проверок при этом мерил чужой документ и зеленел на пустом месте.
let provalov = 0;
const ok = (u, t, z) => { if (u) console.log("PASS " + t); else { provalov++; console.log("FAIL " + t + ": " + (z === undefined ? "" : z)); } };
const vhod = await fetch(BASE + "/api/admin/login", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "test123" }) });
const kuka = (vhod.headers.get("set-cookie") || "").split(";")[0];
const SH = { "Content-Type": "application/json", Cookie: kuka };

const poslat = async (imya, doc) => {
  const o = await fetch(BASE + "/api/admin/document", { method: "PUT", headers: SH, body: JSON.stringify(doc) });
  const t = await o.text();
  console.log(imya.padEnd(42) + " -> " + o.status + " " + t.slice(0, 150).replace(/\s+/g, " "));
  return { status: o.status, telo: t };
};

let r = null;

const osnova = () => ({
  title: "Разбор", signPrompt: "Распишитесь", thankYouText: "Спасибо", idleReturnSec: 0,
  pages: [{ headingRuns: [{ text: "Страница" }], inPdf: true,
            blocks: [{ runs: [{ text: "Пояснение." }], ord: 11 }],
            groups: [], checkboxes: [] }],
  signBlacks: undefined, signBlocks: [], signBlocksBelow: []
});

ok((await poslat("голая страница", osnova())).status === 200, "голая страница сохраняется");

let d = osnova();
d.pages[0].checkboxes = [{ key: "celyy", label: "Целый порядок", ord: 12 }];
r = await poslat("пункт с целым порядком", d);
ok(r.status === 200, "пункт с целым порядком сохраняется", JSON.stringify(r));

d = osnova();
d.pages[0].checkboxes = [{ key: "drobnyy", label: "Дробный порядок", ord: 12.5 }];
r = await poslat("пункт с ДРОБНЫМ порядком 12.5", d);
ok(r.status === 400, "дробный порядок отвергается", String(r.status));
ok(r.telo.length > 0, "и отказ НЕ пустой: у него есть тело", "длина тела " + r.telo.length);
ok(/не разобрано/i.test(r.telo), "в теле сказано, что запрос не разобран", r.telo.slice(0, 120));
ok(/ord/i.test(r.telo) && /целым/i.test(r.telo),
   "и названо, какое именно значение не того вида", r.telo.slice(0, 200));

d = osnova();
d.pages[0].checkboxes = [{ key: "obyaz", label: "Обязательный", required: true, ord: 13 }];
r = await poslat("обязательный пункт", d);
ok(r.status === 200, "обязательный пункт сохраняется", JSON.stringify(r));

d = osnova();
d.pages[0].groups = [{ key: "g0", title: "Вопрос", ord: 10,
  options: [{ key: "da", label: "ДА" }, { key: "net", label: "НЕТ" }] }];
r = await poslat("группа с двумя вариантами", d);
ok(r.status === 200, "группа с двумя вариантами сохраняется", JSON.stringify(r));

d = osnova();
d.pages[0].groups = [{ key: "g0", title: "Вопрос", ord: 10,
  options: [{ key: "da", label: "ДА" }, { key: "net", label: "НЕТ" }] },
  { key: "g1", title: "Второй", ord: 14,
  options: [{ key: "da", label: "ДА" }, { key: "net", label: "НЕТ" }] }];
r = await poslat("две группы", d);
ok(r.status === 200, "две группы сохраняется", JSON.stringify(r));

d = osnova();
d.pages[0].checkboxes = [
  { key: "a", label: "Раз", ord: 12 }, { key: "b", label: "Два", ord: 12.5 },
  { key: "c", label: "Три", required: true, ord: 13 }];
d.pages[0].groups = [{ key: "g0", title: "Вопрос", ord: 10,
  options: [{ key: "da", label: "ДА" }, { key: "net", label: "НЕТ" }] }];
r = await poslat("всё вместе, как в наборе", d);
ok(r.status === 400 && r.telo.length > 0, "смешанный документ тоже отвергается с объяснением", JSON.stringify(r).slice(0, 150));

// Отказ обязан оставлять след: без него у владельца нет способа узнать, что интегратор стучится
// с негодным телом.
const zhurnal = await (await fetch(BASE + "/api/admin/logs?level=warn", { headers: { Cookie: kuka } })).json();
ok(/не разобран/i.test(JSON.stringify(zhurnal)), "отказ попал в журнал", JSON.stringify(zhurnal).slice(0, 200));

console.log(provalov ? ("ПРОВАЛОВ: " + provalov) : "ВСЁ ПРОЙДЕНО");
process.exit(provalov ? 1 : 0);
