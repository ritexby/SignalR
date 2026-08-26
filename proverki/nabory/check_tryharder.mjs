// Does TRY_HARDER actually change anything on an image like a tablet camera produces?
// Renders the same EAN-13 progressively softer and lower contrast, and decodes each with and
// without the hint, so the claim rests on numbers rather than on folklore.
import { chromium } from 'playwright';

const BASE = 'http://127.0.0.1:5080';
// Путь к браузеру берётся из окружения: на другой машине он другой, а зашитый путь
// превращал набор в неработающий у всех, кроме одной установки. Пусто значит
// «пусть Playwright возьмёт свой», как он и делает по умолчанию.
const EXE = process.env.SK_CHROME || undefined;

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const p = await (await browser.newContext()).newPage();
await p.goto(BASE + '/');

const rows = await p.evaluate(() => {
  const L = ['0001101','0011001','0010011','0111101','0100011','0110001','0101111','0111011','0110111','0001011'];
  const G = ['0100111','0110011','0011011','0100001','0011101','0111001','0000101','0010001','0001001','0010111'];
  const R = ['1110010','1100110','1101100','1000010','1011100','1001110','1010000','1000100','1001000','1110100'];
  const PARITY = ['LLLLLL','LLGLGG','LLGGLG','LLGGGL','LGLLGG','LGGLLG','LGGGLL','LGLGLG','LGLGGL','LGGLGL'];
  const digits = '4600051000057'.split('').map(Number);
  let bits = '101';
  const parity = PARITY[digits[0]];
  for (let i = 1; i <= 6; i++) bits += (parity[i - 1] === 'L' ? L : G)[digits[i]];
  bits += '01010';
  for (let i = 7; i <= 12; i++) bits += R[digits[i]];
  bits += '101';

  function draw(module, blurPx, contrast) {
    const quiet = 12 * module, height = 160;
    const c = document.createElement('canvas');
    c.width = bits.length * module + quiet * 2;
    c.height = height;
    const g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
    if (blurPx) g.filter = 'blur(' + blurPx + 'px)';
    // Contrast 1 is pure black on white; lower values wash the bars out like a dim camera.
    const level = Math.round(255 * (1 - contrast));
    g.fillStyle = 'rgb(' + level + ',' + level + ',' + level + ')';
    for (let i = 0; i < bits.length; i++)
      if (bits[i] === '1') g.fillRect(quiet + i * module, 16, module, height - 32);
    g.filter = 'none';
    return c;
  }

  function decode(canvas, tryHarder) {
    const ZX = window.ZXingBrowser;
    const hints = new Map();
    hints.set(2, [ZX.BarcodeFormat.QR_CODE, ZX.BarcodeFormat.EAN_13, ZX.BarcodeFormat.EAN_8, ZX.BarcodeFormat.CODE_128]);
    if (tryHarder) hints.set(3, true);
    const reader = new ZX.BrowserMultiFormatReader(hints);
    try { return reader.decodeFromCanvas(canvas).getText() === '4600051000057'; }
    catch (e) { return false; }
  }

  const out = [];
  for (const module of [3, 2, 1]) {
    for (const blur of [0, 1, 2]) {
      for (const contrast of [1, 0.55, 0.35]) {
        const c = draw(module, blur, contrast);
        out.push({
          module, blur, contrast,
          plain: decode(c, false),
          harder: decode(c, true)
        });
      }
    }
  }
  return out;
});

let plainOk = 0, harderOk = 0, onlyHarder = 0;
for (const r of rows) {
  if (r.plain) plainOk++;
  if (r.harder) harderOk++;
  if (r.harder && !r.plain) { onlyHarder++; console.log('only with TRY_HARDER:', JSON.stringify(r)); }
  if (r.plain && !r.harder) console.log('only WITHOUT TRY_HARDER:', JSON.stringify(r));
}
console.log('\ncases: ' + rows.length + '  decoded without hint: ' + plainOk + '  with TRY_HARDER: ' + harderOk +
  '  gained by TRY_HARDER: ' + onlyHarder);

await browser.close();
