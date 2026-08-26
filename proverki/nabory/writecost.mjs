// Сколько стоит перезапись всего файла планшетов. Столько раз, сколько её делает массовое
// переподключение парка: по одной на подключение и по одной на отключение.
import { writeFileSync, renameSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const dir = mkdtempSync(join(tmpdir(), 'wc-'));
const N = 200;
const список = Array.from({ length: N }, (_, i) => ({
  id: 'dev-' + String(i).padStart(6, '0') + '-abcdef0123456789',
  name: 'Планшет ресепшн ' + (i + 1),
  status: 'active', groupIds: ['grp-0001', 'grp-0002'], workstationId: 'ws-' + i,
  lastSeenUtc: new Date().toISOString(), lastIp: '10.20.30.' + (i % 250),
  controlIp: '10.20.30.' + (i % 250), controlPort: 8080, enrolledUtc: new Date().toISOString(),
  secretHash: 'x'.repeat(64)
}));
const путь = join(dir, 'devices.json');
const байт = Buffer.byteLength(JSON.stringify(список, null, 2));
const t = process.hrtime.bigint();
const РАЗ = 400;
for (let i = 0; i < РАЗ; i++) {
  список[i % N].lastSeenUtc = new Date().toISOString();
  const текст = JSON.stringify(список, null, 2);
  writeFileSync(путь + '.tmp', текст);
  renameSync(путь + '.tmp', путь);
}
const мс = Number(process.hrtime.bigint() - t) / 1e6;
console.log('файл на ' + N + ' планшетов: ' + Math.round(байт / 1024) + ' КБ');
console.log(РАЗ + ' перезаписей: ' + Math.round(мс) + ' мс, в среднем ' + (мс / РАЗ).toFixed(2) + ' мс');
console.log('это столько же, сколько стоит массовое переподключение парка: ' + Math.round(мс) + ' мс под общим замком хранилища');
