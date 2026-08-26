// Stand-in for the FreeKiosk app on a tablet. Records what the server asked it to do so the
// E2E suite can assert that the right call reached the right endpoint.
import http from 'node:http';
import fs from 'node:fs';

const PORT = parseInt(process.argv[2] || '8080', 10);
const LOG = process.argv[3] || '/tmp/mock_freekiosk.json';
const calls = [];
let apiKey = process.env.MOCK_API_KEY || '';

// A 1x1 PNG, enough to prove the bytes travel end to end.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64');

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    const url = new URL(req.url, 'http://x');

    // Test-only: forget everything recorded so far, so each suite starts from a clean slate.
    if (url.pathname === '/__reset') {
      calls.length = 0;
      fs.writeFileSync(LOG, '[]');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end('{"reset":true}');
    }

    calls.push({ method: req.method, path: url.pathname, body, key: req.headers['x-api-key'] || '' });
    fs.writeFileSync(LOG, JSON.stringify(calls, null, 1));

    if (apiKey && req.headers['x-api-key'] !== apiKey) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end('{"error":"bad key"}');
    }

    if (url.pathname === '/api/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      // Deliberately nested and mixed-shape, like the real app across versions.
      return res.end(JSON.stringify({
        battery: { level: 17, charging: false },
        wifi: { signal: 71, ssid: 'office' },
        storage: { free: 900000000, total: 10000000000 },
        memory: { freePercent: 42 },
        brightness: 60,
        screenOn: true,
        deviceOwner: true,
        appVersion: '1.9.3',
        androidVersion: '13',
        model: 'Lenovo Tab M10'
      }));
    }
    if (url.pathname === '/api/screenshot') {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      return res.end(PNG);
    }
    if (url.pathname === '/api/fail') {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end('{"error":"boom"}');
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
  });
});

// Bound on every interface: the server refuses loopback control addresses on purpose, so the
// test reaches this mock through the container's real address.
server.listen(PORT, '0.0.0.0', () => console.log('mock freekiosk on ' + PORT));
