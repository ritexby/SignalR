import { chromium } from 'playwright';
const BASE='http://127.0.0.1:5080', EXE=process.env.SK_CHROME || undefined;
const browser=await chromium.launch({executablePath:EXE,headless:true});
const p=await (await browser.newContext()).newPage();
await p.goto(BASE+'/'); await p.waitForFunction(()=>!!window.ZXingBrowser,{timeout:10000});
console.log(await p.evaluate(()=>{
  const ZX=window.ZXingBrowser, W=ZX.BrowserCodeSvgWriter;
  const proto=W && W.prototype ? Object.getOwnPropertyNames(W.prototype) : null;
  const out={методы:proto, длинаWrite: W && W.prototype.write ? W.prototype.write.length : null};
  try {
    const div=document.createElement('div'); document.body.appendChild(div);
    const w=new W();
    const svg=w.write('TEST-DM', 200, 200, div, ZX.BarcodeFormat.DATA_MATRIX);
    out.сКонтейнером = svg ? 'ок ' + svg.tagName : 'пусто';
  } catch(e){ out.сКонтейнером='ошибка: '+String(e&&e.message||e).slice(0,90); }
  try {
    const div2=document.createElement('div'); document.body.appendChild(div2);
    const w2=new W();
    const svg2=w2.writeToDom ? w2.writeToDom(div2,'TEST-DM',200,200) : null;
    out.writeToDom = svg2 ? 'ок' : 'нет метода';
  } catch(e){ out.writeToDom='ошибка: '+String(e&&e.message||e).slice(0,90); }
  out.форматы = Object.keys(ZX.BarcodeFormat).filter(k=>isNaN(+k));
  return out;
}));
await browser.close();
