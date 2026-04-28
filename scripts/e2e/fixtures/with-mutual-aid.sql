-- ============================================================
-- fixture: with-mutual-aid
-- 互助板：3 則庫存釋出貼文（active），其中 1 則被部分認領
-- ============================================================
\set ON_ERROR_STOP on

BEGIN;
\set t :'tenant_id'

WITH any_user AS (SELECT id FROM auth.users LIMIT 1)
INSERT INTO mutual_aid_board (
  tenant_id, offering_store_id, sku_id,
  qty_available, qty_remaining, expires_at, note, status, created_by
)
SELECT :'t'::uuid,
       (SELECT id FROM stores WHERE tenant_id = :'t'::uuid AND code = x.store_code),
       (SELECT id FROM skus   WHERE tenant_id = :'t'::uuid AND sku_code = x.sku_code),
       x.qty,
       x.qty_remain,
       NOW() + (x.expires_in_days || ' days')::interval,
       x.note,
       'active',
       (SELECT id FROM any_user)
FROM (VALUES
  ('S001', 'SKU-002', 12, 12, '尚未被認領',          7),
  ('S002', 'SKU-006',  6,  3, '已被認領一半',        5),
  ('S003', 'SKU-008', 20, 20, '生鮮快過期、急釋出',  3)
) AS x(store_code, sku_code, qty, qty_remain, note, expires_in_days);

COMMIT;

\echo 'fixture with-mutual-aid seeded.'
