#!/usr/bin/env node
// 已停用：旧的「模拟合并样本」生成器。
//
// 停用原因：它从 tj_preview 读真实 PO 后自己模拟合并，并把 checked_by/approved_by/
// approved_at 写死成看起来"已批准"的值，产出的文件很容易被误当成真实已批准单据导入 PAD。
//
// 替代做法（只读真实数据、不猜日期）：
//   node scripts/gen_po_excel.mjs --po PO-000003                # 审阅样本（缺日期会标 INTERNAL NOT FOR PAD + 告警）
//   node scripts/gen_po_excel.mjs --po PO-000003 --mode formal  # 正式 build（合并单缺日期直接拒绝）
//
// 本脚本永久拒绝执行，且不写库、不写文件。
console.error(
  [
    'gen_sample.mjs 已停用：不再生成"模拟已批准"的合并样本。',
    '',
    '请改用真实数据脚本：',
    '  node scripts/gen_po_excel.mjs --po PO-000003                # review 审阅样本',
    '  node scripts/gen_po_excel.mjs --po PO-000003 --mode formal  # 正式 build（拒绝缺日期）',
    '',
    '替代脚本从 tj_preview 只读，不写库、不猜日期；缺 Website PO Date 的文件会明确标 INTERNAL NOT FOR PAD。',
  ].join('\n'),
)
process.exit(2)
