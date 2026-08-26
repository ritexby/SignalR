import { chromium } from 'playwright';
const BASE='http://127.0.0.1:5080', EXE=process.env.SK_CHROME || undefined;
const b=await chromium.launch({executablePath:EXE,headless:true});
const p=await (await b.newContext({viewport:{width:1600,height:1000}})).newPage();
p.on('pageerror',e=>console.log('ОШИБКА:',e.message));
await p.goto(BASE+'/admin/'); await p.fill('#password','test123'); await p.click('#loginForm button[type=submit]');
await p.waitForSelector('#app:not(.hidden)',{timeout:8000});
let m=p.locator('.modal button',{hasText:'Отказаться от черновика'});
try{await m.waitFor({state:'visible',timeout:2000}); await m.click();}catch{}
// Три документа, чтобы закладки были видны как закладки.
await p.evaluate(async()=>{
  await fetch('/api/admin/document',{method:'PUT',credentials:'same-origin',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({title:'Соглашение о медицинском вмешательстве',signPrompt:'Распишитесь',thankYouText:'Спасибо',idleReturnSec:0,
      pages:[{headingRuns:[{text:'1. Проверка персональных данных'}],blocks:[{runs:[{text:'текст'}],ord:0}],checkboxes:[{key:'ok',label:'Согласен',required:true,ord:1}],includeDynamic:false}]})});
  for (const [c,n] of [['DOGOVOR','Договор оказания услуг'],['TALON','Талон очереди']]) {
    const r=await fetch('/api/admin/documents',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:c,name:n})});
    const d=await r.json();
    await fetch('/api/admin/document?id='+d.id,{method:'PUT',credentials:'same-origin',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({kind: c==='TALON'?'info':null, title:n,signPrompt:'x',thankYouText:'Спасибо',idleReturnSec:0,
        pages:[{headingRuns:[{text:'Страница'}],blocks:[{runs:[{text:'текст'}],ord:0}],includeDynamic:false}]})});
  }
});
await p.reload(); await p.waitForSelector('#app:not(.hidden)',{timeout:8000});
try{await m.waitFor({state:'visible',timeout:2000}); await m.click();}catch{}
await p.click('.tab[data-tab="document"]'); await p.waitForSelector('.doc-tab',{timeout:5000});
await p.waitForTimeout(700);
console.log('закладок:', await p.locator('.doc-tab').count());
console.log('подписи:', JSON.stringify(await p.locator('.doc-tab-name').allTextContents()));
console.log('заголовок:', await p.textContent('#docHeading'));
await p.screenshot({path:'/tmp/tabs_wide.png', clip:{x:0,y:0,width:1600,height:640}});
// Информационный документ: заголовок и оглавление должны смениться.
const ids=await p.locator('[data-role="doctab"]').evaluateAll(n=>n.map(x=>x.getAttribute('data-id')));
await p.locator('[data-role="doctab"]').last().click(); await p.waitForTimeout(900);
console.log('после перехода на талон, заголовок:', await p.textContent('#docHeading'));
console.log('завершающие экраны:', JSON.stringify(await p.locator('.toc-fixed').allTextContents()));
await p.screenshot({path:'/tmp/tabs_info.png', clip:{x:0,y:0,width:1600,height:640}});
// Меню закладки.
await p.locator('.doc-tab.on .doc-tab-menu').click(); await p.waitForTimeout(400);
console.log('меню:', JSON.stringify(await p.locator('.doc-menu .btn').allTextContents()));
await p.screenshot({path:'/tmp/tabs_menu.png', clip:{x:0,y:0,width:1600,height:640}});
await b.close();
