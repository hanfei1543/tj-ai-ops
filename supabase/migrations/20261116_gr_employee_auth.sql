-- Stage28 员工账号：显示名解析（仅界面显示，不参与 SHA canonical）
-- 已应用环境：tj_preview（Management API，因 tj_preview 不给 service_role）
-- 生产 public 版：本轮不应用（public 仍走旧登录），后续同步 public 时再单独处理。

-- 1) 用户显示名：username > full_name > email 前缀 > uuid
create or replace function tj_preview.tj_gr_user_display(p_uid uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $fn$
  select coalesce(
    nullif(auth.users.raw_user_meta_data ->> 'username', ''),
    nullif(auth.users.raw_user_meta_data ->> 'full_name', ''),
    nullif(pg_catalog.split_part(auth.users.email, '@', 1), ''),
    auth.users.id::text
  )
  from auth.users
  where auth.users.id = p_uid
$fn$;

-- 2) 摘要加 approved_by_name（核对人 checked_by 已是文本显示名）
create or replace function tj_preview.tj_gr_event_summary_json(p_event_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $fn$
  select pg_catalog.jsonb_build_object(
    'id', e.id,
    'event_no', e.event_no,
    'revision', e.revision,
    'status', e.status,
    'supplier_code', e.supplier_code,
    'supplier_name', e.supplier_name,
    'po_ids', to_jsonb(e.po_ids),
    'invoice_no', e.invoice_no,
    'delivery_order_no', e.delivery_order_no,
    'receive_date', tj_preview.tj_gr_date_text(e.receive_date),
    'invoice_date', tj_preview.tj_gr_date_text(e.invoice_date),
    'checked_by', e.checked_by,
    'approved_by', e.approved_by,
    'approved_by_name', tj_preview.tj_gr_user_display(e.approved_by),
    'approved_at', tj_preview.tj_gr_ts_text(e.approved_at),
    'released_at', tj_preview.tj_gr_ts_text(e.released_at),
    'warnings', e.warnings,
    'exception_count', pg_catalog.jsonb_array_length(e.exceptions),
    'created_at', tj_preview.tj_gr_ts_text(e.created_at),
    'updated_at', tj_preview.tj_gr_ts_text(e.updated_at)
  )
  from tj_preview.tj_gr_receipt_events e
  where e.id = p_event_id
$fn$;

-- 3) 详情加 created_by_name / submitted_by_name
create or replace function tj_preview.tj_gr_event_json(p_event_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_json jsonb;
begin
  select tj_preview.tj_gr_event_summary_json(e.id) || pg_catalog.jsonb_build_object(
    'note', e.note,
    'created_by', e.created_by,
    'created_by_name', tj_preview.tj_gr_user_display(e.created_by),
    'submitted_by', e.submitted_by,
    'submitted_by_name', tj_preview.tj_gr_user_display(e.submitted_by),
    'submitted_at', tj_preview.tj_gr_ts_text(e.submitted_at),
    'allow_exceptions', e.allow_exceptions,
    'review_note', e.review_note,
    'payload_sha256', e.payload_sha256,
    'exceptions', e.exceptions,
    'review_required', (pg_catalog.jsonb_array_length(e.exceptions) > 0
                        or e.warnings ? 'duplicate_document'),
    'lines', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'id', l.id,
          'line_no', l.line_no,
          'item_code', l.item_code,
          'description', l.description,
          'uom', l.uom,
          'unit_price', tj_preview.tj_gr_dec_text(l.unit_price),
          'ordered_qty', tj_preview.tj_gr_dec_text(l.ordered_qty),
          'accepted_qty', tj_preview.tj_gr_dec_text(l.accepted_qty),
          'note', l.note,
          'sources', coalesce((
            select pg_catalog.jsonb_agg(
              pg_catalog.jsonb_build_object(
                'po_header_id', s.po_header_id,
                'po_line_id', s.po_line_id,
                'ordered_qty', tj_preview.tj_gr_dec_text(s.ordered_qty),
                'accepted_qty', tj_preview.tj_gr_dec_text(s.accepted_qty)
              ) order by s.po_header_id::text, s.po_line_id::text
            )
            from tj_preview.tj_gr_line_sources s
            where s.receipt_line_id = l.id
          ), '[]'::jsonb)
        ) order by l.line_no, l.id::text
      )
      from tj_preview.tj_gr_receipt_lines l
      where l.receipt_event_id = e.id
    ), '[]'::jsonb),
    'tasks', coalesce((
      select pg_catalog.jsonb_agg(tj_preview.tj_gr_task_json(t.id) order by t.po_header_id::text)
      from tj_preview.tj_gr_tasks t
      where t.receipt_event_id = e.id
    ), '[]'::jsonb),
    'missing_mappings', coalesce((
      select pg_catalog.jsonb_agg(x.po_id)
      from pg_catalog.unnest(e.po_ids) as x(po_id)
      where not exists (
        select 1 from tj_preview.tj_gr_po_mappings m where m.po_header_id = x.po_id
      )
    ), '[]'::jsonb)
  )
  into v_json
  from tj_preview.tj_gr_receipt_events e
  where e.id = p_event_id;

  return v_json;
end
$fn$;

-- 4) 收权：内部 helper 不暴露给客户端（对齐 B1 门禁约定）
revoke all on function tj_preview.tj_gr_user_display(uuid) from public, anon, authenticated;
