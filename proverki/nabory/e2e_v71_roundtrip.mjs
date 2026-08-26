// Сохранили и прочитали обратно: ни одна настройка документа не должна потеряться по дороге.
// Ровно так пропадал колонтитул PDF: в редакторе он ставился, в файле лежал, а до бумаги не
// доходил. Проверка сравнивает поле за полем, а не «на глаз».
import { chromium } from 'playwright';
const BASE = 'http://127.0.0.1:5080';
// Путь к браузеру берётся из окружения: на другой машине он другой, а зашитый путь
// превращал набор в неработающий у всех, кроме одной установки. Пусто значит
// «пусть Playwright возьмёт свой», как он и делает по умолчанию.
const EXE = process.env.SK_CHROME || undefined;
let fail = 0;
const ok = (c, m) => { if (c) console.log('PASS', m); else { console.error('FAIL', m); fail++; } };

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const admin = await (await browser.newContext()).newPage();
admin.on('pageerror', e => { console.error('FAIL ошибка в админке: ' + e.message); fail++; });
await admin.goto(BASE + '/admin/');
await admin.fill('#password', 'test123');
await admin.click('#loginForm button[type=submit]');
await admin.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
const call = (path, opts) => admin.evaluate(async ([pa, o]) => {
  const r = await fetch('/api/admin' + pa, Object.assign({ credentials: 'same-origin' }, o || {}));
  let body = null; try { body = await r.json(); } catch { body = null; }
  return { status: r.status, body };
}, [path, opts]);
const put = (p, o) => call(p, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o) });
const post = (p, o) => call(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o) });

// Документ со всем, что вообще умеет конструктор.
const исходный = {
  title: 'Круговая проверка',
  signPrompt: 'Распишитесь ниже',
  thankYouText: 'Спасибо',
  thankYouAlign: 'center',
  thankYouSec: 12,
  idleReturnSec: 90,
  pdfFontScale: 90,
  pdfSignatureScale: 80,
  pdfPageNumbers: true,
  pdfFooterTitle: true,
  pdfFooterRecordId: true,
  pdfFooterBarcode: true,
  signBlocks: [{ runs: [{ text: 'Над полем подписи' }], ord: 0 }],
  signBlocksBelow: [{ runs: [{ text: 'Под полем подписи' }], ord: 0 }],
  thankYouBlocks: [{ runs: [{ text: 'На экране прощания' }], ord: 0 }],
  signaturePlacements: [{ key: 'podpis', page: 0, x: 0.25, y: 0.6, w: 0.4, h: 0.1 }],
  pages: [{
    inPdf: true,
    headingRuns: [{ text: 'Заголовок', bold: true }],
    headingAlign: 'center',
    includeDynamic: true,
    visibleWhen: { field: 'Пол', op: 'eq', value: 'F' },
    blocks: [
      { runs: [{ text: 'Оформленный ', bold: true }, { text: 'текст', italic: true, color: '#b91c1c', size: 'l', sizePt: 14, mark: '#fef08a' }],
        align: 'justify', ord: 0, inPdf: true, lineHeight: 150, bg: '#fef9c3', borderColor: '#eab308', pad: 12 },
      { list: 'number', runs: [{ text: 'Раз\nДва' }], ord: 1 },
      { table: { rows: [['А', 'Б'], ['1', '2']], widths: [60, 40], headerRow: true }, ord: 2 },
      { imageTag: 'ФОТО', imageWidth: 40, wrap: 'left', wrapGap: 14, ord: 3 },
      { kind: 'divider', ord: 4 },
      { kind: 'pagebreak', ord: 5, inPdf: true }
    ],
    checkboxes: [{ key: 'soglasie', label: 'Согласие', labelRuns: [{ text: 'Согласие', sizePt: 18 }],
      required: true, checked: false, ord: 6, visibleWhen: { field: 'Пол', op: 'eq', value: 'F' } }],
    groups: [{ key: 'transfer', title: 'Передача', titleRuns: [{ text: 'Передача', mark: '#fef08a' }], required: true,
      selected: 'yes', ord: 7,
      options: [{ key: 'yes', label: 'Согласен' }, { key: 'no', label: 'Против' }] }],
    inputs: [{ key: 'tel', label: 'Телефон', type: 'phone', placeholder: '+7', required: true,
      value: '', ord: 8, visibleWhen: { field: 'soglasie', op: 'eq', value: 'true' } }],
    signatures: [{ key: 'podpis', label: 'Подпись', required: true, ord: 9, width: 300, height: 120, align: 'center' }],
    scans: [{ key: 'shtrih', label: 'Штрихкод', required: false, ord: 10 }]
  }]
};

const сохранение = await put('/document', исходный);
ok(сохранение.status === 200, 'документ со всеми возможностями сохранён: ' + сохранение.status + ' ' + JSON.stringify(сохранение.body));
if (сохранение.status !== 200) { await browser.close(); console.log('\nКРУГОВАЯ ПРОВЕРКА: ПРОВАЛОВ 1'); process.exit(1); }
const назад = (await call('/document')).body || {};

function сравнить(путь, было, стало) {
  if (было === null || было === undefined) return;
  if (typeof было === 'object' && !Array.isArray(было)) {
    Object.keys(было).forEach(k => сравнить(путь + '.' + k, было[k], (стало || {})[k]));
    return;
  }
  if (Array.isArray(было)) {
    ok(Array.isArray(стало) && стало.length === было.length,
      путь + ': столько же элементов, сколько отправили (' + было.length + ' → ' + ((стало || []).length) + ')');
    было.forEach((v, i) => сравнить(путь + '[' + i + ']', v, (стало || [])[i]));
    return;
  }
  // Пустая строка и её отсутствие для сервера одно и то же: он приводит пустое к null
  // намеренно, и придираться тут не к чему.
  if (было === '' && (стало === null || стало === undefined || стало === '')) return;
  ok(стало === было, путь + ': сохранилось как отправили (' + JSON.stringify(было) + ' → ' + JSON.stringify(стало) + ')');
}

// Поля, которые сервер намеренно меняет: имя безымянной подписи, вид документа, порядковые
// номера. Их сравниваем отдельно, а не через общее сравнение.
const пропустить = new Set(['signaturePlacements[0].key']);
function сравнитьВерхний(было, стало) {
  Object.keys(было).forEach(k => {
    if (k === 'pages' || k === 'signaturePlacements') return;
    сравнить(k, было[k], стало[k]);
  });
}
сравнитьВерхний(исходный, назад);
сравнить('pages', исходный.pages, назад.pages);

const место = (назад.signaturePlacements || [])[0] || {};
ok(место.key === 'podpis' && место.page === 0 && место.x === 0.25 && место.y === 0.6 && место.w === 0.4 && место.h === 0.1,
  'раскладка подписи на листе сохранилась: ' + JSON.stringify(место));

await browser.close();
console.log(fail === 0 ? '\nКРУГОВАЯ ПРОВЕРКА: ВСЁ ПРОЙДЕНО' : '\nКРУГОВАЯ ПРОВЕРКА: ПРОВАЛОВ ' + fail);
process.exit(fail === 0 ? 0 : 1);
