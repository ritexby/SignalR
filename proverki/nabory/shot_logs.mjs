import { chromium } from 'playwright';
const BASE='http://127.0.0.1:5080', EXE=process.env.SK_CHROME || undefined;
const SP='' + (process.env.SK_RABOTA || '.') + '';
const b=await chromium.launch({executablePath:EXE,headless:true});
const ctx=await b.newContext({viewport:{width:1280,height:900}});
const p=await ctx.newPage();
await p.goto(BASE+'/admin/'); await p.fill('#password','test123'); await p.click('#loginForm button[type=submit]');
await p.waitForSelector('#app:not(.hidden)',{timeout:8000});
// seed a few entries
const enr=await p.evaluate(async()=> (await fetch('/api/admin/devices/enroll',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'Ресепшн 1',ttlMinutes:30})})).json());
const tok=await p.evaluate(async(c)=>(await fetch('/api/kiosk/enroll',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:c})})).json(),enr.code);
const t=await b.newContext();
for (const m of [['error','Не удалось отправить подпись','TypeError: Failed to fetch\n  at submitSignature'],['error','Нет доступа к камере','NotAllowedError: Permission denied'],['warn','Соединение потеряно, переподключение',null]])
  await t.request.post(BASE+'/api/log',{headers:{'Content-Type':'application/json','Authorization':'Bearer '+tok.token},data:JSON.stringify({level:m[0],message:m[1],detail:m[2]})});
await p.click('.tab[data-tab="logs"]'); await p.waitForTimeout(800);
await p.evaluate(()=>{const d=document.querySelector('#logsList details'); if(d) d.open=true;});
await p.waitForTimeout(200);
await p.screenshot({path:SP+'/shot_logs.png',fullPage:true});
await b.close();
