// Снимки экранов после правок вида: числа сходятся, но смотреть всё равно надо глазами.
import { chromium } from 'playwright';
const BASE='http://127.0.0.1:5080', EXE=process.env.SK_CHROME || undefined;
const OUT='' + (process.env.SK_RABOTA || '.') + '/shots';
const PNG='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const b=await chromium.launch({executablePath:EXE,headless:true});
const p=await (await b.newContext({viewport:{width:1500,height:1000}})).newPage();
p.on('dialog',d=>d.accept());
await p.goto(BASE+'/admin/'); await p.fill('#password','test123'); await p.click('#loginForm button[type=submit]');
await p.waitForSelector('#app:not(.hidden)',{timeout:8000});
const о=p.locator('.modal button',{hasText:'Отказаться от черновика'});
try{await о.waitFor({state:'visible',timeout:2000});await о.click();}catch{}
const call=(pa,o)=>p.evaluate(async([x,y])=>{const r=await fetch('/api/admin'+x,Object.assign({credentials:'same-origin'},y||{}));let bb=null;try{bb=await r.json()}catch{};return{status:r.status,body:bb}},[pa,o]);
const post=(pa,o)=>call(pa,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(o)});
const put=(pa,o)=>call(pa,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(o)});
await put('/document',{kind:'sign',title:'Согласие клиента',signPrompt:'Распишитесь ниже',thankYouText:'Спасибо',idleReturnSec:0,thankYouSec:30,
 pages:[{headingRuns:[{text:'Условия'}],includeDynamic:false,blocks:[
   {runs:[{text:'Обычный абзац с '},{text:'жирным',bold:true},{text:' текстом.'}],ord:0},
   {list:'number',runs:[{text:'Первый пункт\nВторой пункт'}],ord:1},
   {table:{rows:[['Услуга','Цена'],['Осмотр','1200'],['Повторный приём','900']],widths:[],headerRow:true},ord:2},
   {bg:'#fef9c3',borderColor:'#eab308',pad:12,runs:[{text:'Блок с собственным оформлением.'}],ord:3}],
   checkboxes:[{key:'ok1',label:'Согласен на обработку данных',required:true,ord:4}],
   inputs:[{key:'fio',label:'Фамилия и имя',kind:'text',required:true,ord:5}]},
  {headingRuns:[{text:'Подпись'}],includeDynamic:false,blocks:[{runs:[{text:'Распишитесь ниже.'}],ord:0}],
   signatures:[{key:'sig',label:'Подпись клиента',required:true,ord:1}]}]});
for(const t of ['document','devices','apidocs','alerts']){
  await p.click('.tab[data-tab="'+t+'"]'); await p.waitForTimeout(900);
  await p.screenshot({path:OUT+'/vis_'+t+'.png'});
}
const enr=(await post('/devices/enroll',{name:'Планшет',ttlMinutes:30})).body;
const tok=await p.evaluate(async c=>(await fetch('/api/kiosk/enroll',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:c})})).json(),enr.code);
const k=await (await b.newContext({viewport:{width:1280,height:800}})).newPage();
await k.goto(BASE+'/'); await k.evaluate(t=>localStorage.setItem('sk_device_token',t),tok.token); await k.reload(); await k.waitForTimeout(1500);
await post('/show-document',{target:'device:'+tok.deviceId,fields:{},images:{}});
await k.waitForSelector('text=Обычный абзац',{timeout:8000});
await k.screenshot({path:OUT+'/vis_kiosk_page.png'});
await k.evaluate(()=>{document.querySelectorAll('#document input[type=checkbox]').forEach(c=>{c.checked=true;c.dispatchEvent(new Event('change',{bubbles:true}))});document.querySelectorAll('#document input[type=text]').forEach(i=>{i.value='Иванов Иван';i.dispatchEvent(new Event('input',{bubbles:true}))})});
await k.click('#btnNext'); await k.waitForTimeout(1200);
await k.screenshot({path:OUT+'/vis_kiosk_sign.png'});
await p.click('.tab[data-tab="document"]'); await p.waitForTimeout(800);
await p.click('#previewDoc'); await p.waitForSelector('#modal:not(.hidden)',{timeout:6000}); await p.waitForTimeout(800);
await p.screenshot({path:OUT+'/vis_preview.png'}); await p.click('#modalClose'); await p.waitForTimeout(400);
await p.click('#pdfLayout'); await p.waitForSelector('#modal:not(.hidden)',{timeout:6000}); await p.waitForTimeout(1200);
await p.screenshot({path:OUT+'/vis_pdf.png'});
await b.close(); console.log('снимки готовы');
