-- ============================================================================
-- TJ-AI-Ops — 收货事件（receipt_event_id）防重复入账 —— Preview 数据库集成验收
-- 文件名：20261112_receipt_event_dedup.sql
--
-- 前提：已应用 20261112_receipt_event_dedup_preview.sql（唯一索引已建）。
--   * 全部语句只涉及 tj_preview；本文件没有任何 public.* 写操作。
--   * 先 savepoint，测试块内用异常子事务逐条验证「应拒绝/应允许」，
--     最后 ROLLBACK TO SAVEPOINT，确保零残留。
--   * 使用显式负数 po_seq + OVERRIDING SYSTEM VALUE，不消耗 identity。
--
-- 覆盖：
--   1. 唯一索引存在
--   2. 重复 receipt_event_id（复制已有合并单的）写入另一张单 → 被拒绝
--   3. 全新不同的 receipt_event_id → 允许写入
--   4. receipt_event_id 为 NULL 的多行 → 不受部分索引约束（普通单允许）
-- ============================================================================

begin;

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
    when unique_violation then
      v_err := sqlerrm;
    when others then
      raise exception 'ASSERT_FAILED: % 以非唯一冲突原因失败：% (%)', p_label, sqlerrm, sqlstate;
  end;
  if v_err is null then
    raise exception 'ASSERT_FAILED: % 竟然成功（应被唯一索引拒绝）', p_label;
  end if;
  raise notice 'PASS 拒绝: % -> %', p_label, v_err;
  return v_err;
end
$fn$;

savepoint tj_dedup_verify;

do $verify$
declare
  v_idx_exists boolean;
  v_existing text;
  v_std_id uuid;
  v_std_id2 uuid;
begin
  -- 1) 唯一索引存在
  select exists (
    select 1 from pg_catalog.pg_indexes
    where schemaname = 'tj_preview'
      and tablename = 'tj_po_headers'
      and indexname = 'uq_tj_po_headers_receipt_event_id'
  ) into v_idx_exists;
  perform pg_temp.tj_assert(v_idx_exists, '唯一索引 uq_tj_po_headers_receipt_event_id 存在');

  -- 读一张已存在合并单的 receipt_event_id 作为「重复」来源
  select receipt_event_id into v_existing
    from tj_preview.tj_po_headers where po_id = 'PO-000009';
  perform pg_temp.tj_assert(v_existing is not null, 'PO-000009 已有 receipt_event_id 作为重复来源');

  -- 新建普通测试单（未冻结，允许写）
  insert into tj_preview.tj_po_headers
    (po_seq, supplier_code, supplier_name, status, po_type, created_by)
  overriding system value
  values (-99011, '4000/A01', 'DEDUP VERIFY 1', 'confirmed', 'standard', 'dedup-test')
  returning id into v_std_id;

  -- 2) 写入重复 receipt_event_id → 必须被拒绝
  perform pg_temp.tj_expect_reject(
    format('update tj_preview.tj_po_headers set receipt_event_id = %L where id = %L',
           v_existing, v_std_id),
    '重复 receipt_event_id 写入另一张单');

  -- 3) 全新不同 receipt_event_id → 允许
  update tj_preview.tj_po_headers
     set receipt_event_id = 'dedup-verify-unique-' || gen_random_uuid()::text
   where id = v_std_id;

  -- 4) 多行 NULL receipt_event_id → 不受部分索引约束
  insert into tj_preview.tj_po_headers
    (po_seq, supplier_code, supplier_name, status, po_type, created_by)
  overriding system value
  values (-99012, '4000/A01', 'DEDUP VERIFY 2', 'confirmed', 'standard', 'dedup-test')
  returning id into v_std_id2;
  perform pg_temp.tj_assert(v_std_id2 is not null, '第二张 NULL receipt_event_id 的普通单可插入');

  raise notice '--- 收货事件防重复 DB 断言执行完毕，准备回滚 ---';
end
$verify$;

rollback to savepoint tj_dedup_verify;
rollback;
