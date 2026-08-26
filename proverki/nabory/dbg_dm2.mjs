import { chromium } from 'playwright';
const BASE='http://127.0.0.1:5080', EXE=process.env.SK_CHROME || undefined;
const browser=await chromium.launch({executablePath:EXE,headless:true});
const p=await (await browser.newContext()).newPage();
await p.goto(BASE+'/'); await p.waitForFunction(()=>!!window.ZXingBrowser,{timeout:10000});
console.log(JSON.stringify(await p.evaluate(()=>{
  const ZX=window.ZXingBrowser, out={};
  const w=new ZX.BrowserCodeSvgWriter();
  out.encodeДлина = w.encode ? w.encode.length : null;
  try {
    const m = w.encode('TEST-DM', ZX.BarcodeFormat.DATA_MATRIX, 60, 60, null);
    out.encode = m ? ('матрица ' + (m.getWidth ? m.getWidth() : '?') + 'x' + (m.getHeight ? m.getHeight() : '?')) : 'пусто';
  } catch(e){ out.encode = 'ошибка: ' + String(e&&e.message||e).slice(0,100); }
  try { out.dmReader = !!new ZX.BrowserDatamatrixCodeReader() ? 'есть' : 'нет'; }
  catch(e){ out.dmReader = 'ошибка: ' + String(e&&e.message||e).slice(0,80); }
  return out;
}, null)));
await browser.close();
