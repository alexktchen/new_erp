-- ============================================================
-- fixture: with-campaign
-- 10 個團購活動（group_buy_campaigns），混合不同 status
-- 每個團 2~3 個商品。所有團都掛 LC-MAIN 為 channel。
-- ============================================================
\set ON_ERROR_STOP on

BEGIN;
\set t :'tenant_id'

WITH any_user AS (SELECT id FROM auth.users LIMIT 1),
     channel AS (SELECT id FROM line_channels WHERE tenant_id = :'t'::uuid AND code = 'LC-MAIN'),
     tmpl    AS (SELECT id FROM post_templates WHERE tenant_id = :'t'::uuid AND code = 'PT-DEFAULT')
INSERT INTO group_buy_campaigns (
  tenant_id, campaign_no, name, description, status, close_type,
  start_at, end_at, pickup_deadline, pickup_days,
  post_template_id, created_by
)
SELECT :'t'::uuid,
       x.campaign_no,
       x.name,
       x.descr,
       x.status,
       'regular',
       NOW() - (x.days_offset || ' days')::interval,
       NOW() + (x.days_close || ' days')::interval,
       (CURRENT_DATE + 14)::date,
       7,
       (SELECT id FROM tmpl),
       (SELECT id FROM any_user)
FROM (VALUES
  ('CAMP-001', '岡田屋海老蝦餅 #1',  '日本進口·熱門品', 'open',       -2,  5),
  ('CAMP-002', '日本醬油 #2',        '岡田屋',          'open',       -1,  6),
  ('CAMP-003', '蜂蜜罐裝 #3',        '溫和甘甜',        'open',       -3,  4),
  ('CAMP-004', '香米2kg #4',         '台灣米',          'closed',    -10, -1),
  ('CAMP-005', '黑糖薑茶 #5',        '冬天必備',        'closed',    -12, -3),
  ('CAMP-006', '糯米醋 #6',          '料理用',          'ordered',   -15, -5),
  ('CAMP-007', '冷凍魚丸 #7',        '到貨中',          'receiving', -20,-10),
  ('CAMP-008', '中筋麵粉 #8',        '到貨中',          'receiving', -22,-12),
  ('CAMP-009', '土雞蛋 #9',          '已備齊待領',      'ready',     -28,-18),
  ('CAMP-010', '綜合餅乾禮盒 #10',   '已結案',          'completed', -45,-30)
) AS x(campaign_no, name, descr, status, days_offset, days_close);

-- campaign_items：每個團掛 2~3 個 SKU，主商品就用 campaign_no 對應的 SKU
WITH camps AS (
  SELECT id, campaign_no FROM group_buy_campaigns WHERE tenant_id = :'t'::uuid
),
mapping AS (
  SELECT * FROM (VALUES
    ('CAMP-001', 'SKU-001', 135, 1),
    ('CAMP-001', 'SKU-007',  65, 2),
    ('CAMP-002', 'SKU-003', 220, 1),
    ('CAMP-002', 'SKU-009',  90, 2),
    ('CAMP-003', 'SKU-006', 350, 1),
    ('CAMP-003', 'SKU-002',  80, 2),
    ('CAMP-004', 'SKU-004', 180, 1),
    ('CAMP-005', 'SKU-002',  80, 1),
    ('CAMP-005', 'SKU-007',  65, 2),
    ('CAMP-006', 'SKU-009',  90, 1),
    ('CAMP-007', 'SKU-005',  95, 1),
    ('CAMP-007', 'SKU-008', 110, 2),
    ('CAMP-008', 'SKU-007',  65, 1),
    ('CAMP-009', 'SKU-008', 110, 1),
    ('CAMP-010', 'SKU-010', 480, 1),
    ('CAMP-010', 'SKU-001', 135, 2)
  ) AS m(campaign_no, sku_code, price, sort_order)
)
INSERT INTO campaign_items (tenant_id, campaign_id, sku_id, unit_price, sort_order)
SELECT :'t'::uuid,
       (SELECT id FROM camps WHERE campaign_no = m.campaign_no),
       (SELECT id FROM skus WHERE tenant_id = :'t'::uuid AND sku_code = m.sku_code),
       m.price,
       m.sort_order
FROM mapping m;

-- campaign_channels：每個團都掛 LC-MAIN
INSERT INTO campaign_channels (tenant_id, campaign_id, channel_id, posted_at)
SELECT :'t'::uuid,
       c.id,
       (SELECT id FROM line_channels WHERE tenant_id = :'t'::uuid AND code = 'LC-MAIN'),
       c.created_at
FROM group_buy_campaigns c
WHERE c.tenant_id = :'t'::uuid;

COMMIT;

\echo 'fixture with-campaign seeded (10 campaigns).'
