#!/usr/bin/env node
// VPS 推送器：把「待推送」的 PO 生成 Excel，经桥 write 到目标机 PAD 目录。
// 用法：
//   node scripts/tj-po-push.mjs --once     # 跑一轮（cron 用）
//   node scripts/tj-po-push.mjs            # 循环轮询（手动/守护）
import fs from 'node:fs';
import ExcelJS from 'exceljs';

const ONCE = process.argv.includes('--once');

// 读 ~/.hermes/.env 取 Supabase 凭据
function loadEnv(p) {
  const env = {};
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m) env[m[1]] = m[2];
  }
  return env;
}
const env = loadEnv('/home/hermes/.hermes/.env');
const SUPABASE_URL = env.SUPABASE_URL;
const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('缺 Supabase 凭据（SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY）');
  process.exit(1);
}

const BRIDGE_URL = 'http://127.0.0.1:9000';
const TARGET_DIR = 'C:\\Users\\Administrator\\Desktop\\operation\\PO_Queue\\Pending';
const POLL_SEC = 30;

const H = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  'Content-Type': 'application/json',
};

async function sbFetch(pathname, opts = {}) {
  const r = await fetch(SUPABASE_URL + '/rest/v1/' + pathname, { ...opts, headers: H });
  const text = await r.text();
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

async function bridgeCall(payload) {
  const r = await fetch(BRIDGE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`bridge HTTP ${r.status}: ${text}`);
  return JSON.parse(text);
}

// 生成 xlsx（对齐 PAD schema，与前端 src/lib/tjPoExcel.ts 一致）
async function buildXlsx(header, lines) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('PO_Lines');
  ws.columns = [
    { header: 'Supplier Code', key: 'supplier_code', width: 16 },
    { header: 'Supplier Name', key: 'supplier_name', width: 38 },
    { header: 'Item Code', key: 'item_code', width: 16 },
    { header: 'Description', key: 'description', width: 46 },
    { header: 'UOM', key: 'uom', width: 10 },
    { header: 'Qty', key: 'qty', width: 10 },
    { header: 'Unit Price (RM)', key: 'unit_price', width: 16 },
  ];
  ws.getRow(1).font = { bold: true };
  for (const l of lines) {
    ws.addRow({
      supplier_code: header.supplier_code,
      supplier_name: header.supplier_name,
      item_code: l.item_code,
      description: l.description,
      uom: l.uom ?? '',
      qty: Number(l.accepted_qty ?? l.qty),
      unit_price: Number(l.unit_price),
    });
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function pushOne(header) {
  const lines = await sbFetch(`tj_po_lines?select=*&po_header_id=eq.${header.id}&order=line_no`);
  const buf = await buildXlsx(header, lines);
  const filename = `${header.po_id}.xlsx`;
  const winPath = `${TARGET_DIR}\\${filename}`;
  const res = await bridgeCall({ write: { path: winPath, b64: buf.toString('base64') } });
  if (!res.ok) throw new Error('bridge write 失败: ' + (res.error || JSON.stringify(res)));
  // 记录导出历史 + 标 exported（service key 写）
  const now = new Date().toISOString();
  await sbFetch('tj_po_exports', {
    method: 'POST',
    body: JSON.stringify({ po_header_id: header.id, po_id: header.po_id, filename, exported_at: now }),
  });
  await sbFetch(`tj_po_headers?id=eq.${header.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ status: 'exported', updated_at: now }),
  });
  return filename;
}

async function runOnce() {
  const pending = await sbFetch('tj_po_headers?select=*&status=eq.pending_push&order=created_at');
  for (const h of pending) {
    try {
      const f = await pushOne(h);
      console.log(`[ok] ${h.po_id} -> ${f} (${new Date().toISOString()})`);
    } catch (e) {
      console.error(`[err] ${h.po_id}: ${e.message}`);
    }
  }
  return pending.length;
}

async function main() {
  if (ONCE) {
    await runOnce();
    return;
  }
  while (true) {
    try {
      await runOnce();
    } catch (e) {
      console.error('[loop]', e.message);
    }
    await new Promise((r) => setTimeout(r, POLL_SEC * 1000));
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
