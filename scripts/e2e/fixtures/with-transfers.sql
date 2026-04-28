-- ============================================================
-- fixture: with-transfers
-- 庫存調撥情境覆蓋多狀態：
--   TF-0001  draft           平鎮 → 松山
--   TF-0002  shipped         WH-HQ → 北投店倉（待店家收貨）
--   TF-0003  received        松山 → 內湖（已完成）
-- ============================================================
\set ON_ERROR_STOP on

BEGIN;
\set t :'tenant_id'

WITH any_user AS (SELECT id FROM auth.users LIMIT 1)
INSERT INTO transfers (
  tenant_id, transfer_no, source_location, dest_location,
  status, transfer_type, requested_by, shipped_at, shipped_by,
  received_at, received_by, created_by
)
SELECT :'t'::uuid,
       x.no,
       (SELECT id FROM locations WHERE tenant_id = :'t'::uuid AND code = x.src),
       (SELECT id FROM locations WHERE tenant_id = :'t'::uuid AND code = x.dst),
       x.status,
       x.tf_type,
       (SELECT id FROM any_user),
       CASE WHEN x.status IN ('shipped','received') THEN NOW() - INTERVAL '1 day' END,
       CASE WHEN x.status IN ('shipped','received') THEN (SELECT id FROM any_user) END,
       CASE WHEN x.status = 'received' THEN NOW() - INTERVAL '12 hours' END,
       CASE WHEN x.status = 'received' THEN (SELECT id FROM any_user) END,
       (SELECT id FROM any_user)
FROM (VALUES
  ('TF-0001', 'WH-S001', 'WH-S002', 'draft',    'store_to_store'),
  ('TF-0002', 'WH-HQ',   'WH-S003', 'shipped',  'hq_to_store'),
  ('TF-0003', 'WH-S002', 'WH-S004', 'received', 'store_to_store')
) AS x(no, src, dst, status, tf_type);

INSERT INTO transfer_items (transfer_id, sku_id, qty_requested, qty_shipped, qty_received)
SELECT t.id,
       (SELECT id FROM skus WHERE tenant_id = :'t'::uuid AND sku_code = x.sku_code),
       x.qty_req,
       (CASE WHEN t.status IN ('shipped','received') THEN x.qty_req ELSE 0 END),
       (CASE WHEN t.status = 'received' THEN x.qty_req ELSE 0 END)
FROM transfers t
JOIN (VALUES
  ('TF-0001', 'SKU-001', 5),
  ('TF-0001', 'SKU-002', 3),
  ('TF-0002', 'SKU-001', 10),
  ('TF-0003', 'SKU-005', 4)
) AS x(no, sku_code, qty_req) ON t.transfer_no = x.no
WHERE t.tenant_id = :'t'::uuid;

COMMIT;

\echo 'fixture with-transfers seeded.'
