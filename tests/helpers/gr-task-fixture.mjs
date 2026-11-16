// 测试夹具：用真实 receipt-core / receipt-tasks 构建一个合法、已批准冻结的 task payload
// 与对应 outbox 行（payload_sha256 / event_payload_sha256 都是真实复算，JS==SQL canonical）。
import { createHash } from 'node:crypto'
import { canonicalEventPayload } from '../../web/src/lib/core/receipt-core.js'
import { canonicalTaskPayloadFromPayload } from '../../web/src/lib/core/receipt-tasks.js'

const sha256 = (s) => createHash('sha256').update(String(s)).digest('hex')

export const PO_ID = 'a1000000-0000-4000-8000-000000000001'
export const PO_LINE_ID = 'a2000000-0000-4000-8000-000000000001'
export const EVENT_ID = 'a3000000-0000-4000-8000-000000000001'
export const LINE_ID = 'a4000000-0000-4000-8000-000000000001'
export const TASK_ID = 'a5000000-0000-4000-8000-000000000001'
export const APPR_ID = '00000000-0000-4000-8000-00000000aaaa'

/**
 * 构建一个合法 task payload（普通收货，1 PO，1 行）。
 * @param {object} overrides 可覆盖 task/snapshot/scope/source_refs 的任意字段
 */
export function buildTaskPayload(overrides = {}) {
  const snapshot = {
    id: EVENT_ID,
    event_no: 'GR-MOCK-0001',
    revision: 1,
    supplier_code: '4000/A01',
    supplier_name: 'AMFIX',
    po_ids: [PO_ID],
    invoice_no: 'INV-MOCK-1001',
    delivery_order_no: 'DO-MOCK-1001',
    receive_date: '2026-11-13',
    invoice_date: '2026-11-10',
    checked_by: 'Mock Checker',
    approved_by: APPR_ID,
    approved_at: '2026-11-13T01:00:00Z',
    allow_exceptions: false,
    review_note: null,
    note: null,
    lines: [
      {
        id: LINE_ID,
        line_no: 1,
        item_code: '00101',
        description: 'HINGE',
        uom: 'UNIT',
        unit_price: '2.5',
        ordered_qty: '5',
        accepted_qty: '5',
        note: null,
        sources: [
          { po_header_id: PO_ID, po_line_id: PO_LINE_ID, ordered_qty: '5', accepted_qty: '5' },
        ],
      },
    ],
    ...(overrides.snapshot ?? {}),
  }

  // 事件哈希：先按快照（不含 payload_sha256）复算，再回填（与 receipt_approve 冻结一致）
  const eventHash = sha256(canonicalEventPayload(snapshot))
  snapshot.payload_sha256 = eventHash

  const payload = {
    task: {
      id: TASK_ID,
      type: 'GOODS_RECEIVE',
      schema: 'tj.gr.v1',
      environment: 'preview',
      mock_only: true,
      event_revision: 1,
      po_header_id: PO_ID,
      po_id: 'PO-MOCK-0001',
      irs_po_no: 'IRS-PO-1001',
      ...(overrides.task ?? {}),
    },
    mapping: {
      po_header_id: PO_ID,
      po_id: 'PO-MOCK-0001',
      irs_po_no: 'IRS-PO-1001',
      irs_invoice_no: 'INV-MOCK-1001',
      evidence_sha256: 'e'.repeat(64),
      ...(overrides.mapping ?? {}),
    },
    event_payload_sha256: eventHash,
    approved_event_snapshot: snapshot,
    scope: {
      po_header_id: PO_ID,
      po_id: 'PO-MOCK-0001',
      lines: [
        {
          line_id: LINE_ID,
          line_no: 1,
          item_code: '00101',
          description: 'HINGE',
          uom: 'UNIT',
          unit_price: '2.5',
          ordered_qty: '5',
          accepted_qty: '5',
          note: null,
          sources: [
            { po_header_id: PO_ID, po_id: 'PO-MOCK-0001', po_line_id: PO_LINE_ID, ordered_qty: '5', accepted_qty: '5' },
          ],
        },
      ],
      ...(overrides.scope ?? {}),
    },
    source_refs: [
      {
        receipt_line_id: LINE_ID,
        line_no: 1,
        po_header_id: PO_ID,
        po_id: 'PO-MOCK-0001',
        po_line_id: PO_LINE_ID,
        item_code: '00101',
        description: 'HINGE',
        uom: 'UNIT',
        unit_price: '2.5',
        ordered_qty: '5',
        accepted_qty: '5',
      },
    ],
    ...(overrides.payload ?? {}),
  }

  return { payload, eventHash, payloadSha256: sha256(canonicalTaskPayloadFromPayload(payload)) }
}

/** 构建一个合法 outbox 行（含正确 payload_sha256） */
export function buildOutboxRow(overrides = {}) {
  const { payload, payloadSha256 } = buildTaskPayload(overrides)
  return {
    id: '70000000-0000-4000-8000-000000000001',
    request_id: `gr:${TASK_ID}`,
    kind: 'gr_task_dispatch',
    task_id: TASK_ID,
    receipt_event_id: EVENT_ID,
    po_header_id: PO_ID,
    payload,
    payload_sha256: payloadSha256,
    status: 'pending',
    mock_only: true,
    ...(overrides.row ?? {}),
  }
}
