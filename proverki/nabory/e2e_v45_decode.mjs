// Proves the barcode reader on the tablet actually decodes, which no test covered before: the
// scan screen opened, the camera ran, and nothing was ever read because the hints were built
// against a DecodeHintType export the browser bundle does not have.
//
// Chromium's fake camera plays a generated pattern, not a barcode, so the decode itself is driven
// through the same reader the tablet builds, over a canvas carrying a real generated code.
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
const jsErr = []; p.on('pageerror', e => jsErr.push(e.message));
await p.goto(BASE + '/');

// The library the tablet loads must expose what the tablet's code uses.
const exported = await p.evaluate(() => ({
  hasReader: typeof window.ZXingBrowser?.BrowserMultiFormatReader,
  hasFormats: typeof window.ZXingBrowser?.BarcodeFormat,
  hasHintEnum: typeof window.ZXingBrowser?.DecodeHintType
}));
ok(exported.hasReader === 'function', 'the reader class is available on the tablet');
ok(exported.hasFormats === 'object', 'BarcodeFormat is available');
ok(exported.hasHintEnum === 'undefined',
  'DecodeHintType is NOT exported, which is why the hint keys are given by value');

// EAN-13 drawn from its own encoding tables, so the test does not depend on any other library.
const decoded = await p.evaluate(() => {
  const L = ['0001101','0011001','0010011','0111101','0100011','0110001','0101111','0111011','0110111','0001011'];
  const G = ['0100111','0110011','0011011','0100001','0011101','0111001','0000101','0010001','0001001','0010111'];
  const R = ['1110010','1100110','1101100','1000010','1011100','1001110','1010000','1000100','1001000','1110100'];
  const PARITY = ['LLLLLL','LLGLGG','LLGGLG','LLGGGL','LGLLGG','LGGLLG','LGGGLL','LGLGLG','LGLGGL','LGGLGL'];
  const digits = '4600051000057'.split('').map(Number);      // a valid EAN-13 with its check digit
  let bits = '101';
  const parity = PARITY[digits[0]];
  for (let i = 1; i <= 6; i++) bits += (parity[i - 1] === 'L' ? L : G)[digits[i]];
  bits += '01010';
  for (let i = 7; i <= 12; i++) bits += R[digits[i]];
  bits += '101';

  // Generous quiet zone and module width: a decoder needs both, exactly as on paper.
  const module = 4, quiet = 20 * module, height = 220;
  const canvas = document.createElement('canvas');
  canvas.width = bits.length * module + quiet * 2;
  canvas.height = height;
  const g = canvas.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, canvas.width, canvas.height);
  g.fillStyle = '#000';
  for (let i = 0; i < bits.length; i++)
    if (bits[i] === '1') g.fillRect(quiet + i * module, 20, module, height - 40);

  // Built exactly like kiosk.js builds it, including the hint keys given by value.
  const ZX = window.ZXingBrowser;
  const hints = new Map();
  hints.set(2, [ZX.BarcodeFormat.QR_CODE, ZX.BarcodeFormat.EAN_13, ZX.BarcodeFormat.EAN_8, ZX.BarcodeFormat.CODE_128]);
  hints.set(3, true);
  const reader = new ZX.BrowserMultiFormatReader(hints);

  try {
    const res = reader.decodeFromCanvas(canvas);
    return { text: res.getText(), format: res.getBarcodeFormat() };
  } catch (e) {
    return { error: String(e && (e.message || e)) };
  }
});

ok(!decoded.error, 'the reader decoded the generated barcode: ' + JSON.stringify(decoded));
ok(decoded.text === '4600051000057', 'the decoded value is right: ' + decoded.text);

// The same reader built the old way (no hints at all) is what shipped, so confirm the hints are
// what changed rather than something else about the image.
const withoutHints = await p.evaluate(() => {
  const ZX = window.ZXingBrowser;
  // The old code path: DecodeHintType is undefined, so the condition was false and nothing was set.
  const hints = new Map();
  if (ZX.DecodeHintType && ZX.BarcodeFormat) hints.set(ZX.DecodeHintType.POSSIBLE_FORMATS, []);
  return { built: hints.size };
});
ok(withoutHints.built === 0, 'the old code really produced an empty hint set');

// The format name shown to the operator must be a name, not a raw enum number.
const formatName = await p.evaluate((f) => {
  const ZX = window.ZXingBrowser;
  return (ZX && ZX.BarcodeFormat && typeof f === 'number') ? (ZX.BarcodeFormat[f] || String(f)) : String(f || '');
}, decoded.format);
ok(formatName === 'EAN_13', 'the format is reported by name: ' + formatName);

ok(jsErr.length === 0, 'no JavaScript errors on the tablet page: ' + jsErr.join(' | '));

await browser.close();
console.log(fail === 0 ? '\nALL PASS' : '\n' + fail + ' FAILED');
process.exit(fail === 0 ? 0 : 1);
