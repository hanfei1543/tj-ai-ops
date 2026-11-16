-- Read only: no ingest/replay, no writes, no guessed IRS number.
select jsonb_build_object(
  'historical_manual', (select jsonb_build_object('id',m.id,'po_id',m.po_id,'irs_po_no',m.irs_po_no,
    'classification',m.classification,'source_sha256',m.source_sha256,
    'legacy_intent_sha256',m.push_intent_xlsx_sha256)
    from tj_preview.tj_po_manual_reconciliations m where m.po_id='PO-000026'),
  'new_po', (select jsonb_build_object('po_id',h.po_id,'irs_po_no',h.irs_po_no,'erp_status',h.erp_status,
    'intent_id',i.id,'delivery_state',i.state,'delivery_channel',i.delivery_channel,
    'xlsx_sha256',i.xlsx_sha256,
    'delivery_evidence',(select jsonb_agg(jsonb_build_object('stage',e.stage,'sha256',e.xlsx_sha256,'bytes',e.byte_count))
       from tj_preview.tj_po_push_delivery_evidence e where e.intent_id=i.id),
    'accepted_receipts',(select coalesce(jsonb_agg(jsonb_build_object('receipt_id',r.id,'event_id',r.event_id,
       'irs_po_number',r.irs_po_number,'source_sha256',r.evidence->>'source_sha256',
       'header_irs_match',r.irs_po_number=h.irs_po_no,
       'delivered_sha_match',lower(r.evidence->>'source_sha256')=lower(i.xlsx_sha256),
       'deterministic_event_match',r.event_id=tj_preview.tj_po_ack_event_id(h.po_id,r.evidence->>'source_sha256',r.irs_po_number)
       )), '[]'::jsonb) from tj_preview.tj_po_ack_receipts r where r.po_header_id=h.id and r.state='accepted'))
    from tj_preview.tj_po_headers h left join tj_preview.tj_po_push_intents i on i.po_header_id=h.id
    where h.id='70a04f2b-bb5a-4b2d-a607-ae10f42a10f1')
) as stage25_readback;
