-- ============================================================
-- fixture: with-pr-po
-- 採購流：PR (請購) / PO (採購單) / GR (進貨)
--   PR-0001  draft           平鎮店請購 P004 香米×10
--   PR-0002  fully_ordered   松山店請購 P003 醬油×6
--   PO-0001  sent            SUP-LOCAL → WH-HQ
--   PO-0002  fully_received  SUP-LOCAL → WH-HQ，已驗收 → GR-0001
-- ============================================================
\set ON_ERROR_STOP on

BEGIN;

WITH any_user AS (SELECT id FROM auth.users LIMIT 1)
INSERT INTO purchase_requests (tenant_id, pr_no, source_location_id, status, created_by, submitted_at)
SELECT :'tenant_id'::uuid,
       x.pr_no,
       (SELECT id FROM locations WHERE tenant_id = :'tenant_id'::uuid AND code = x.loc),
       x.status,
       (SELECT id FROM any_user),
       CASE WHEN x.status = 'draft' THEN NULL ELSE NOW() - INTERVAL '2 days' END
FROM (VALUES
  ('PR-0001', 'WH-S001', 'draft'),
  ('PR-0002', 'WH-S002', 'fully_ordered')
) AS x(pr_no, loc, status);

INSERT INTO purchase_request_items (pr_id, sku_id, qty_requested)
SELECT pr.id,
       (SELECT id FROM skus WHERE tenant_id = :'tenant_id'::uuid AND sku_code = x.sku_code),
       x.qty
FROM purchase_requests pr
JOIN (VALUES
  ('PR-0001', 'SKU-004', 10),
  ('PR-0002', 'SKU-003',  6)
) AS x(pr_no, sku_code, qty) ON pr.pr_no = x.pr_no
WHERE pr.tenant_id = :'tenant_id'::uuid;

-- ── PO ─────────────────────────────────────────────────────
WITH any_user AS (SELECT id FROM auth.users LIMIT 1)
INSERT INTO purchase_orders (
  tenant_id, po_no, supplier_id, dest_location_id, status,
  order_date, expected_date, subtotal, tax, total, created_by, sent_at, sent_by
)
SELECT :'tenant_id'::uuid,
       x.po_no,
       (SELECT id FROM suppliers WHERE tenant_id = :'tenant_id'::uuid AND code = x.sup_code),
       (SELECT id FROM locations WHERE tenant_id = :'tenant_id'::uuid AND code = x.dest_code),
       x.status,
       (CURRENT_DATE - INTERVAL '5 days')::date,
       (CURRENT_DATE + INTERVAL '7 days')::date,
       x.subtotal,
       ROUND(x.subtotal * 0.05, 2),
       ROUND(x.subtotal * 1.05, 2),
       (SELECT id FROM any_user),
       CASE WHEN x.status IN ('sent','fully_received') THEN NOW() - INTERVAL '4 days' ELSE NULL END,
       CASE WHEN x.status IN ('sent','fully_received') THEN (SELECT id FROM any_user)      ELSE NULL END
FROM (VALUES
  ('PO-0001', 'SUP-LOCAL', 'WH-HQ', 'sent',           900),
  ('PO-0002', 'SUP-LOCAL', 'WH-HQ', 'fully_received', 1500)
) AS x(po_no, sup_code, dest_code, status, subtotal);

-- purchase_order_items：line_subtotal 為 GENERATED 欄位，不要塞值
INSERT INTO purchase_order_items (po_id, sku_id, qty_ordered, qty_received, unit_cost)
SELECT po.id,
       (SELECT id FROM skus WHERE tenant_id = :'tenant_id'::uuid AND sku_code = x.sku_code),
       x.qty,
       (CASE WHEN po.status = 'fully_received' THEN x.qty ELSE 0 END),
       x.cost
FROM purchase_orders po
JOIN (VALUES
  ('PO-0001', 'SKU-003',  6, 150),
  ('PO-0002', 'SKU-004', 10, 130),
  ('PO-0002', 'SKU-007',  4,  40)
) AS x(po_no, sku_code, qty, cost) ON po.po_no = x.po_no
WHERE po.tenant_id = :'tenant_id'::uuid;

-- ── GR（PO-0002 已驗收 → status = confirmed）──────────────
WITH any_user AS (SELECT id FROM auth.users LIMIT 1)
INSERT INTO goods_receipts (
  tenant_id, gr_no, po_id, supplier_id, dest_location_id, status, receive_date,
  received_by, confirmed_at, confirmed_by, created_by
)
SELECT :'tenant_id'::uuid,
       'GR-0001',
       po.id,
       po.supplier_id,
       po.dest_location_id,
       'confirmed',
       (CURRENT_DATE - INTERVAL '1 day')::date,
       (SELECT id FROM any_user),
       NOW() - INTERVAL '1 day',
       (SELECT id FROM any_user),
       (SELECT id FROM any_user)
FROM purchase_orders po
WHERE po.tenant_id = :'tenant_id'::uuid AND po.po_no = 'PO-0002';

INSERT INTO goods_receipt_items (gr_id, po_item_id, sku_id, qty_expected, qty_received, unit_cost)
SELECT gr.id, poi.id, poi.sku_id, poi.qty_ordered, poi.qty_ordered, poi.unit_cost
FROM goods_receipts gr
JOIN purchase_orders po ON po.id = gr.po_id
JOIN purchase_order_items poi ON poi.po_id = po.id
WHERE gr.tenant_id = :'tenant_id'::uuid AND gr.gr_no = 'GR-0001';

COMMIT;

\echo 'fixture with-pr-po seeded.'
