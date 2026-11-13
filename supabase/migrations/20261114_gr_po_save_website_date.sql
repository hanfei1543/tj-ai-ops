-- 修复：tj_preview.tj_gr_po_save 之前不写 website_po_date（INSERT/UPDATE 列清单均缺），
-- 导致普通单在 Preview 经 po_save 保存后 website_po_date 恒为 NULL，8 列导出时 fail closed。
--
-- 本迁移为 reentrant：create or replace function，重复 apply 幂等。
-- 只改 tj_preview；public 版需由 scripts/gr-gen-public-prepared.mjs 重新生成后另行授权应用。
--
-- 变更点：
--   1) 输入校验：website_po_date 必填且匹配 yyyy-MM-dd，否则 GR_VALIDATION。
--   2) INSERT 列清单 + values 写入 website_po_date。
--   3) UPDATE 写入 website_po_date（显式覆盖，不用 coalesce —— 日期必填）。
--   读回一致性：函数末尾已 return tj_preview.tj_gr_po_json(v_id)，其返回体含
--   website_po_date（tj_gr_date_text），客户端按此读回比对。

create or replace function tj_preview.tj_gr_po_save(p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_uid uuid;
  v_request text := p_data ->> 'request_id';
  v_cached jsonb;
  v_id uuid := nullif(p_data ->> 'id','')::uuid;
  h tj_preview.tj_po_headers%rowtype;
  v_cur tj_preview.tj_po_lines%rowtype;
  v_line jsonb;
  v_line_id uuid;
  v_i int := 0;
  v_ref boolean;
  v_keep uuid[] := '{}';
  v_result jsonb;
  v_fp text;
  v_saved_fp text;
  v_seen_nos int[] := '{}';
  v_no int;
  v_existing_id uuid;
  v_date date;
begin
  v_uid := tj_preview.tj_gr_require_role(array['staff','approver']);

  -- website_po_date 必填 + 格式校验（普通单保存不默认当天、不推断时间戳）。
  -- 非法真实日期（如 2026-02-30）会在 ::date 处 raise，整笔回滚。
  if (p_data ->> 'website_po_date') is null
     or (p_data ->> 'website_po_date') !~ '^\d{4}-\d{2}-\d{2}$' then
    perform tj_preview.tj_gr_fail('GR_VALIDATION',
      'website_po_date 必填 yyyy-MM-dd（不默认当天，不推断时间戳）',
      pg_catalog.jsonb_build_object('field','website_po_date'));
  end if;
  v_date := (p_data ->> 'website_po_date')::date;

  v_cached := tj_preview.tj_gr_request_begin('po_save', v_request, p_data);
  if v_cached is not null then
    return v_cached;
  end if;

  if v_id is null then
    v_id := gen_random_uuid();
  end if;

  -- 内容指纹（去掉 request_id/created_by）：同 id + 同内容 = 幂等重放，不再写第二份
  v_fp := tj_preview.tj_gr_sha256(
    (p_data - 'request_id' - 'created_by' - 'revision' - 'po_revision')::text);

  select * into h from tj_preview.tj_po_headers where id = v_id for update;

  if found then
    select request_hash into v_saved_fp
      from tj_preview.tj_gr_requests
     where request_id = 'po_save:' || v_id::text;

    if v_saved_fp is not null and v_saved_fp = v_fp then
      insert into tj_preview.tj_gr_audit(actor, action, entity, entity_id, detail)
      values (v_uid, 'po_save_replay', 'po_header', v_id::text, '{}'::jsonb);
      return tj_preview.tj_gr_po_json(v_id);
    end if;

    if h.frozen then
      perform tj_preview.tj_gr_fail('GR_STATE', '已批准冻结的 PO 不能通过 po_save 修改（po_id=' || h.po_id || '）',
        pg_catalog.jsonb_build_object('po_id', h.po_id));
    end if;
    if p_data ? 'supplier_code' and (p_data ->> 'supplier_code') is not null
       and (p_data ->> 'supplier_code') <> h.supplier_code then
      -- 供应商变更会影响已引用收货：拒绝（避免历史来源错挂）
      if exists (select 1 from tj_preview.tj_gr_line_sources s
                 join tj_preview.tj_po_lines l on l.id = s.po_line_id
                 where l.po_header_id = h.id) then
        perform tj_preview.tj_gr_fail('GR_STATE', '该 PO 已被收货引用，不能改供应商');
      end if;
    end if;

    update tj_preview.tj_po_headers set
      supplier_code = coalesce(p_data ->> 'supplier_code', supplier_code),
      supplier_name = coalesce(p_data ->> 'supplier_name', supplier_name),
      notes = case when p_data ? 'notes' then p_data ->> 'notes' else notes end,
      website_po_date = v_date,
      updated_at = now()
    where id = v_id;
  else
    insert into tj_preview.tj_po_headers (id, supplier_code, supplier_name, status, po_type, notes, created_by, website_po_date)
    values (v_id,
            p_data ->> 'supplier_code',
            p_data ->> 'supplier_name',
            'confirmed',
            'standard',
            p_data ->> 'notes',
            coalesce(nullif(p_data ->> 'created_by',''), v_uid::text),
            v_date);
  end if;

  if pg_catalog.jsonb_typeof(p_data -> 'lines') = 'array' then
    for v_line in select value from pg_catalog.jsonb_array_elements(p_data -> 'lines') loop
      v_i := v_i + 1;
      v_line_id := nullif(v_line ->> 'id','')::uuid;
      v_no := coalesce((v_line ->> 'line_no')::int, v_i);

      if v_no = any (v_seen_nos) then
        perform tj_preview.tj_gr_fail('GR_VALIDATION', pg_catalog.format('line_no 重复：%s', v_no));
      end if;
      v_seen_nos := v_seen_nos || v_no;

      if v_line_id is not null then
        -- 稳定明细 id：存在则更新；被收货引用时业务字段不可改
        if exists (select 1 from tj_preview.tj_po_lines l where l.id = v_line_id and l.po_header_id = v_id) then
          select * into v_cur from tj_preview.tj_po_lines where id = v_line_id;
          select exists (
            select 1 from tj_preview.tj_gr_line_sources s where s.po_line_id = v_line_id
          ) into v_ref;

          if v_ref then
            -- 已被收货引用：业务字段必须与原值一致（显式拒绝，不能静默忽略调用方修改）
            if (v_line ? 'item_code' and (v_line ->> 'item_code') is distinct from v_cur.item_code)
               or (v_line ? 'uom' and coalesce(v_line ->> 'uom','') is distinct from coalesce(v_cur.uom,''))
               or (v_line ? 'description' and coalesce(v_line ->> 'description','') is distinct from coalesce(v_cur.description,''))
               or (v_line ? 'unit_price' and tj_preview.tj_gr_dec(v_line -> 'unit_price','unit_price') is distinct from v_cur.unit_price)
               or (v_line ? 'qty' and tj_preview.tj_gr_dec(v_line -> 'qty','qty') is distinct from v_cur.qty)
            then
              perform tj_preview.tj_gr_fail('GR_STATE',
                '明细已被收货引用：item_code/uom/description/qty/unit_price 不可修改',
                pg_catalog.jsonb_build_object('po_line_id', v_line_id));
            end if;

            update tj_preview.tj_po_lines set
              line_no = coalesce((v_line ->> 'line_no')::int, line_no),
              note = coalesce(v_line ->> 'note', note)
            where id = v_line_id;
          else
            update tj_preview.tj_po_lines set
              line_no = coalesce((v_line ->> 'line_no')::int, line_no),
              description = coalesce(v_line ->> 'description', description),
              note = coalesce(v_line ->> 'note', note),
              item_code = coalesce(v_line ->> 'item_code', item_code),
              uom = coalesce(v_line ->> 'uom', uom),
              unit_price = coalesce(tj_preview.tj_gr_dec(v_line -> 'unit_price','unit_price'), unit_price),
              qty = coalesce(tj_preview.tj_gr_dec(v_line -> 'qty','qty'), qty)
            where id = v_line_id;
          end if;
          v_keep := v_keep || v_line_id;
        else
          insert into tj_preview.tj_po_lines
            (id, po_header_id, line_no, item_code, description, uom, qty, unit_price)
          values (
            v_line_id, v_id, v_no,
            v_line ->> 'item_code',
            v_line ->> 'description',
            v_line ->> 'uom',
            tj_preview.tj_gr_dec(v_line -> 'qty','qty'),
            tj_preview.tj_gr_dec(v_line -> 'unit_price','unit_price'));
          v_keep := v_keep || v_line_id;
        end if;
      else
        -- 没有稳定 id：先按 (header, line_no) 找已有未引用行 → 更新而不是再插一份
        v_existing_id := null;
        select l.id into v_existing_id
          from tj_preview.tj_po_lines l
         where l.po_header_id = v_id and l.line_no = v_no
           and not exists (select 1 from tj_preview.tj_gr_line_sources s where s.po_line_id = l.id)
         order by l.id::text limit 1;

        if v_existing_id is not null then
          update tj_preview.tj_po_lines set
            description = coalesce(v_line ->> 'description', description),
            item_code = coalesce(v_line ->> 'item_code', item_code),
            uom = coalesce(v_line ->> 'uom', uom),
            unit_price = coalesce(tj_preview.tj_gr_dec(v_line -> 'unit_price','unit_price'), unit_price),
            qty = coalesce(tj_preview.tj_gr_dec(v_line -> 'qty','qty'), qty)
          where id = v_existing_id;
          v_line_id := v_existing_id;
        else
          insert into tj_preview.tj_po_lines
            (po_header_id, line_no, item_code, description, uom, qty, unit_price)
          values (
            v_id, v_no,
            v_line ->> 'item_code',
            v_line ->> 'description',
            v_line ->> 'uom',
            tj_preview.tj_gr_dec(v_line -> 'qty','qty'),
            tj_preview.tj_gr_dec(v_line -> 'unit_price','unit_price'))
          returning id into v_line_id;
        end if;
        v_keep := v_keep || v_line_id;
      end if;
    end loop;

    -- 只删除"本次未提交且未被收货引用"的明细；已引用明细禁止删除
    if exists (
      select 1 from tj_preview.tj_po_lines l
      where l.po_header_id = v_id
        and not (l.id = any (v_keep))
        and exists (select 1 from tj_preview.tj_gr_line_sources s where s.po_line_id = l.id)
    ) then
      perform tj_preview.tj_gr_fail('GR_STATE', '已被收货引用的明细不能删除', pg_catalog.jsonb_build_object('po_id', v_id));
    end if;
    delete from tj_preview.tj_po_lines l
     where l.po_header_id = v_id and not (l.id = any (v_keep));
  end if;

  -- 记录内容指纹（按 header 覆盖），供无 request_id 的重放识别
  insert into tj_preview.tj_gr_requests(request_id, action, actor, request_hash, response)
  values ('po_save:' || v_id::text, 'po_save_content', v_uid, v_fp, null)
  on conflict (request_id) do update
    set request_hash = excluded.request_hash, actor = excluded.actor;

  v_result := tj_preview.tj_gr_po_json(v_id);
  perform tj_preview.tj_gr_request_done('po_save', v_request, p_data, v_result);

  insert into tj_preview.tj_gr_audit(actor, action, entity, entity_id, detail)
  values (v_uid, 'po_save', 'po_header', v_id::text, pg_catalog.jsonb_build_object('lines', v_i));

  return v_result;
end
$fn$;
