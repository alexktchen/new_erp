-- ============================================================
-- fixture: with-mutual-aid
-- 互助板：3 則 request 類型貼文（求助），都是 active。
-- 註：post_type='offer' 必須帶 source_customer_order_id，固定流程改在
--     with-orders 之後另外處理；此處只放 request 不依賴交易單。
-- ============================================================
\set ON_ERROR_STOP on

BEGIN;

WITH any_user AS (SELECT id FROM auth.users LIMIT 1)
INSERT INTO mutual_aid_board (
  tenant_id, offering_store_id, sku_id,
  qty_available, qty_remaining, expires_at, note, status,
  post_type, source_customer_order_id, created_by
)
SELECT :'tenant_id'::uuid,
       (SELECT id FROM stores WHERE tenant_id = :'tenant_id'::uuid AND code = x.store_code),
       (SELECT id FROM skus   WHERE tenant_id = :'tenant_id'::uuid AND sku_code = x.sku_code),
       x.qty,
       x.qty_remain,
       NOW() + (x.expires_in_days || ' days')::interval,
       x.note,
       'active',
       'request',
       NULL,
       (SELECT id FROM any_user)
FROM (VALUES
  ('S001', 'SKU-002', 12, 12, '需求：請其他店支援',     7),
  ('S002', 'SKU-006',  6,  3, '需求：缺貨急徵',         5),
  ('S003', 'SKU-008', 20, 20, '需求：要辦活動，求支援', 3)
) AS x(store_code, sku_code, qty, qty_remain, note, expires_in_days);

COMMIT;

\echo 'fixture with-mutual-aid seeded.'
