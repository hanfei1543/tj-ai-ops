-- ============================================================================
-- TJ-AI-Ops — Preview 数据库集成验收（只读 public；只写 tj_preview 且全部回滚）
--
-- 供主脑在「已应用 20261112_prelaunch_guards_preview.sql」之后执行。
--   * 全部语句只涉及 tj_preview；本文件没有任何 public.* 写操作。
--   * 测试数据使用显式负数 po_seq + OVERRIDING SYSTEM VALUE，避免消耗 identity。
--   * 先 savepoint，测试块内用异常子事务逐条验证“应拒绝”的操作，最后
--     ROLLBACK TO SAVEPOINT，再比对原始行数/内容摘要/序列值，确保零残留。
--   * 推荐 psql 执行（任一断言失败即停）：
--       psql -v ON_ERROR_STOP=1 "$PREVIEW_DB_URL" -f supabase/tests/20261112_preview_integration.sql
--     也可整体粘贴到 Supabase SQL Editor（脚本自带 begin/rollback，不会留下数据）。
--
-- 覆盖（DB 层）：
--   1. 缺 Website PO Date 的 submit / approve（confirmed）被拒
--   2. 有日期新建 -> 提交审批 -> 批准冻结，日期保留
--   3. 冻结后 date / frozen / po_type / source_po_ids / source_sha256 / approved_* / 整行 防篡改
--   4. 冻结明细 增/改/删 + 跨父单搬移 被拒
--   5. 来源单改回 confirmed 后仍拒绝 pending_push / exported
--   6. combined 进入 pending_push / exported 被拒
--   7. 预览库总闸：普通测试单 pending_push / exported 也一律拒绝
--   8. 普通 CRUD 兼容（standard 建单/改明细/改表头、tj_item_requests 增删）
--   9. IRS 编号无验证证据被拒，证据齐全才允许
--
-- 不在本脚本内（应用层，由 node 测试覆盖）：
--   * GR 正式 push/post 永久停用：lib/core/push-policy.js GR_PUSH_ENABLED=false
--   * Add New Item 写 API 停用：featureFlags.ADD_ITEM_WRITES_ENABLED=false
--   这两项没有可被 SQL 触发的数据库写路径，故不能做 DB 断言。
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 基线：原始数据摘要 + identity 序列值（rollback 后逐项比对）
-- ----------------------------------------------------------------------------
create temp table _tj_baseline on commit drop as
select
  (select count(*) from tj_preview.tj_po_headers) as hdr_count,
  (select coalesce(max(po_seq), 0) from tj_preview.tj_po_headers) as hdr_maxseq,
  (select md5(coalesce(string_agg(row_to_json(h)::text, '|' order by h.id), ''))
     from tj_preview.tj_po_headers h) as hdr_hash,
  (select count(*) from tj_preview.tj_po_lines) as line_count,
  (select md5(coalesce(string_agg(row_to_json(l)::text, '|' order by l.id), ''))
     from tj_preview.tj_po_lines l) as line_hash,
  (select count(*) from tj_preview.tj_item_requests) as item_req_count,
  (select count(*) from tj_preview.tj_po_exports) as export_count,
  (select last_value from pg_catalog.pg_sequences
    where schemaname = 'tj_preview' and sequencename like '%po_seq%'
    limit 1) as seq_last;

-- 期望失败助手：只接受 check_violation（策略拒绝）；其他错误（语法/FK 等）向上抛。
create or replace function pg_temp.tj_expect_reject(p_sql text, p_label text)
returns text
language plpgsql
as $fn$
declare
  v_err text;
begin
  begin
    execute p_sql;
    v_err := null;
  exception
    when check_violation then
      v_err := sqlerrm;
    when others then
      raise exception 'ASSERT_FAILED: % 以非策略原因失败：% (%)', p_label, sqlerrm, sqlstate;
  end;

  if v_err is null then
    raise exception 'ASSERT_FAILED: % 竟然成功（应被拒绝）', p_label;
  end if;

  raise notice 'PASS 拒绝: % -> %', p_label, v_err;
  return v_err;
end
$fn$;

create or replace function pg_temp.tj_assert(p_ok boolean, p_label text)
returns void
language plpgsql
as $fn$
begin
  if p_ok is not true then
    raise exception 'ASSERT_FAILED: %', p_label;
  end if;
  raise notice 'PASS 断言: %', p_label;
end
$fn$;

savepoint tj_verify;

-- ----------------------------------------------------------------------------
-- 测试主体
-- ----------------------------------------------------------------------------
do $verify$
declare
  v_src1_id uuid; v_src1_po text;
  v_src2_id uuid; v_src2_po text;
  v_std_id  uuid; v_std_po  text;
  v_nodate_id uuid; v_nodate_po text;
  v_comb_id uuid; v_comb_po text;
  v_line_id uuid;
  v_item_id uuid;
  v_n int;
  v_text text;
  v_date date;
  v_frozen boolean;
  v_snapshot_version integer;
begin
  -- ==========================================================================
  -- 8) 普通 CRUD 兼容（standard，未冻结）
  -- ==========================================================================
  insert into tj_preview.tj_po_headers
    (po_seq, supplier_code, supplier_name, status, po_type, created_by)
  overriding system value
  values (-103, '4000/A01', 'VERIFY STANDARD', 'confirmed', 'standard', 'verify-script')
  returning id, po_id into v_std_id, v_std_po;

  perform pg_temp.tj_assert(v_std_po is not null, '普通单插入后 trigger 生成 po_id');

  insert into tj_preview.tj_po_lines
    (po_header_id, line_no, item_code, description, uom, qty, unit_price)
  values (v_std_id, 1, '0010001000002', 'HINGE', 'UNIT', 5, 1.25)
  returning id into v_line_id;

  update tj_preview.tj_po_lines set qty = 7 where id = v_line_id;
  select qty into v_n from tj_preview.tj_po_lines where id = v_line_id;
  perform pg_temp.tj_assert(v_n = 7, '普通单明细可更新');

  update tj_preview.tj_po_headers set supplier_name = 'VERIFY STANDARD 2' where id = v_std_id;
  select supplier_name into v_text from tj_preview.tj_po_headers where id = v_std_id;
  perform pg_temp.tj_assert(v_text = 'VERIFY STANDARD 2', '普通单表头（非状态字段）可更新');

  -- 来源单两张（供合并/关系拦截测试）
  insert into tj_preview.tj_po_headers
    (po_seq, supplier_code, supplier_name, status, po_type, created_by)
  overriding system value
  values (-101, '4000/A01', 'VERIFY SRC 1', 'confirmed', 'standard', 'verify-script')
  returning id, po_id into v_src1_id, v_src1_po;

  insert into tj_preview.tj_po_headers
    (po_seq, supplier_code, supplier_name, status, po_type, created_by)
  overriding system value
  values (-102, '4000/A01', 'VERIFY SRC 2', 'confirmed', 'standard', 'verify-script')
  returning id, po_id into v_src2_id, v_src2_po;

  perform pg_temp.tj_assert(v_src1_po <> v_src2_po, '负数 po_seq 生成不同 po_id');

  insert into tj_preview.tj_po_lines
    (po_header_id, line_no, item_code, description, uom, qty, unit_price)
  values
    (v_src1_id, 1, '0030000000003', 'SCREW', 'UNIT', 3, 2.50),
    (v_src2_id, 1, '0030000000003', 'SCREW', 'UNIT', 2, 2.50);

  -- ==========================================================================
  -- 7) 预览库总闸：普通测试单也禁止进入 pending_push / exported
  -- ==========================================================================
  perform pg_temp.tj_expect_reject(
    format('update tj_preview.tj_po_headers set status = %L where id = %L', 'pending_push', v_std_id),
    '预览库普通单 pending_push');
  perform pg_temp.tj_expect_reject(
    format('update tj_preview.tj_po_headers set status = %L where id = %L', 'exported', v_std_id),
    '预览库普通单 exported');

  -- ==========================================================================
  -- 1) 缺 Website PO Date：submit / approve 都拒绝
  -- ==========================================================================
  insert into tj_preview.tj_po_headers
    (po_seq, supplier_code, supplier_name, status, po_type, source_po_ids, created_by)
  overriding system value
  values (-110, '4000/A01', 'VERIFY NO DATE', 'draft', 'combined',
          array[v_src1_po, v_src2_po], 'verify-script')
  returning id, po_id into v_nodate_id, v_nodate_po;

  perform pg_temp.tj_expect_reject(
    format('update tj_preview.tj_po_headers set status = %L where id = %L', 'pending_approval', v_nodate_id),
    '缺日期 submit -> pending_approval');

  perform pg_temp.tj_expect_reject(
    format('update tj_preview.tj_po_headers set status = %L, frozen = true, approved_by = %L where id = %L',
           'confirmed', 'verifier', v_nodate_id),
    '缺日期 approve -> confirmed/frozen');

  -- ==========================================================================
  -- 2) 有日期新建 -> submit -> approve 冻结
  -- ==========================================================================
  insert into tj_preview.tj_po_headers
    (po_seq, supplier_code, supplier_name, status, po_type, source_po_ids,
     created_by, website_po_date)
  overriding system value
  values (-111, '4000/A01', 'VERIFY COMBINED', 'draft', 'combined',
          array[v_src1_po, v_src2_po], 'verify-script', date '2026-11-12')
  returning id, po_id into v_comb_id, v_comb_po;

  insert into tj_preview.tj_po_lines
    (po_header_id, line_no, item_code, description, uom, qty, unit_price,
     original_qty, accepted_qty, note)
  values
    (v_comb_id, 1, '0030000000003', 'SCREW', 'UNIT', 5, 2.50, 5, 5, ''),
    (v_comb_id, 2, '0010001000002', 'HINGE', 'PCS', 1, 1.25, 1, 1, '');
  select id into strict v_line_id
    from tj_preview.tj_po_lines
   where po_header_id = v_comb_id and line_no = 1;

  update tj_preview.tj_po_headers
     set status = 'pending_approval',
         checked_by = 'checker',
         receipt_event_id = 'verify-receipt',
         received_at = now()
   where id = v_comb_id;
  select status, website_po_date into v_text, v_date
    from tj_preview.tj_po_headers where id = v_comb_id;
  perform pg_temp.tj_assert(v_text = 'pending_approval', '有日期可提交审批');
  perform pg_temp.tj_assert(v_date = date '2026-11-12', '提交审批后日期保留');

  update tj_preview.tj_po_headers
     set status = 'confirmed', frozen = true,
         approved_by = 'approver',
         approved_at = now(),
         source_sha256 = 'verify-hash',
         approval_snapshot_version = 2
   where id = v_comb_id;
  select status, frozen, website_po_date into v_text, v_frozen, v_date
    from tj_preview.tj_po_headers where id = v_comb_id;
  perform pg_temp.tj_assert(v_text = 'confirmed' and v_frozen, '批准后 confirmed + frozen=true');
  perform pg_temp.tj_assert(v_date = date '2026-11-12', '批准后日期仍为显式业务日期');
  select approval_snapshot_version into v_snapshot_version
    from tj_preview.tj_po_headers where id = v_comb_id;
  perform pg_temp.tj_assert(v_snapshot_version = 2, '批准快照版本列存在且可读回，旧冻结单不回填');

  -- ==========================================================================
  -- 3) 冻结 header 整行防篡改
  -- ==========================================================================
  perform pg_temp.tj_expect_reject(
    format('update tj_preview.tj_po_headers set website_po_date = date %L where id = %L', '2026-11-13', v_comb_id),
    '冻结后改 website_po_date');
  perform pg_temp.tj_expect_reject(
    format('update tj_preview.tj_po_headers set frozen = false where id = %L', v_comb_id),
    '冻结后 unfreeze');
  perform pg_temp.tj_expect_reject(
    format('update tj_preview.tj_po_headers set po_type = %L where id = %L', 'standard', v_comb_id),
    '冻结后改 po_type');
  perform pg_temp.tj_expect_reject(
    format('update tj_preview.tj_po_headers set source_po_ids = null where id = %L', v_comb_id),
    '冻结后改 source_po_ids');
  perform pg_temp.tj_expect_reject(
    format('update tj_preview.tj_po_headers set source_sha256 = %L where id = %L', 'tampered', v_comb_id),
    '冻结后改 source_sha256');
  perform pg_temp.tj_expect_reject(
    format('update tj_preview.tj_po_headers set approved_by = %L where id = %L', 'someone-else', v_comb_id),
    '冻结后改 approved_by');
  perform pg_temp.tj_expect_reject(
    format('update tj_preview.tj_po_headers set updated_at = clock_timestamp() where id = %L', v_comb_id),
    '冻结后仅改 updated_at（整行不可变）');
  perform pg_temp.tj_expect_reject(
    format('delete from tj_preview.tj_po_headers where id = %L', v_comb_id),
    '冻结后删除 header');

  -- ==========================================================================
  -- 4) 冻结明细防篡改（含跨父单搬移）
  -- ==========================================================================
  perform pg_temp.tj_expect_reject(
    format('update tj_preview.tj_po_lines set qty = 999 where id = %L', v_line_id),
    '冻结后改明细数量');
  perform pg_temp.tj_expect_reject(
    format('delete from tj_preview.tj_po_lines where id = %L', v_line_id),
    '冻结后删明细');
  perform pg_temp.tj_expect_reject(
    format('insert into tj_preview.tj_po_lines (po_header_id, line_no, item_code, description, uom, qty, unit_price) values (%L, 99, %L, %L, %L, 1, 1.00)',
           v_comb_id, 'X', 'EXTRA', 'UNIT'),
    '冻结后新增明细');
  perform pg_temp.tj_expect_reject(
    format('update tj_preview.tj_po_lines set po_header_id = %L where id = %L', v_src1_id, v_line_id),
    '把明细从冻结单搬到未冻结单（OLD parent 检查）');
  perform pg_temp.tj_expect_reject(
    format('update tj_preview.tj_po_lines set po_header_id = %L where po_header_id = %L',
           v_comb_id, v_src1_id),
    '把明细搬到冻结单（NEW parent 检查）');

  -- ==========================================================================
  -- 5) 来源单：改回 confirmed 仍拒 push
  -- ==========================================================================
  update tj_preview.tj_po_headers set status = 'confirmed' where id = v_src1_id;
  perform pg_temp.tj_expect_reject(
    format('update tj_preview.tj_po_headers set status = %L where id = %L', 'pending_push', v_src1_id),
    '来源单改回 confirmed 后 pending_push');
  perform pg_temp.tj_expect_reject(
    format('update tj_preview.tj_po_headers set status = %L where id = %L', 'exported', v_src1_id),
    '来源单 exported');

  -- ==========================================================================
  -- 6) combined 永久冻结 push
  -- ==========================================================================
  perform pg_temp.tj_expect_reject(
    format('update tj_preview.tj_po_headers set status = %L where id = %L', 'pending_push', v_comb_id),
    'combined pending_push');
  perform pg_temp.tj_expect_reject(
    format('update tj_preview.tj_po_headers set status = %L where id = %L', 'exported', v_comb_id),
    'combined exported');

  -- ==========================================================================
  -- 9) IRS 编号防伪
  -- ==========================================================================
  perform pg_temp.tj_expect_reject(
    format('update tj_preview.tj_po_headers set irs_po_no = %L where id = %L', '5', v_std_id),
    'IRS 编号无验证证据');
  update tj_preview.tj_po_headers
     set irs_po_no = '5',
         irs_po_no_verified_at = now(),
         irs_po_no_verified_by = 'verifier'
   where id = v_std_id;
  select irs_po_no into v_text from tj_preview.tj_po_headers where id = v_std_id;
  perform pg_temp.tj_assert(v_text = '5', 'IRS 编号有证据时可写入（编号内容原样保留）');

  -- ==========================================================================
  -- 8b) Add New Item 表 CRUD 兼容（表可写；API 停用由应用层保证）
  -- ==========================================================================
  insert into tj_preview.tj_item_requests (item_code, description, created_by)
  values ('VERIFY-ITEM-001', 'VERIFY ITEM', 'verify-script')
  returning id into v_item_id;
  update tj_preview.tj_item_requests set status = 'approved', approved_by = 'verifier' where id = v_item_id;
  delete from tj_preview.tj_item_requests where id = v_item_id;

  raise notice '--- 全部 Preview DB 断言执行完毕，准备回滚测试写入 ---';
end
$verify$;

-- ----------------------------------------------------------------------------
-- ROLLBACK：清除本脚本一切测试写入
-- ----------------------------------------------------------------------------
rollback to savepoint tj_verify;

-- ----------------------------------------------------------------------------
-- 回滚后基线比对：行数 / 内容摘要 / identity 序列值必须与开始时完全一致
-- ----------------------------------------------------------------------------
do $compare$
declare
  b record;
  a_hdr_count bigint;
  a_hdr_maxseq bigint;
  a_hdr_hash text;
  a_line_count bigint;
  a_line_hash text;
  a_item_req_count bigint;
  a_export_count bigint;
  a_seq_last bigint;
begin
  select * into b from _tj_baseline;

  select count(*), coalesce(max(po_seq), 0),
         md5(coalesce(string_agg(row_to_json(h)::text, '|' order by h.id), ''))
    into a_hdr_count, a_hdr_maxseq, a_hdr_hash
    from tj_preview.tj_po_headers h;
  select count(*), md5(coalesce(string_agg(row_to_json(l)::text, '|' order by l.id), ''))
    into a_line_count, a_line_hash
    from tj_preview.tj_po_lines l;
  select count(*) into a_item_req_count from tj_preview.tj_item_requests;
  select count(*) into a_export_count from tj_preview.tj_po_exports;
  select last_value into a_seq_last from pg_catalog.pg_sequences
    where schemaname = 'tj_preview' and sequencename like '%po_seq%' limit 1;

  perform pg_temp.tj_assert(a_hdr_count = b.hdr_count, '回滚后 headers 行数一致');
  perform pg_temp.tj_assert(a_hdr_maxseq = b.hdr_maxseq, '回滚后 max(po_seq) 一致');
  perform pg_temp.tj_assert(a_hdr_hash = b.hdr_hash, '回滚后 headers 内容摘要一致（原数据零改动）');
  perform pg_temp.tj_assert(a_line_count = b.line_count, '回滚后 lines 行数一致');
  perform pg_temp.tj_assert(a_line_hash = b.line_hash, '回滚后 lines 内容摘要一致');
  perform pg_temp.tj_assert(a_item_req_count = b.item_req_count, '回滚后 item_requests 行数一致');
  perform pg_temp.tj_assert(a_export_count = b.export_count, '回滚后 exports 行数一致（无 Queue 记录）');
  perform pg_temp.tj_assert(
    a_seq_last is not distinct from b.seq_last,
    format('回滚后 po_seq identity 序列未消耗（before=%s after=%s）', b.seq_last, a_seq_last));

  raise notice '====================================================';
  raise notice 'PREVIEW DB INTEGRATION: ALL PASS';
  raise notice '  headers=% lines=% item_requests=% exports=% max(po_seq)=%',
    a_hdr_count, a_line_count, a_item_req_count, a_export_count, a_hdr_maxseq;
  raise notice '====================================================';
end
$compare$;

-- 最终全部回滚（脚本本身无任何持久写入）
rollback;
