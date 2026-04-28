-- ============================================================
-- fixture: with-stock
-- 在每個 location（總倉 + 5 店）幫每支 SKU 灌一筆初始庫存
-- 量級：總倉 100 個、店家 20 個。avg_cost 取 supplier_skus.default_unit_cost 折 0.95
--
-- 採直寫 stock_balances（避免動 stock_movements 的 trigger 鏈）
-- ============================================================
\set ON_ERROR_STOP on

BEGIN;
\set t :'tenant_id'

INSERT INTO stock_balances (tenant_id, location_id, sku_id, on_hand, avg_cost, last_movement_at)
SELECT :'t'::uuid,
       l.id,
       s.id,
       (CASE WHEN l.type = 'central_warehouse' THEN 100 ELSE 20 END)::numeric,
       ROUND(COALESCE(ss.default_unit_cost, 50) * 0.95, 4),
       NOW()
FROM locations l
CROSS JOIN skus s
LEFT JOIN supplier_skus ss
       ON ss.tenant_id = s.tenant_id AND ss.sku_id = s.id
WHERE l.tenant_id = :'t'::uuid
  AND s.tenant_id = :'t'::uuid;

COMMIT;

\echo 'fixture with-stock seeded.'
