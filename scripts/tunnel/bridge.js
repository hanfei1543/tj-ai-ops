// IRS POS agent-desktop 桥 v2：监听 127.0.0.1:9000。
// 支持三种 POST：
//   {"args":["snapshot","--app","irsPOS.exe","-i"]}  -> 执行 agent-desktop，回传 JSON
//   {"read":"C:\\path\\file.txt"}                      -> 读文件，回传 base64
//   {"list":"C:\\path"}                                -> 列目录
const http = require('http');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

const PORT = 9000;
const LOG = 'C:\\irs\\bridge.log';
const AD = (process.env.APPDATA || 'C:\\Users\\Administrator\\AppData\\Roaming') + '\\npm\\agent-desktop.cmd';

function log(m) { try { fs.appendFileSync(LOG, new Date().toISOString() + ' ' + m + '\n'); } catch (e) {} }

function reply(res, obj) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

http.createServer(function (req, res) {
  if (req.method !== 'POST') { res.writeHead(405).end('POST only'); return; }
  var body = '';
  req.on('data', function (c) { body += c; if (body.length > 200000000) req.destroy(); });
  req.on('end', function () {
    var cmd;
    try { cmd = JSON.parse(body); } catch (e) { reply(res, { ok: false, error: 'bad json' }); return; }

    if (cmd.read) {
      try {
        var buf = fs.readFileSync(cmd.read);
        if (buf.length > 100 * 1024 * 1024) { reply(res, { ok: false, error: 'file too large' }); return; }
        reply(res, { ok: true, size: buf.length, b64: buf.toString('base64') });
      } catch (e) { reply(res, { ok: false, error: String(e) }); }
      return;
    }

    if (cmd.list) {
      try {
        var names = fs.readdirSync(cmd.list).map(function (n) {
          var st = fs.statSync(path.join(cmd.list, n));
          return { name: n, dir: st.isDirectory(), size: st.size };
        });
        reply(res, { ok: true, entries: names });
      } catch (e) { reply(res, { ok: false, error: String(e) }); }
      return;
    }

    if (cmd.args && Array.isArray(cmd.args)) {
      var c = '"' + AD + '" ' + cmd.args.map(function (a) { return '"' + String(a).replace(/"/g, '\\"') + '"'; }).join(' ');
      log('RUN ' + c);
      exec(c, { timeout: 120000, maxBuffer: 200 * 1024 * 1024, windowsHide: true }, function (err, stdout, stderr) {
        reply(res, { ok: !err, code: err ? (err.code || 1) : 0, out: stdout, err: stderr });
        log('DONE code=' + (err ? err.code : 0) + ' out_len=' + stdout.length);
      });
      return;
    }

    reply(res, { ok: false, error: 'unknown command' });
  });
}).listen(PORT, '127.0.0.1', function () {
  console.log('irs bridge v2 on 127.0.0.1:' + PORT);
  log('STARTED v2');
});
