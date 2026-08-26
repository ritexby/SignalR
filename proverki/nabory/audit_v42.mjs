import { chromium } from 'playwright';
const BASE = 'http://127.0.0.1:5080';
// Путь к браузеру берётся из окружения: на другой машине он другой, а зашитый путь
// превращал набор в неработающий у всех, кроме одной установки. Пусто значит
// «пусть Playwright возьмёт свой», как он и делает по умолчанию.
const EXE = process.env.SK_CHROME || undefined;
const SP = '' + (process.env.SK_RABOTA || '.') + '';
let fail = 0;
const ok = (c, m) => { if (c) console.log('PASS', m); else { console.error('FAIL', m); fail++; } };

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const p = await ctx.newPage();
const jsErr = []; p.on('pageerror', e => jsErr.push(e.message));
await p.goto(BASE + '/admin/');
await p.fill('#password', 'test123'); await p.click('#loginForm button[type=submit]');
await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });

const tabs = ['devices', 'slides', 'document', 'apidocs', 'groups', 'workstations', 'signatures'];
async function overflow() {
  return await p.evaluate(() => {
    var docW = document.documentElement.clientWidth;
    var bodyScroll = document.documentElement.scrollWidth > docW + 1;
    var wide = [];
    document.querySelectorAll('#app *').forEach(function (e) {
      var r = e.getBoundingClientRect();
      if (r.width > docW + 1 && e.offsetParent !== null) wide.push((e.className || e.tagName) + ' w=' + Math.round(r.width));
    });
    return { bodyScroll: bodyScroll, wide: wide.slice(0, 6) };
  });
}

for (var width of [1280, 900]) {
  await p.setViewportSize({ width: width, height: 900 });
  for (var t of tabs) {
    var tab = await p.$('.tab[data-tab="' + t + '"]');
    if (!tab) continue;
    await tab.click(); await p.waitForTimeout(200);
    var o = await overflow();
    ok(!o.bodyScroll, 'no horizontal page scroll @' + width + ' tab=' + t + (o.wide.length ? ' wide=' + JSON.stringify(o.wide) : ''));
  }
}

// document editor screenshot @1280
await p.setViewportSize({ width: 1280, height: 1000 });
await p.click('.tab[data-tab="document"]'); await p.waitForTimeout(300);
await p.screenshot({ path: SP + '/shot_doc_editor.png', fullPage: true });

// device edit modal: workstation option must include the description
await p.click('.tab[data-tab="devices"]'); await p.waitForTimeout(300);
var edit = await p.$('#devicesList .dev-item .dev-actions button:nth-child(2)');
if (edit) {
  await edit.click(); await p.waitForTimeout(300);
  var opts = await p.evaluate(() => Array.from(document.querySelectorAll('.modal select option')).map(o => o.textContent));
  console.log('WS options:', JSON.stringify(opts));
  ok(opts.some(o => o.indexOf('·') >= 0), 'edit modal workstation option shows ID/description separator');
  await p.screenshot({ path: SP + '/shot_dev_edit.png' });
}

ok(jsErr.length === 0, 'no admin JS errors (' + JSON.stringify(jsErr) + ')');
await browser.close();
console.log(fail === 0 ? '\nLAYOUT AUDIT PASSED' : `\n${fail} CHECK(S) FAILED`);
process.exit(fail === 0 ? 0 : 1);
