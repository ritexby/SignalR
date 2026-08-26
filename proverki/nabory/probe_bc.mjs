import { chromium } from 'playwright';
import { readFileSync, readdirSync } from 'fs';
const BASE='http://127.0.0.1:5080', EXE=process.env.SK_CHROME || undefined;
const SP='' + (process.env.SK_RABOTA || '.') + '';
const b=await chromium.launch({executablePath:EXE,headless:true});
const k=await (await b.newContext()).newPage();
await k.goto(BASE+'/'); await k.waitForTimeout(1200);
console.log('zxing на странице:', await k.evaluate(()=>!!(window.ZXingBrowser||window.ZXing)));
for (const f of readdirSync(SP+'/bc').filter(x=>x.endsWith('.png'))) {
  const png = readFileSync(SP+'/bc/'+f).toString('base64');
  const r = await k.evaluate(async ([b64]) => {
    const img = new Image();
    await new Promise((res, rej) => { img.onload=res; img.onerror=rej; img.src='data:image/png;base64,'+b64; });
    const ZX = window.ZXingBrowser || window.ZXing;
    const итог = {};
    // Вся страница целиком.
    const c = document.createElement('canvas'); c.width=img.width; c.height=img.height;
    c.getContext('2d').drawImage(img,0,0);
    try { const x = await new ZX.BrowserMultiFormatReader().decodeFromCanvas(c); итог.вся = x.getText(); }
    catch (e) { итог.вся = 'нет: ' + (e.message||e); }
    // Только нижняя полоса: декодеру проще, и это честно, сканер тоже наводят на код.
    const h = Math.round(img.height*0.10);
    const c2 = document.createElement('canvas'); c2.width=img.width; c2.height=h;
    c2.getContext('2d').drawImage(img, 0, img.height-h, img.width, h, 0, 0, img.width, h);
    try { const x = await new ZX.BrowserMultiFormatReader().decodeFromCanvas(c2); итог.полоса = x.getText(); }
    catch (e) { итог.полоса = 'нет: ' + (e.message||e); }
    // С прямой подсказкой формата.
    try {
      const hints = new Map();
      hints.set(ZX.DecodeHintType.POSSIBLE_FORMATS, [ZX.BarcodeFormat.CODE_39]);
      hints.set(ZX.DecodeHintType.TRY_HARDER, true);
      const rd = new ZX.BrowserMultiFormatReader(hints);
      const x = await rd.decodeFromCanvas(c2); итог.сПодсказкой = x.getText();
    } catch (e) { итог.сПодсказкой = 'нет: ' + (e.message||e); }
    return итог;
  }, [png]);
  console.log(f, JSON.stringify(r, null, 1));
}
await b.close();
