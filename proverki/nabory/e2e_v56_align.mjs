// Выравнивание абзаца и размер шрифта в PDF.
import { chromium } from 'playwright';
const BASE = 'http://127.0.0.1:5080';
// Путь к браузеру берётся из окружения: на другой машине он другой, а зашитый путь
// превращал набор в неработающий у всех, кроме одной установки. Пусто значит
// «пусть Playwright возьмёт свой», как он и делает по умолчанию.
const EXE = process.env.SK_CHROME || undefined;
let fail = 0;
const ok = (c, m) => { if (c) console.log('PASS', m); else { console.error('FAIL', m); fail++; } };

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const p = await (await browser.newContext()).newPage();
await p.goto(BASE + '/admin/');
await p.fill('#password', 'test123'); await p.click('#loginForm button[type=submit]');
await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
const call = (path, opts) => p.evaluate(async ([pa, o]) => {
  const r = await fetch('/api/admin' + pa, Object.assign({ credentials: 'same-origin' }, o || {}));
  let b = null; try { b = await r.json(); } catch {} return { status: r.status, body: b };
}, [path, opts]);

const абз = 'Настоящим подтверждаю, что ознакомлен с порядком оказания услуг и с условиями обработки моих персональных данных в соответствии с законодательством.';
const док = (align, scale) => ({
  title: 'ДОГОВОР', signPrompt: 'x', thankYouText: 'x', idleReturnSec: 0, pdfFontScale: scale || 100,
  pages: [{ headingRuns: [{ text: 'Условия' }], headingAlign: align === 'justify' ? 'center' : align,
    blocks: [{ runs: [{ text: абз }], ord: 0, align: align }],
    checkboxes: [], groups: [], signatures: [], scans: [] }],
  signBlocks: [], signBlocksBelow: [] });

const раскладка = async (align, scale) => {
  await call('/document', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(док(align, scale)) });
  const r = await call('/document/pdf-layout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  ok(r.status === 200, 'раскладка отдаётся для выравнивания «' + align + '»');
  return r.body;
};

// Строки собираем по y: слова одной строки стоят на одной высоте.
const строки = (L) => {
  const m = {};
  L.items.filter(i => i.kind === 'text' && !/ДОГОВОР|Дата:|Условия|Подпись/.test(i.text))
    .forEach(i => { const k = i.page + ':' + Math.round(i.y); (m[k] = m[k] || []).push(i); });
  return Object.values(m).map(ws => {
    ws.sort((a, b) => a.x - b.x);
    return { left: ws[0].x, right: ws[ws.length - 1].x + ws[ws.length - 1].w, words: ws.length,
             text: ws.map(w => w.text).join(' ') };
  });
};

const слева = строки(await раскладка(''));
ok(слева.length >= 2, 'абзац занял несколько строк: ' + слева.length);
ok(слева.every(l => Math.abs(l.left - 50) < 0.5), 'по левому краю все строки начинаются от поля');
ok(Math.abs(слева[0].right - 545) > 3, 'и правый край рваный, как и положено: ' + Math.round(слева[0].right));

const поЦентру = строки(await раскладка('center'));
ok(поЦентру.every(l => l.left > 50.5), 'по центру строки отступают слева');
ok(Math.abs((поЦентру[0].left - 50) - (545 - поЦентру[0].right)) < 1.5,
  'и отступы слева и справа равны: ' + Math.round(поЦентру[0].left - 50) + ' и ' + Math.round(545 - поЦентру[0].right));

const справа = строки(await раскладка('right'));
ok(справа.every(l => Math.abs(l.right - 545) < 1), 'по правому краю все строки кончаются у поля');
ok(справа[0].left > 50.5, 'а слева отступ: ' + Math.round(справа[0].left - 50));

const поОбоим = строки(await раскладка('justify'));
const кромеПоследней = поОбоим.slice(0, -1);
ok(кромеПоследней.length >= 1, 'в абзаце есть строки, кроме последней');
ok(кромеПоследней.every(l => Math.abs(l.left - 50) < 0.5 && Math.abs(l.right - 545) < 1),
  'по обоим краям строки прижаты к обоим полям: ' + кромеПоследней.map(l => Math.round(l.right)).join(','));
const последняя = поОбоим[поОбоим.length - 1];
ok(последняя.right < 544, 'последняя строка абзаца не растянута: ' + Math.round(последняя.right));

// Размер шрифта в PDF.
const сто = await раскладка('', 100);
const пятьдесят = await раскладка('', 50);
const размер = (L) => L.items.find(i => i.kind === 'text' && i.text.length > 3).size;
ok(Math.abs(размер(пятьдесят) - размер(сто) / 2) < 0.01,
  'при 50% шрифт вдвое мельче: ' + размер(сто) + ' и ' + размер(пятьдесят));
ok(пятьдесят.items.filter(i => i.kind === 'text').length >= сто.items.filter(i => i.kind === 'text').length,
  'текст никуда не делся');
const строкиСто = строки(сто).length, строки50 = строки(пятьдесят).length;
ok(строки50 < строкиСто, 'мелким шрифтом абзац занимает меньше строк: ' + строкиСто + ' и ' + строки50);

// Границы: 200% и 10% приводятся к разрешённому.
await call('/document', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(док('', 200)) });
ok(((await call('/document')).body.pdfFontScale) === 100, 'больше 100% не бывает');
await call('/document', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(док('', 10)) });
ok(((await call('/document')).body.pdfFontScale) === 50, 'меньше 50% тоже');

// Размер места под подпись задаётся отдельно от шрифта.
const сПодписью = async (signScale) => {
  const d = док('', 100); d.pdfSignatureScale = signScale;
  await call('/document', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(d) });
  const r = await call('/document/pdf-layout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  return r.body.items.find(i => i.kind === 'sign');
};
const подпись100 = await сПодписью(100);
const подпись50 = await сПодписью(50);
ok(подпись100.w === 280 && подпись100.h === 100, 'обычное место под подпись 280×100: ' + подпись100.w + '×' + подпись100.h);
ok(подпись50.w === 140 && подпись50.h === 50, 'при 50% место вдвое меньше: ' + подпись50.w + '×' + подпись50.h);
const шрифт100 = размер(await раскладка('', 100));
await call('/document', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(Object.assign(док('', 100), { pdfSignatureScale: 50 })) });
const сМелкойПодписью = (await call('/document/pdf-layout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).body;
ok(размер(сМелкойПодписью) === шрифт100, 'мелкая подпись не меняет размер шрифта: ' + размер(сМелкойПодписью));
await call('/document', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(Object.assign(док('', 100), { pdfSignatureScale: 5 })) });
ok(((await call('/document')).body.pdfSignatureScale) === 40, 'меньше 40% места под подпись не бывает');

// Чужое слово в выравнивании становится выравниванием по левому краю.
await call('/document', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(док('вверх', 100)) });
ok(!((await call('/document')).body.pages[0].blocks[0].align), 'неизвестное выравнивание не сохраняется');

await browser.close();
console.log(fail === 0 ? '\nВСЁ ПРОЙДЕНО' : '\n' + fail + ' ПРОВЕРОК УПАЛО');
process.exit(fail === 0 ? 0 : 1);
