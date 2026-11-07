// IRS POS agent-desktop 桥 v3：监听 127.0.0.1:9000。
// 相比 v2 新增 write：把 base64 内容写到白名单目录（供 VPS 推送 Excel 给 PAD）。
// 支持四种 POST：
//   {"args":["snapshot","--app","irsPOS.exe","-i"]}  -> 执行 agent-desktop，回传 JSON
//   {"read":"C:\\path\\file.txt"}                      -> 读文件，回传 base64
//   {"list":"C:\\path"}                                -> 列目录
//   {"write":{"path":"C:\\...\\x.xlsx","b64":"..."}}   -> 写文件（仅白名单目录）
const http = require('http');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

const PORT = 9000;
const LOG = 'C:\\irs\\bridge.log';
const AD = (process.env.APPDATA || 'C:\\Users\\Administrator\\AppData\\Roaming') + '\\npm\\agent-desktop.cmd';

// write 白名单：只允许写到这些目录（目录本身或其子目录）。
const WRITE_ALLOW = [
  'C:\\Users\\Administrator\\Desktop\\operation\\PO-Auto-Generate',
];
const MAX_WRITE_BYTES = 20 * 1024 * 1024; // 20MB 上限

function inAllow(target) {
  const t = path.resolve(target).toLowerCase();
  for (const d of WRITE_ALLOW) {
    const base = path.resolve(d).toLowerCase();
    if (t === base || t.startsWith(base + '\\')) return true;
  }
  return false;
}

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

    if (cmd.write && cmd.write.path) {
      var wp = cmd.write.path;
      var wb64 = cmd.write.b64 || '';
      if (!inAllow(wp)) {
        log('WRITE DENY ' + wp);
        reply(res, { ok: false, error: 'path not in whitelist' });
        return;
      }
      try {
        var wbuf = Buffer.from(wb64, 'base64');
        if (wbuf.length > MAX_WRITE_BYTES) { reply(res, { ok: false, error: 'file too large' }); return; }
        fs.mkdirSync(path.dirname(wp), { recursive: true });
        fs.writeFileSync(wp, wbuf);
        log('WRITE ' + wp + ' ' + wbuf.length + 'B');
        reply(res, { ok: true, size: wbuf.length, path: wp });
      } catch (e) { reply(res, { ok: false, error: String(e) }); }
      return;
    }

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
  console.log('irs bridge v3 on 127.0.0.1:' + PORT);
  log('STARTED v3');
});
