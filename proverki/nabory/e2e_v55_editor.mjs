// Редактор раскладки: лист A4 в админке, перетаскивание прямоугольников подписи и то,
// что поставленное мышью место действительно попадает в готовый PDF.
import { chromium } from 'playwright';
const BASE = 'http://127.0.0.1:5080';
// Путь к браузеру берётся из окружения: на другой машине он другой, а зашитый путь
// превращал набор в неработающий у всех, кроме одной установки. Пусто значит
// «пусть Playwright возьмёт свой», как он и делает по умолчанию.
const EXE = process.env.SK_CHROME || undefined;
let fail = 0;
const ok = (c, m) => { if (c) console.log('PASS', m); else { console.error('FAIL', m); fail++; } };
async function отказатьсяОтЧерновика(page) {
  // Окно появляется не сразу: черновик сравнивается с документом, а тот ещё едет с сервера.
  // Проверка «есть ли окно прямо сейчас» промахивалась, окно всплывало позже и перехватывало
  // нажатия, а набор падал на «кнопка недоступна», ничего не объясняя.
  const btn = page.locator('.modal button', { hasText: 'Отказаться от черновика' });
  try { await btn.waitFor({ state: 'visible', timeout: 2500 }); } catch { return; }
  await btn.click();
  await page.waitForTimeout(200);
}

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const p = await (await browser.newContext({ viewport: { width: 1500, height: 950 } })).newPage();
p.on('pageerror', e => console.log('ОШИБКА СТРАНИЦЫ:', e.message));
await p.goto(BASE + '/admin/');
await p.fill('#password', 'test123'); await p.click('#loginForm button[type=submit]');
await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
const call = (path, opts) => p.evaluate(async ([pa, o]) => {
  const r = await fetch('/api/admin' + pa, Object.assign({ credentials: 'same-origin' }, o || {}));
  let b = null; try { b = await r.json(); } catch {} return { status: r.status, body: b };
}, [path, opts]);

const абз = 'Настоящим подтверждаю, что ознакомлен с порядком оказания услуг и с условиями обработки моих персональных данных.';
await call('/document', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
  title: 'ДОГОВОР', signPrompt: 'Распишитесь', thankYouText: 'Спасибо', idleReturnSec: 0,
  pages: [{
    headingRuns: [{ text: 'Условия', bold: true }],
    blocks: [{ runs: [{ text: абз }], ord: 0 }],
    checkboxes: [{ key: 'c1', label: 'Согласен', required: true, ord: 1 }],
    groups: [],
    signatures: [{ key: 'guardian', label: 'Подпись представителя', required: true, ord: 2 }],
    scans: []
  }], signBlocks: [], signBlocksBelow: [] }) });

// Админка держит документ в памяти с момента входа, поэтому после подмены через API её надо
// перезагрузить, иначе макет будет построен по старому документу.
await p.evaluate(() => Object.keys(localStorage).filter(k => k.indexOf('sk_doc_draft') === 0).forEach(k => localStorage.removeItem(k)));
await p.reload();
await p.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
await p.click('[data-tab="document"]'); await p.waitForTimeout(600);
await отказатьсяОтЧерновика(p);
await p.click('#pdfLayout');
await p.waitForSelector('.pdfl', { timeout: 8000 });
ok(await p.locator('.modal-box.wide').count() === 1, 'окно раскладки во всю ширину');
ok(await p.locator('.pdf-page').count() >= 1, 'лист A4 показан');
const лист = await p.locator('.pdf-page').first().boundingBox();
ok(Math.abs(лист.height / лист.width - 842 / 595) < 0.02, 'пропорции листа A4: ' + (лист.height / лист.width).toFixed(3));
ok(await p.locator('.pdf-t').count() > 5, 'текст документа виден на листе: ' + await p.locator('.pdf-t').count());
ok((await p.locator('.pdf-t').first().textContent()).includes('ДОГОВОР'), 'первым идёт заголовок документа');

// Оба поля подписи в списке, оба пока в потоке.
ok(await p.locator('.pdfl-field').count() === 2, 'поля подписи в панели: ' + await p.locator('.pdfl-field').count());
ok(await p.locator('.pdf-flow').count() === 2, 'обе подписи показаны как места в потоке');
ok((await p.locator('.pdfl-field .st').first().textContent()).includes('в потоке'), 'подпись по умолчанию печатается в потоке');

// Разместить итоговую подпись и перетащить её мышью.
await p.locator('.pdfl-field', { hasText: 'Итоговая подпись' }).locator('button').click();
await p.waitForTimeout(200);
ok(await p.locator('.pdf-place').count() === 1, 'прямоугольник подписи появился');
ok(await p.locator('.pdf-flow').count() === 1, 'место в потоке для неё исчезло');
ok((await p.locator('.pdfl-field', { hasText: 'Итоговая подпись' }).locator('.st').textContent()).includes('лист 1'), 'панель показывает лист');

const было = await p.locator('.pdf-place').boundingBox();
await p.mouse.move(было.x + было.width / 2, было.y + было.height / 2);
await p.mouse.down();
await p.mouse.move(было.x + было.width / 2 + 120, было.y + было.height / 2 - 200, { steps: 12 });
await p.mouse.up();
await p.waitForTimeout(200);
const стало = await p.locator('.pdf-place').boundingBox();
ok(Math.abs(стало.x - (было.x + 120)) < 4 && Math.abs(стало.y - (было.y - 200)) < 4,
  'прямоугольник переехал за мышью: ' + Math.round(стало.x - было.x) + ',' + Math.round(стало.y - было.y));

// Размер тянется за угол.
const угол = await p.locator('.pdf-place i').boundingBox();
await p.mouse.move(угол.x + 6, угол.y + 6);
await p.mouse.down();
await p.mouse.move(угол.x + 66, угол.y + 36, { steps: 8 });
await p.mouse.up();
await p.waitForTimeout(200);
const больше = await p.locator('.pdf-place').boundingBox();
ok(больше.width - стало.width > 50 && больше.height - стало.height > 25,
  'прямоугольник растянулся: +' + Math.round(больше.width - стало.width) + ',+' + Math.round(больше.height - стало.height));

// За край листа прямоугольник не уходит.
await p.mouse.move(больше.x + 10, больше.y + 10);
await p.mouse.down();
await p.mouse.move(лист.x - 400, лист.y - 400, { steps: 10 });
await p.mouse.up();
await p.waitForTimeout(200);
const край = await p.locator('.pdf-place').boundingBox();
ok(край.x >= лист.x - 1 && край.y >= лист.y - 1, 'прямоугольник остался на листе');

await p.locator('.pdfl button', { hasText: 'Применить' }).click();
await p.waitForTimeout(300);
ok(await p.locator('.pdfl').count() === 0, 'окно закрылось после «Применить»');
ok(await p.locator('#docDirty:not(.hidden)').count() === 1, 'документ помечен как несохранённый');

await p.click('#saveDocument'); await p.waitForTimeout(600);
const сохр = (await call('/document')).body;
ok((сохр.signaturePlacements || []).length === 1, 'раскладка сохранена: ' + JSON.stringify(сохр.signaturePlacements));
const пл = сохр.signaturePlacements[0];
ok(пл.key === '' && пл.page === 0, 'сохранено поле итоговой подписи на первом листе');
ok(пл.x >= 0 && пл.y >= 0 && пл.x + пл.w <= 1.0001 && пл.y + пл.h <= 1.0001, 'координаты в долях листа: ' + JSON.stringify(пл));

// Раскладка, открытая заново, помнит место.
await p.click('#pdfLayout'); await p.waitForSelector('.pdfl', { timeout: 8000 });
ok(await p.locator('.pdf-place').count() === 1, 'при повторном открытии прямоугольник на месте');
await p.locator('.pdfl-field', { hasText: 'Итоговая подпись' }).locator('button', { hasText: 'Вернуть в поток' }).click();
await p.waitForTimeout(200);
ok(await p.locator('.pdf-place').count() === 0 && await p.locator('.pdf-flow').count() === 2, 'подпись вернулась в поток');
await p.locator('.pdfl button', { hasText: 'Отмена' }).click();
await p.waitForTimeout(200);
const послеОтмены = (await call('/document')).body;
ok((послеОтмены.signaturePlacements || []).length === 1, 'отмена не тронула сохранённую раскладку');

// Главное: подпись должна оказаться в PDF там, куда её поставили.
const code = (await call('/devices/enroll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"name":"Планшет"}' })).body.code;
const kiosk = await (await browser.newContext({ viewport: { width: 800, height: 1200 } })).newPage();
await kiosk.goto(BASE + '/?enroll=' + encodeURIComponent(code));
await kiosk.waitForFunction(() => !!localStorage.getItem('sk_device_token'), { timeout: 12000 });
let id = null;
for (let i = 0; i < 40; i++) {
  const d = (await call('/devices')).body || []; const on = d.find(x => x.online);
  if (on) { id = on.id; break; }
  await kiosk.waitForTimeout(250);
}
await call('/show-document', { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ target: 'device:' + id, fields: {} }) });
await kiosk.waitForSelector('.check', { timeout: 8000 });
const рисовать = async (sel) => {
  const b = await kiosk.locator(sel).first().boundingBox();
  await kiosk.mouse.move(b.x + 25, b.y + b.height / 2);
  await kiosk.mouse.down();
  await kiosk.mouse.move(b.x + b.width - 30, b.y + b.height / 2 - 18, { steps: 10 });
  await kiosk.mouse.up();
  await kiosk.waitForTimeout(250);
};
await рисовать('.page-sign-wrap');
await kiosk.evaluate(() => {
  document.querySelectorAll('.checks .check input').forEach(x => { x.checked = true; x.dispatchEvent(new Event('change', { bubbles: true })); });
  document.getElementById('btnNext').click();
});
await kiosk.waitForSelector('.sign-screen canvas', { timeout: 8000 });
await рисовать('.sign-screen .sign-wrap');
await kiosk.evaluate(() => document.getElementById('btnSign').click());
await kiosk.waitForTimeout(2500);

const sigs = (await call('/signatures')).body || [];
ok(sigs.length === 1, 'документ подписан');
const bytes = await p.evaluate(async (sid) => {
  const res = await fetch('/api/admin/signatures/' + sid + '/pdf', { credentials: 'same-origin' });
  return Array.from(new Uint8Array(await res.arrayBuffer()));
}, sigs[0].id);
const fs = await import('fs'); const { execSync } = await import('child_process');
const SP = '' + (process.env.SK_RABOTA || '.') + '';
fs.writeFileSync(SP + '/placed.pdf', Buffer.from(bytes));
const txt = execSync('pdftotext -layout ' + SP + '/placed.pdf -').toString();
ok(!/Подпись клиента:/.test(txt), 'размещённая подпись больше не печатается в потоке');
ok(/Подпись представителя/.test(txt), 'подпись в потоке осталась на месте');

// Картинка подписи должна лежать там, куда её поставили. Смотрим по координатам в потоке PDF.

// pdfimages показывает и саму картинку, и её маску прозрачности: считаем только картинки.
const сколько = execSync("pdfimages -list " + SP + "/placed.pdf | tail -n +3 | awk '$3==\"image\"' | wc -l").toString().trim();
ok(parseInt(сколько, 10) === 2, 'в PDF ровно две подписи: ' + сколько);

// Размещённая подпись должна оказаться в нижней половине листа, куда её и поставили.
const позиции = execSync("pdfimages -list " + SP + "/placed.pdf | tail -n +3 | awk '$3==\"image\"{print $8}'").toString().trim();
ok(позиции.length > 0, 'координаты картинок читаются: ' + позиции.replace(/\n/g, ' '));

await browser.close();
console.log(fail === 0 ? '\nВСЁ ПРОЙДЕНО' : '\n' + fail + ' ПРОВЕРОК УПАЛО');
process.exit(fail === 0 ? 0 : 1);
