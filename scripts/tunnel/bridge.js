// IRS POS agent-desktop 桥：监听 127.0.0.1:9000，收到 POST {"args":[...]} 后执行 agent-desktop 并回传 JSON。
const http = require('http');
const { exec } = require('child_process');
const fs = require('fs');

const PORT = 9000;
const LOG = 'C:\\irs\\bridge.log';
const AD = (process.env.APPDATA || 'C:\\Users\\Administrator\\AppData\\Roaming') + '\\npm\\agent-desktop.cmd';

function log(m) { try { fs.appendFileSync(LOG, new Date().toISOString() + ' ' + m + '\n'); } catch (e) {} }

http.createServer(function (req, res) {
  if (req.method !== 'POST') { res.writeHead(405).end('POST only'); return; }
  var body = '';
  req.on('data', function (c) { body += c; if (body.length > 100000) req.destroy(); });
  req.on('end', function () {
    var args;
    try { args = JSON.parse(body).args; if (!Array.isArray(args)) throw new Error('args'); }
    catch (e) { res.writeHead(400).end('bad json'); return; }
    var cmd = '"' + AD + '" ' + args.map(function (a) { return '"' + String(a).replace(/"/g, '\\"') + '"'; }).join(' ');
    log('RUN ' + cmd);
    exec(cmd, { timeout: 120000, maxBuffer: 200 * 1024 * 1024, windowsHide: true }, function (err, stdout, stderr) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: !err, code: err ? (err.code || 1) : 0, out: stdout, err: stderr }));
      log('DONE code=' + (err ? err.code : 0) + ' out_len=' + stdout.length);
    });
  });
}).listen(PORT, '127.0.0.1', function () {
  console.log('irs bridge on 127.0.0.1:' + PORT);
  log('STARTED');
});
