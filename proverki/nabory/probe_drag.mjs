import { chromium } from 'playwright';
const BASE='http://127.0.0.1:5080', EXE=process.env.SK_CHROME || undefined;
const b=await chromium.launch({executablePath:EXE,headless:true});
const p=await (await b.newContext({viewport:{width:1400,height:1100}})).newPage();
p.on('pageerror',e=>console.log('ERR',e.message));
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
console.log('панель прожектора:', await p.locator('.spotlight').count());
const источник=p.locator('#pagesEditor > [data-role="pagecard"]').first().locator('[data-role="cbrow"]').first();
const цель=p.locator('#pagesEditor > [data-role="pagecard"]').nth(1).locator('[data-role="cbrow"]').first();
// Прокручиваем к ручке: тащить можно только то, что видно, и оператор поступает так же.
await источник.locator('.drag-handle').scrollIntoViewIfNeeded(); await p.waitForTimeout(300);
const rh=await источник.locator('.drag-handle').boundingBox();
console.log('ручка:', JSON.stringify(rh));
console.log('под ручкой:', await p.evaluate(([x,y])=>{const e=document.elementFromPoint(x,y);return e?e.tagName+'.'+String(e.className).slice(0,40):'ничего';},[rh.x+rh.width/2, rh.y+rh.height/2]));
await p.mouse.move(rh.x+rh.width/2, rh.y+rh.height/2); await p.mouse.down();
await p.mouse.move(rh.x+rh.width/2, rh.y+40,{steps:5});
console.log('перетаскивание началось:', await p.evaluate(()=>document.body.classList.contains('dragging-now')));
let видна=null;
for(let i=0;i<30;i++){ await p.mouse.move(rh.x+40, 1090-(i%2),{steps:2}); await p.waitForTimeout(60);
  видна=await цель.boundingBox(); if(видна&&видна.y<900) break; }
console.log('прокрутка:', await p.evaluate(()=>window.scrollY), 'цель видна:', JSON.stringify(видна));
// Уводим курсор из краевой зоны и ждём, пока прокрутка встанет: иначе цель уезжает под
// курсором, и координаты, измеренные секунду назад, указывают уже в другое место.
await p.mouse.move(700, 500,{steps:5});
await p.waitForTimeout(400);
let s1=await p.evaluate(()=>window.scrollY); await p.waitForTimeout(300);
let s2=await p.evaluate(()=>window.scrollY);
console.log('прокрутка встала:', s1===s2, s1, s2);
const rt=await цель.boundingBox();
console.log('цель после остановки:', JSON.stringify(rt));
await p.mouse.move(rt.x+40, rt.y+rt.height-4,{steps:10});
await p.waitForTimeout(200);
console.log('под курсором:', await p.evaluate(([x,y])=>{const e=document.elementFromPoint(x,y);
  if(!e) return 'ничего'; const l=e.closest&&e.closest('[data-role="itemlist"]');
  return {тег:e.tagName+'.'+String(e.className).slice(0,30), список:l?(l.closest('[data-role="pagecard"]')?Array.from(document.querySelectorAll('[data-role="pagecard"]')).indexOf(l.closest('[data-role="pagecard"]')):'?'):'нет'};},[rt.x+40, rt.y+rt.height-4]));
const счёт=()=>p.evaluate(()=>Array.from(document.querySelectorAll('#pagesEditor > [data-role="pagecard"]')).map(c=>c.querySelectorAll('[data-role="itemlist"] > .page-item').length));
console.log('решение placeAt:', JSON.stringify(await p.evaluate(()=>window.__dragDbg)));
console.log('ДО отпускания:', JSON.stringify(await счёт()));
await p.mouse.up(); await p.waitForTimeout(400);
console.log('в списках после броска:', JSON.stringify(await p.evaluate(()=>Array.from(document.querySelectorAll('#pagesEditor > [data-role="pagecard"]')).map(c=>c.querySelectorAll('[data-role="itemlist"] > .page-item').length))));
await b.close();
