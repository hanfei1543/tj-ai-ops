-- 增量迁移：修正 canonical 排序为字节序（COLLATE "C"），对齐 JS 端 .sort()。
-- 背景：tj_gr_task_canonical / tj_gr_event_canonical 的 `order by k` 默认用数据库 collation，
--       在 Supabase(ICU/locale) 下 `event_payload_sha256`(下划线) 与 `event.*`(点) 的排序与
--       JS 字节序不一致，导致 SQL 与 JS 复算的 SHA-256 分叉。PGlite(WASM) 默认 C collation
--       所以本地 smoke 未暴露；真实 Supabase 暴露。本迁移只改排序 collation，不改任何语义。
-- 仅应用 tj_preview；public 生产版 gr_unified_public_prepared.sql 需同步（本轮不应用 public）。

create or replace function tj_preview.tj_gr_event_canonical(p_event_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $fn$
  select pg_catalog.string_agg(tj_preview.tj_gr_kv(x.k, x.v), chr(10) order by x.k collate "C")
  from tj_preview.tj_gr_event_kv(p_event_id) as x
$fn$;


create or replace function tj_preview.tj_gr_task_canonical(p_payload jsonb)
returns text
language sql
immutable
set search_path = ''
as $fn$
  with snap as (
    select coalesce(p_payload -> 'approved_event_snapshot', '{}'::jsonb) as s
  ),
  ev as (
    select 'schema'::text as k, 'tj.gr.v1'::text as v
    union all select 'kind', 'goods_receive'
    union all select 'environment', 'preview'
    union all select 'event.id', s ->> 'id' from snap
    union all select 'event.event_no', s ->> 'event_no' from snap
    union all select 'event.revision', (s ->> 'revision') from snap
    union all select 'event.supplier_code', s ->> 'supplier_code' from snap
    union all select 'event.supplier_name', s ->> 'supplier_name' from snap
    union all select 'event.po_ids', (
      select pg_catalog.string_agg(x, ',' order by x)
      from pg_catalog.jsonb_array_elements_text(coalesce(s -> 'po_ids', '[]'::jsonb)) as t(x)
    ) from snap
    union all select 'event.invoice_no', s ->> 'invoice_no' from snap
    union all select 'event.delivery_order_no', s ->> 'delivery_order_no' from snap
    union all select 'event.receive_date', s ->> 'receive_date' from snap
    union all select 'event.invoice_date', s ->> 'invoice_date' from snap
    union all select 'event.checked_by', s ->> 'checked_by' from snap
    union all select 'event.approved_by', s ->> 'approved_by' from snap
    union all select 'event.approved_at', s ->> 'approved_at' from snap
    union all select 'event.allow_exceptions', s ->> 'allow_exceptions' from snap
    union all select 'event.review_note', s ->> 'review_note' from snap
    union all select 'event.note', s ->> 'note' from snap
    union all select 'event.payload_sha256', s ->> 'payload_sha256' from snap
  ),
  ol as (
    select
      pg_catalog.row_number() over (
        order by (line ->> 'line_no')::numeric, line ->> 'id'
      ) - 1 as i,
      line
    from snap, pg_catalog.jsonb_array_elements(coalesce(s -> 'lines', '[]'::jsonb)) as x(line)
  ),
  linekv as (
    select pg_catalog.format('lines.%s.id', pg_catalog.to_char(i, 'FM0000')) as k, line ->> 'id' as v from ol
    union all select pg_catalog.format('lines.%s.line_no', pg_catalog.to_char(i, 'FM0000')), line ->> 'line_no' from ol
    union all select pg_catalog.format('lines.%s.item_code', pg_catalog.to_char(i, 'FM0000')), line ->> 'item_code' from ol
    union all select pg_catalog.format('lines.%s.description', pg_catalog.to_char(i, 'FM0000')), line ->> 'description' from ol
    union all select pg_catalog.format('lines.%s.uom', pg_catalog.to_char(i, 'FM0000')), line ->> 'uom' from ol
    union all select pg_catalog.format('lines.%s.unit_price', pg_catalog.to_char(i, 'FM0000')),
      tj_preview.tj_gr_dec_text((line ->> 'unit_price')::numeric) from ol
    union all select pg_catalog.format('lines.%s.ordered_qty', pg_catalog.to_char(i, 'FM0000')),
      tj_preview.tj_gr_dec_text((line ->> 'ordered_qty')::numeric) from ol
    union all select pg_catalog.format('lines.%s.accepted_qty', pg_catalog.to_char(i, 'FM0000')),
      tj_preview.tj_gr_dec_text((line ->> 'accepted_qty')::numeric) from ol
    union all select pg_catalog.format('lines.%s.note', pg_catalog.to_char(i, 'FM0000')), line ->> 'note' from ol
  ),
  osrc as (
    select
      ol.i,
      pg_catalog.row_number() over (
        partition by ol.i
        order by src ->> 'po_header_id', src ->> 'po_line_id'
      ) - 1 as j,
      src
    from ol
    cross join lateral pg_catalog.jsonb_array_elements(coalesce(ol.line -> 'sources', '[]'::jsonb)) as x(src)
  ),
  srckv as (
    select pg_catalog.format('lines.%s.sources.%s.po_header_id',
             pg_catalog.to_char(i, 'FM0000'), pg_catalog.to_char(j, 'FM0000')) as k, src ->> 'po_header_id' as v from osrc
    union all select pg_catalog.format('lines.%s.sources.%s.po_line_id',
             pg_catalog.to_char(i, 'FM0000'), pg_catalog.to_char(j, 'FM0000')), src ->> 'po_line_id' from osrc
    union all select pg_catalog.format('lines.%s.sources.%s.ordered_qty',
             pg_catalog.to_char(i, 'FM0000'), pg_catalog.to_char(j, 'FM0000')),
             tj_preview.tj_gr_dec_text((src ->> 'ordered_qty')::numeric) from osrc
    union all select pg_catalog.format('lines.%s.sources.%s.accepted_qty',
             pg_catalog.to_char(i, 'FM0000'), pg_catalog.to_char(j, 'FM0000')),
             tj_preview.tj_gr_dec_text((src ->> 'accepted_qty')::numeric) from osrc
  ),
  taskkv as (
    select 'event_payload_sha256'::text as k, p_payload ->> 'event_payload_sha256' as v
    union all select 'task.id', p_payload -> 'task' ->> 'id'
    union all select 'task.type', p_payload -> 'task' ->> 'type'
    union all select 'task.schema', p_payload -> 'task' ->> 'schema'
    union all select 'task.environment', p_payload -> 'task' ->> 'environment'
    union all select 'task.mock_only', p_payload -> 'task' ->> 'mock_only'
    union all select 'task.event_revision', p_payload -> 'task' ->> 'event_revision'
    union all select 'task.po_header_id', p_payload -> 'task' ->> 'po_header_id'
    union all select 'task.po_id', p_payload -> 'task' ->> 'po_id'
    union all select 'task.irs_po_no', p_payload -> 'task' ->> 'irs_po_no'
    union all select 'mapping.po_header_id', p_payload -> 'mapping' ->> 'po_header_id'
    union all select 'mapping.po_id', p_payload -> 'mapping' ->> 'po_id'
    union all select 'mapping.irs_po_no', p_payload -> 'mapping' ->> 'irs_po_no'
    union all select 'mapping.irs_invoice_no', p_payload -> 'mapping' ->> 'irs_invoice_no'
    union all select 'mapping.evidence_sha256', p_payload -> 'mapping' ->> 'evidence_sha256'
    union all select 'scope.po_header_id', p_payload -> 'scope' ->> 'po_header_id'
    union all select 'scope.po_id', p_payload -> 'scope' ->> 'po_id'
  ),
  osl as (
    select
      pg_catalog.row_number() over (
        order by (line ->> 'line_no')::numeric, line ->> 'line_id'
      ) - 1 as i,
      line
    from pg_catalog.jsonb_array_elements(
      coalesce(p_payload -> 'scope' -> 'lines', '[]'::jsonb)
    ) as x(line)
  ),
  scope_linekv as (
    select pg_catalog.format('scope.lines.%s.line_id', pg_catalog.to_char(i, 'FM0000')) as k, line ->> 'line_id' as v from osl
    union all select pg_catalog.format('scope.lines.%s.line_no', pg_catalog.to_char(i, 'FM0000')), line ->> 'line_no' from osl
    union all select pg_catalog.format('scope.lines.%s.item_code', pg_catalog.to_char(i, 'FM0000')), line ->> 'item_code' from osl
    union all select pg_catalog.format('scope.lines.%s.description', pg_catalog.to_char(i, 'FM0000')), line ->> 'description' from osl
    union all select pg_catalog.format('scope.lines.%s.uom', pg_catalog.to_char(i, 'FM0000')), line ->> 'uom' from osl
    union all select pg_catalog.format('scope.lines.%s.unit_price', pg_catalog.to_char(i, 'FM0000')),
      tj_preview.tj_gr_dec_text((line ->> 'unit_price')::numeric) from osl
    union all select pg_catalog.format('scope.lines.%s.ordered_qty', pg_catalog.to_char(i, 'FM0000')),
      tj_preview.tj_gr_dec_text((line ->> 'ordered_qty')::numeric) from osl
    union all select pg_catalog.format('scope.lines.%s.accepted_qty', pg_catalog.to_char(i, 'FM0000')),
      tj_preview.tj_gr_dec_text((line ->> 'accepted_qty')::numeric) from osl
    union all select pg_catalog.format('scope.lines.%s.note', pg_catalog.to_char(i, 'FM0000')), line ->> 'note' from osl
  ),
  ossrc as (
    select
      osl.i,
      pg_catalog.row_number() over (
        partition by osl.i
        order by src ->> 'po_header_id', src ->> 'po_line_id'
      ) - 1 as j,
      src
    from osl
    cross join lateral pg_catalog.jsonb_array_elements(coalesce(osl.line -> 'sources', '[]'::jsonb)) as x(src)
  ),
  scope_srckv as (
    select pg_catalog.format('scope.lines.%s.sources.%s.po_header_id',
             pg_catalog.to_char(i, 'FM0000'), pg_catalog.to_char(j, 'FM0000')) as k, src ->> 'po_header_id' as v from ossrc
    union all select pg_catalog.format('scope.lines.%s.sources.%s.po_id',
             pg_catalog.to_char(i, 'FM0000'), pg_catalog.to_char(j, 'FM0000')), src ->> 'po_id' from ossrc
    union all select pg_catalog.format('scope.lines.%s.sources.%s.po_line_id',
             pg_catalog.to_char(i, 'FM0000'), pg_catalog.to_char(j, 'FM0000')), src ->> 'po_line_id' from ossrc
    union all select pg_catalog.format('scope.lines.%s.sources.%s.ordered_qty',
             pg_catalog.to_char(i, 'FM0000'), pg_catalog.to_char(j, 'FM0000')),
             tj_preview.tj_gr_dec_text((src ->> 'ordered_qty')::numeric) from ossrc
    union all select pg_catalog.format('scope.lines.%s.sources.%s.accepted_qty',
             pg_catalog.to_char(i, 'FM0000'), pg_catalog.to_char(j, 'FM0000')),
             tj_preview.tj_gr_dec_text((src ->> 'accepted_qty')::numeric) from ossrc
  )
  select pg_catalog.string_agg(tj_preview.tj_gr_kv(k, v), chr(10) order by k collate "C")
  from (
    select k, v from ev
    union all select k, v from linekv
    union all select k, v from srckv
    union all select k, v from taskkv
    union all select k, v from scope_linekv
    union all select k, v from scope_srckv
  ) allkv
$fn$;

