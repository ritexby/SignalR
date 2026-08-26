import { chromium } from 'playwright';
const BASE='http://127.0.0.1:5080', EXE=process.env.SK_CHROME || undefined;
const SP='' + (process.env.SK_RABOTA || '.') + '';
const b=await chromium.launch({executablePath:EXE,headless:true});
const p=await (await b.newContext({viewport:{width:1500,height:1200}})).newPage();
await p.goto(BASE+'/admin/');
await p.fill('#password','test123'); await p.click('#loginForm button[type=submit]');
await p.waitForSelector('#app:not(.hidden)',{timeout:8000});
await p.evaluate(async () => {
  await fetch('/api/admin/document', { method:'PUT', credentials:'same-origin', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ title:'Информационное соглашение', signPrompt:'Распишитесь', thankYouText:'Спасибо', idleReturnSec:0,
      pages:[{ headingRuns:[{text:'1. Информационное соглашение', bold:true}],
        blocks:[{runs:[{text:'ООО «Международная лаборатория Хеликс» осуществляет обработку персональных данных на основании абзаца 15 статьи 6 и абзаца 5 пункта 2 статьи 8 Закона Республики Беларусь от 07.05.2021 № 99-З «О защите персональных данных».'}], ord:0},
                {runs:[{text:'Подписанием информационного соглашения Вы предоставляете согласие на выдачу результатов Ваших анализов третьим лицам, предъявившим бланк заказа.'}], ord:2}],
        checkboxes:[{key:'consent1', label:'Согласен с условиями выдачи результатов', required:true, ord:1},
                    {key:'consent2', label:'Согласен на хранение соглашения в электронном архиве', required:true, ord:3}],
        groups:[{key:'transfer', title:'Трансграничная передача', required:true, ord:4,
          options:[{key:'allow',label:'Разрешаю'},{key:'deny',label:'Запрещаю'}]}] }],
      signBlocks:[], signBlocksBelow:[] }) });
});
await p.reload(); await p.waitForSelector('#app:not(.hidden)',{timeout:8000});
await p.click('.tab[data-tab="document"]'); await p.waitForSelector('[data-role="itemlist"]',{timeout:5000});
await p.waitForTimeout(400);
await p.screenshot({path:SP+'/v49_editor.png', fullPage:false});
await p.evaluate(()=>window.scrollTo(0,700)); await p.waitForTimeout(250);
await p.screenshot({path:SP+'/v49_editor2.png', fullPage:false});
const bad = await p.evaluate(() => {
  const out=[];
  document.querySelectorAll('[data-panel="document"] *').forEach(e=>{
    if (e.scrollWidth > e.clientWidth+2 && getComputedStyle(e).overflowX==='visible') out.push((e.className||e.tagName)+' '+e.scrollWidth+'>'+e.clientWidth);
  });
  return { page: document.documentElement.scrollWidth > window.innerWidth, bad: out.slice(0,5) };
});
console.log('перенос страницы='+bad.page+' нарушители='+JSON.stringify(bad.bad));
await b.close();
