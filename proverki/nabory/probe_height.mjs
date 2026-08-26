import { chromium } from 'playwright';
const BASE='http://127.0.0.1:5080', EXE=process.env.SK_CHROME || undefined;
const b=await chromium.launch({executablePath:EXE,headless:true});
const p=await (await b.newContext({viewport:{width:1400,height:1100}})).newPage();
await p.goto(BASE+'/admin/'); await p.fill('#password','test123'); await p.click('#loginForm button[type=submit]');
await p.waitForSelector('#app:not(.hidden)',{timeout:8000});
let m=p.locator('.modal button',{hasText:'Отказаться от черновика'}); if(await m.count()) await m.click();
await p.evaluate(async()=>{await fetch('/api/admin/document',{method:'PUT',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:'П',signPrompt:'x',thankYouText:'x',idleReturnSec:0,pages:[
 {headingRuns:[{text:'Первая'}],blocks:[],checkboxes:[{key:'a1',label:'Первый',required:true,ord:0},{key:'a2',label:'Второй',required:true,ord:1}],groups:[]},
 {headingRuns:[{text:'Вторая'}],blocks:[],checkboxes:[{key:'b1',label:'Уже был здесь',required:true,ord:0}],groups:[]}],signBlocks:[],signBlocksBelow:[]})});});
await p.reload(); await p.waitForSelector('#app:not(.hidden)',{timeout:8000});
m=p.locator('.modal button',{hasText:'Отказаться от черновика'}); if(await m.count()) await m.click();
await p.click('.tab[data-tab="document"]'); await p.waitForSelector('[data-role="pagecard"]',{timeout:8000});
await p.waitForTimeout(600);
console.log(JSON.stringify(await p.evaluate(()=>{
  const первая=document.querySelector('#pagesEditor > [data-role="pagecard"]');
  const ручка=первая.querySelector('[data-role="cbrow"] .drag-handle');
  const панель=document.querySelector('.spotlight');
  const правила=document.querySelector('.rules-panel');
  return { перваяРучка: Math.round(ручка.getBoundingClientRect().top),
    высотаПервойСтраницы: Math.round(первая.getBoundingClientRect().height),
    прожектор: панель?Math.round(панель.getBoundingClientRect().height):0,
    правилаВысота: правила?Math.round(правила.getBoundingClientRect().height):0,
    всегоДокумент: Math.round(document.body.scrollHeight) };
})));
await b.close();
