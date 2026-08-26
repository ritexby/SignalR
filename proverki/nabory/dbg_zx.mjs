import { chromium } from 'playwright';
const BASE='http://127.0.0.1:5080', EXE=process.env.SK_CHROME || undefined;
const browser=await chromium.launch({executablePath:EXE,headless:true});
const p=await (await browser.newContext()).newPage();
p.on('console', m => { if (m.type()==='error') console.log('КОНСОЛЬ:', m.text().slice(0,120)); });
p.on('pageerror', e => console.log('ОШИБКА:', String(e).slice(0,160)));
const resp=[]; p.on('response', r => { if (/lib\//.test(r.url())) resp.push(r.status()+' '+r.url().split('/').pop()); });
await p.goto(BASE+'/'); await p.waitForTimeout(2500);
console.log('ресурсы:', resp.join(', '));
console.log(await p.evaluate(()=>({
  ZXingBrowser: typeof window.ZXingBrowser,
  ZXing: typeof window.ZXing,
  ключи: window.ZXingBrowser ? Object.keys(window.ZXingBrowser).slice(0,12) : null,
  форматы: window.ZXingBrowser && window.ZXingBrowser.BarcodeFormat ? Object.keys(window.ZXingBrowser.BarcodeFormat).slice(0,20) : null
})));
await browser.close();
