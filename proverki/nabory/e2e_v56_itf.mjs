// Штрихкод ITF (Interleaved 2 of 5): чётное число цифр, бары от первой цифры пары, пробелы от
// второй. Проверяем, что вшитая библиотека его читает и что он разрешён в настройках сканера.
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
p.on('pageerror', e => console.log('ОШИБКА СТРАНИЦЫ:', e.message));
await p.goto(BASE + '/');
await p.waitForFunction(() => !!window.ZXingBrowser, { timeout: 10000 });

const итог = await p.evaluate(async (код) => {
  // Рисуем ITF сами: узкий элемент это одна единица, широкий три.
  const PAT = ['NNWWN','WNNNW','NWNNW','WWNNN','NNWNW','WNWNN','NWWNN','NNNWW','WNNWN','NWNWN'];
  const U = 4, WIDE = 3 * U, H = 220, QUIET = 20 * U;
  const els = [];
  els.push([U, 1], [U, 0], [U, 1], [U, 0]);                  // старт
  for (let i = 0; i < код.length; i += 2) {
    const a = PAT[+код[i]], b = PAT[+код[i + 1]];
    for (let k = 0; k < 5; k++) {
      els.push([a[k] === 'W' ? WIDE : U, 1]);
      els.push([b[k] === 'W' ? WIDE : U, 0]);
    }
  }
  els.push([WIDE, 1], [U, 0], [U, 1]);                        // стоп
  const width = QUIET * 2 + els.reduce((s, e) => s + e[0], 0);
  const c = document.createElement('canvas');
  c.width = width; c.height = H;
  const g = c.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, width, H);
  let x = QUIET;
  g.fillStyle = '#000';
  els.forEach(([w, bar]) => { if (bar) g.fillRect(x, 0, w, H); x += w; });

  const ZX = window.ZXingBrowser;
  const hints = new Map();
  hints.set(2, [ZX.BarcodeFormat.ITF]);
  hints.set(3, true);
  const reader = new ZX.BrowserMultiFormatReader(hints);
  try {
    const res = await reader.decodeFromCanvas(c);
    const f = res.getBarcodeFormat ? res.getBarcodeFormat() : res.format;
    return { text: res.getText ? res.getText() : res.text, format: f };
  } catch (e) {
    return { error: String(e && e.name || e) };
  }
}, '04012345678901');

console.log('результат разбора:', JSON.stringify(итог));
ok(!итог.error, 'вшитая библиотека читает ITF: ' + JSON.stringify(итог));
if (!итог.error) {
  ok(итог.text === '04012345678901', 'код прочитан: ' + итог.text);
  ok(итог.format === 8, 'и опознан как ITF (8): ' + итог.format);
}

// Data Matrix: двумерный код, которым метят пробирки и реагенты, когда для QR нет места.
// Матрица настоящая, посчитана кодировщиком заранее и нарисована здесь как есть.
const МАТРИЦА = ["1010101010101010", "1010000001100011", "1010010110100000", "1011001000000011", "1001010110100010", "1101010110001011", "1101110010010010", "1011010011000001", "1000010001001000", "1001100001010101", "1101011001010110", "1110011010010101", "1010110110011100", "1110001010011101", "1000101001110010", "1111111111111111"];
const dm = await p.evaluate(async (rows) => {
  const U = 12, QUIET = U * 4;
  const n = rows.length, m = rows[0].length;
  const c = document.createElement('canvas');
  c.width = m * U + QUIET * 2; c.height = n * U + QUIET * 2;
  const g = c.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = '#000';
  for (let y = 0; y < n; y++)
    for (let x = 0; x < m; x++)
      if (rows[y][x] === '1') g.fillRect(QUIET + x * U, QUIET + y * U, U, U);
  const ZX = window.ZXingBrowser;
  const hints = new Map();
  hints.set(2, [ZX.BarcodeFormat.DATA_MATRIX]);
  hints.set(3, true);
  try {
    const res = await new ZX.BrowserMultiFormatReader(hints).decodeFromCanvas(c);
    const f = res.getBarcodeFormat ? res.getBarcodeFormat() : res.format;
    return { text: res.getText ? res.getText() : res.text, format: f };
  } catch (e) { return { error: String(e && e.name || e) }; }
}, МАТРИЦА);
console.log('Data Matrix:', JSON.stringify(dm));
ok(!dm.error, 'вшитая библиотека читает Data Matrix: ' + JSON.stringify(dm));
if (!dm.error) {
  ok(dm.text === 'PROBIRKA-12345', 'код Data Matrix прочитан: ' + dm.text);
  ok(dm.format === 5, 'и опознан как DATA_MATRIX: ' + dm.format);
}

// ITF должен быть в списке форматов сканера.
const форматы = await p.evaluate(async () => {
  const t = await (await fetch('/kiosk.js')).text();
  const m = t.match(/HINT_POSSIBLE_FORMATS,\s*\[([\s\S]{0,300}?)\]/);
  return m ? m[1].replace(/\s+/g, ' ') : 'не найдено';
});
ok(/ITF/.test(форматы), 'ITF разрешён в сканере: ' + форматы);
ok(/DATA_MATRIX/.test(форматы), 'Data Matrix тоже разрешён');

await browser.close();
console.log(fail === 0 ? '\nВСЁ ПРОЙДЕНО' : '\n' + fail + ' ПРОВЕРОК УПАЛО');
process.exit(fail === 0 ? 0 : 1);
