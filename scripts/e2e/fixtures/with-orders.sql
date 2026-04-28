-- ============================================================
-- fixture: with-orders
-- 依賴 with-campaign 已建立活動。直接 \i 串入 with-campaign 確保獨立可跑。
--
-- 建立 4 筆顧客訂單，覆蓋多種狀態：
--   ORD-0001  pending           （CAMP-001、會員 M-TEST-001、平鎮取貨）
--   ORD-0002  reserved          （CAMP-002、會員 M-TEST-002、松山取貨）
--   ORD-0003  ready             （CAMP-009、會員 M-TEST-001）
--   ORD-0004  completed         （CAMP-010、會員 M-TEST-002）
-- ============================================================
\set ON_ERROR_STOP on

\ir with-campaign.sql

BEGIN;
\set t :'tenant_id'

WITH any_user AS (SELECT id FROM auth.users LIMIT 1),
     ch       AS (SELECT id FROM line_channels WHERE tenant_id = :'t'::uuid AND code = 'LC-MAIN'),
     m1       AS (SELECT id FROM members WHERE tenant_id = :'t'::uuid AND member_no = 'M-TEST-001'),
     m2       AS (SELECT id FROM members WHERE tenant_id = :'t'::uuid AND member_no = 'M-TEST-002'),
     s_pz     AS (SELECT id FROM stores  WHERE tenant_id = :'t'::uuid AND code = 'S001'),
     s_ss     AS (SELECT id FROM stores  WHERE tenant_id = :'t'::uuid AND code = 'S002')
INSERT INTO customer_orders (
  tenant_id, order_no, campaign_id, channel_id, member_id,
  nickname_snapshot, pickup_store_id, pickup_deadline, status, created_by
)
SELECT :'t'::uuid,
       x.order_no,
       (SELECT id FROM group_buy_campaigns WHERE tenant_id = :'t'::uuid AND campaign_no = x.camp),
       (SELECT id FROM ch),
       (SELECT id FROM members WHERE tenant_id = :'t'::uuid AND member_no = x.member_no),
       x.nickname,
       (SELECT id FROM stores  WHERE tenant_id = :'t'::uuid AND code = x.store),
       (CURRENT_DATE + 14)::date,
       x.status,
       (SELECT id FROM any_user)
FROM (VALUES
  ('ORD-0001', 'CAMP-001', 'M-TEST-001', '小明', 'S001', 'pending'),
  ('ORD-0002', 'CAMP-002', 'M-TEST-002', '小華', 'S002', 'reserved'),
  ('ORD-0003', 'CAMP-009', 'M-TEST-001', '小明', 'S001', 'ready'),
  ('ORD-0004', 'CAMP-010', 'M-TEST-002', '小華', 'S002', 'completed')
) AS x(order_no, camp, member_no, nickname, store, status);

-- 訂單明細
INSERT INTO customer_order_items (
  tenant_id, order_id, campaign_item_id, sku_id, qty, unit_price, status, source
)
SELECT
  :'t'::uuid,
  o.id,
  ci.id,
  ci.sku_id,
  -- 主商品 2 個、第二商品 1 個
  CASE WHEN ci.sort_order = 1 THEN 2 ELSE 1 END,
  ci.unit_price,
  CASE o.status
    WHEN 'pending'   THEN 'pending'
    WHEN 'reserved'  THEN 'reserved'
    WHEN 'ready'     THEN 'ready'
    WHEN 'completed' THEN 'picked_up'
  END,
  'manual'
FROM customer_orders o
JOIN campaign_items ci
  ON ci.campaign_id = o.campaign_id AND ci.tenant_id = o.tenant_id
WHERE o.tenant_id = :'t'::uuid;

COMMIT;

\echo 'fixture with-orders seeded (4 orders).'
