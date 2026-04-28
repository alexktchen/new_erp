-- ============================================================
-- E2E reset · step 01 · master data
-- 灌主檔（locations / stores / brands / categories / member_tiers /
--          suppliers / products / skus / sku_packs / barcodes / prices /
--          expense_categories / petty_cash_accounts / line_channels /
--          post_templates / purchase_approval_thresholds）
--
-- 期望 psql 變數 :tenant_id（reset.sh 從 auth.users.app_metadata 取得後注入）
-- ============================================================
\set ON_ERROR_STOP on

BEGIN;

-- 把 :tenant_id 固定下來避免每行重複型別轉換
\set t :'tenant_id'

-- ── locations（1 倉 + 5 店各一個 location）────────────────────
INSERT INTO locations (tenant_id, code, name, type) VALUES
  (:'t'::uuid, 'WH-HQ',   '經總倉',   'central_warehouse'),
  (:'t'::uuid, 'WH-S001', '平鎮店倉', 'store'),
  (:'t'::uuid, 'WH-S002', '松山店倉', 'store'),
  (:'t'::uuid, 'WH-S003', '北投店倉', 'store'),
  (:'t'::uuid, 'WH-S004', '內湖店倉', 'store'),
  (:'t'::uuid, 'WH-S005', '信義店倉', 'store');

-- ── brands ────────────────────────────────────────────────
INSERT INTO brands (tenant_id, code, name) VALUES
  (:'t'::uuid, 'BR-LT',  '自有品牌'),
  (:'t'::uuid, 'BR-IMP', '進口品牌'),
  (:'t'::uuid, 'BR-OTH', '其他');

-- ── categories（level=1 的三大類）─────────────────────────
INSERT INTO categories (tenant_id, code, name, level, sort_order) VALUES
  (:'t'::uuid, 'C-FRESH', '生鮮', 1, 1),
  (:'t'::uuid, 'C-DRY',   '乾貨', 1, 2),
  (:'t'::uuid, 'C-COND',  '調味', 1, 3);

-- ── member_tiers ──────────────────────────────────────────
INSERT INTO member_tiers (tenant_id, code, name, sort_order, benefits) VALUES
  (:'t'::uuid, 'T-NORMAL', '一般會員', 1, '{"points_multiplier":1.0,"member_price_eligible":false}'::jsonb),
  (:'t'::uuid, 'T-SILVER', '銀卡會員', 2, '{"points_multiplier":1.2,"member_price_eligible":true}'::jsonb),
  (:'t'::uuid, 'T-GOLD',   '金卡會員', 3, '{"points_multiplier":1.5,"member_price_eligible":true}'::jsonb);

-- ── suppliers ─────────────────────────────────────────────
INSERT INTO suppliers (tenant_id, code, name, contact_name, phone, payment_terms, lead_time_days) VALUES
  (:'t'::uuid, 'SUP-LOCAL', '本地供應商', '王小明', '02-2345-6789', 'NET30', 3),
  (:'t'::uuid, 'SUP-JP',    '日本進口商', '田中太郎', '03-3456-7890', 'NET60', 21),
  (:'t'::uuid, 'SUP-XL',    '小蘭代購',   '小蘭',     '0911-222-333', 'COD',   7);

-- ── stores（5 家，必須在 suppliers 後因為 stores.supplier_id FK）────
INSERT INTO stores (tenant_id, code, name, location_id, notification_mode,
                    pickup_window_days, allowed_payment_methods, supplier_id) VALUES
  (:'t'::uuid, 'S001', '平鎮店',
   (SELECT id FROM locations WHERE tenant_id = :'t'::uuid AND code = 'WH-S001'),
   'simple', 5, '["cash","wallet"]'::jsonb,
   (SELECT id FROM suppliers WHERE tenant_id = :'t'::uuid AND code = 'SUP-LOCAL')),
  (:'t'::uuid, 'S002', '松山店',
   (SELECT id FROM locations WHERE tenant_id = :'t'::uuid AND code = 'WH-S002'),
   'simple', 5, '["cash","wallet"]'::jsonb,
   (SELECT id FROM suppliers WHERE tenant_id = :'t'::uuid AND code = 'SUP-LOCAL')),
  (:'t'::uuid, 'S003', '北投店',
   (SELECT id FROM locations WHERE tenant_id = :'t'::uuid AND code = 'WH-S003'),
   'simple', 5, '["cash","wallet"]'::jsonb,
   (SELECT id FROM suppliers WHERE tenant_id = :'t'::uuid AND code = 'SUP-LOCAL')),
  (:'t'::uuid, 'S004', '內湖店',
   (SELECT id FROM locations WHERE tenant_id = :'t'::uuid AND code = 'WH-S004'),
   'simple', 5, '["cash","wallet"]'::jsonb,
   (SELECT id FROM suppliers WHERE tenant_id = :'t'::uuid AND code = 'SUP-LOCAL')),
  (:'t'::uuid, 'S005', '信義店',
   (SELECT id FROM locations WHERE tenant_id = :'t'::uuid AND code = 'WH-S005'),
   'simple', 5, '["cash","wallet"]'::jsonb,
   (SELECT id FROM suppliers WHERE tenant_id = :'t'::uuid AND code = 'SUP-LOCAL'));

-- ── products（10 個）── name / brand_code / category_code / product_code
INSERT INTO products (tenant_id, product_code, name, short_name, brand_id, category_id, status)
SELECT :'t'::uuid, x.code, x.name, x.short,
       (SELECT id FROM brands     WHERE tenant_id = :'t'::uuid AND code = x.brand_code),
       (SELECT id FROM categories WHERE tenant_id = :'t'::uuid AND code = x.cat_code),
       'active'
FROM (VALUES
  ('P001', '日本岡田屋綜合海老蝦餅185g', '海老蝦餅',   'BR-IMP', 'C-DRY'),
  ('P002', '台灣黑糖薑茶塊120g',         '黑糖薑茶',   'BR-LT',  'C-DRY'),
  ('P003', '日本醬油1L',                 '日本醬油',   'BR-IMP', 'C-COND'),
  ('P004', '台灣香米2kg',                '香米2kg',    'BR-LT',  'C-DRY'),
  ('P005', '冷凍魚丸500g',               '魚丸',       'BR-OTH', 'C-FRESH'),
  ('P006', '蜂蜜罐裝500g',               '蜂蜜500g',   'BR-IMP', 'C-COND'),
  ('P007', '中筋麵粉1kg',                '麵粉1kg',    'BR-LT',  'C-DRY'),
  ('P008', '土雞蛋10入',                 '雞蛋10入',   'BR-OTH', 'C-FRESH'),
  ('P009', '糯米醋500ml',                '糯米醋',     'BR-IMP', 'C-COND'),
  ('P010', '綜合餅乾禮盒800g',           '餅乾禮盒',   'BR-IMP', 'C-DRY')
) AS x(code, name, short, brand_code, cat_code);

-- ── skus（每商品一個 SKU，sku_code = SKU-001..010）────────
INSERT INTO skus (tenant_id, product_id, sku_code, base_unit, tax_rate,
                  product_name, category_id, brand_id, status)
SELECT p.tenant_id,
       p.id,
       'SKU-' || RIGHT(p.product_code, 3),
       '個',
       0.05,
       p.name,
       p.category_id,
       p.brand_id,
       'active'
FROM products p
WHERE p.tenant_id = :'t'::uuid;

-- ── sku_packs（每 SKU 一個預設 pack：unit=base_unit、qty=1、is_default_sale=true）
INSERT INTO sku_packs (sku_id, unit, qty_in_base, for_sale, for_purchase, for_transfer, is_default_sale)
SELECT id, '個', 1, TRUE, TRUE, TRUE, TRUE
FROM skus
WHERE tenant_id = :'t'::uuid;

-- ── barcodes（每 SKU 一個 internal 條碼）──────────────────
INSERT INTO barcodes (tenant_id, barcode_value, sku_id, unit, pack_qty, type, is_primary)
SELECT s.tenant_id,
       'INT' || LPAD((ROW_NUMBER() OVER (ORDER BY s.id))::text, 9, '0'),
       s.id,
       '個',
       1,
       'internal',
       TRUE
FROM skus s
WHERE s.tenant_id = :'t'::uuid;

-- ── internal_barcode_sequence（依目前條碼數量推進）────────
INSERT INTO internal_barcode_sequence (tenant_id, next_seq) VALUES
  (:'t'::uuid, 11);

-- ── prices（每 SKU × 3 tier = 30 筆，零售 retail 也加一筆）────
-- 用 first_user UUID 當 created_by 避免拿不到 NULL
WITH any_user AS (
  SELECT id FROM auth.users LIMIT 1
)
INSERT INTO prices (tenant_id, sku_id, scope, scope_id, price, effective_from, created_by)
SELECT s.tenant_id, s.id, 'retail', NULL,
       (CASE s.sku_code
          WHEN 'SKU-001' THEN 135
          WHEN 'SKU-002' THEN 80
          WHEN 'SKU-003' THEN 220
          WHEN 'SKU-004' THEN 180
          WHEN 'SKU-005' THEN 95
          WHEN 'SKU-006' THEN 350
          WHEN 'SKU-007' THEN 65
          WHEN 'SKU-008' THEN 110
          WHEN 'SKU-009' THEN 90
          WHEN 'SKU-010' THEN 480
        END)::numeric,
       NOW(), (SELECT id FROM any_user)
FROM skus s
WHERE s.tenant_id = :'t'::uuid;

-- 三個 tier 各折扣（金卡 0.85 / 銀卡 0.92 / 一般 1.0）
WITH any_user AS (SELECT id FROM auth.users LIMIT 1),
     tiers AS (
       SELECT id, code FROM member_tiers WHERE tenant_id = :'t'::uuid
     ),
     base AS (
       SELECT s.id AS sku_id,
              (CASE s.sku_code
                 WHEN 'SKU-001' THEN 135 WHEN 'SKU-002' THEN 80
                 WHEN 'SKU-003' THEN 220 WHEN 'SKU-004' THEN 180
                 WHEN 'SKU-005' THEN 95  WHEN 'SKU-006' THEN 350
                 WHEN 'SKU-007' THEN 65  WHEN 'SKU-008' THEN 110
                 WHEN 'SKU-009' THEN 90  WHEN 'SKU-010' THEN 480
               END)::numeric AS retail
       FROM skus s
       WHERE s.tenant_id = :'t'::uuid
     )
INSERT INTO prices (tenant_id, sku_id, scope, scope_id, price, effective_from, created_by)
SELECT :'t'::uuid, b.sku_id, 'member_tier', t.id,
       ROUND(b.retail * (CASE t.code
                           WHEN 'T-GOLD'   THEN 0.85
                           WHEN 'T-SILVER' THEN 0.92
                           ELSE 1.00 END)::numeric, 2),
       NOW(),
       (SELECT id FROM any_user)
FROM base b CROSS JOIN tiers t;

-- ── expense_categories（5 筆 P&L 科目）────────────────────
INSERT INTO expense_categories (tenant_id, code, name, default_pay_method) VALUES
  (:'t'::uuid, 'EC-RENT',    '租金',     'company_account'),
  (:'t'::uuid, 'EC-UTIL',    '水電',     'company_account'),
  (:'t'::uuid, 'EC-OFF',     '辦公耗材', 'either'),
  (:'t'::uuid, 'EC-FREIGHT', '運費',     'either'),
  (:'t'::uuid, 'EC-MISC',    '其他雜支', 'petty_cash');

-- ── petty_cash_accounts（每店一個零用金戶）────────────────
INSERT INTO petty_cash_accounts (tenant_id, store_id, account_name, balance, credit_limit)
SELECT :'t'::uuid, s.id, '主零用金', 5000, 20000
FROM stores s
WHERE s.tenant_id = :'t'::uuid;

-- ── line_channels（一個測試社群，主店 = 平鎮）─────────────
INSERT INTO line_channels (tenant_id, code, name, channel_type, home_store_id, additional_pickup_store_ids)
SELECT :'t'::uuid, 'LC-MAIN', '主社群（測試）', 'open_chat',
       (SELECT id FROM stores WHERE tenant_id = :'t'::uuid AND code = 'S001'),
       (
         SELECT COALESCE(jsonb_agg(id), '[]'::jsonb)
         FROM stores
         WHERE tenant_id = :'t'::uuid AND code IN ('S002','S003','S004','S005')
       );

-- ── post_templates ─────────────────────────────────────────
INSERT INTO post_templates (tenant_id, code, name, body) VALUES
  (:'t'::uuid, 'PT-DEFAULT', '預設模板',
   '【開團】{{name}}\n截止：{{end_at}}\n商品：{{items}}');

-- ── purchase_approval_thresholds（3 級門檻 global）────────
INSERT INTO purchase_approval_thresholds (tenant_id, scope, scope_id, threshold_amount, approver_role) VALUES
  (:'t'::uuid, 'global', NULL,    5000, 'admin'),
  (:'t'::uuid, 'global', NULL,   50000, 'hq_manager'),
  (:'t'::uuid, 'global', NULL,  500000, 'owner');

-- ── supplier_skus（每 SKU 預設由 SUP-LOCAL 提供）──────────
INSERT INTO supplier_skus (tenant_id, supplier_id, sku_id, default_unit_cost, pack_qty, is_preferred)
SELECT :'t'::uuid,
       (SELECT id FROM suppliers WHERE tenant_id = :'t'::uuid AND code = 'SUP-LOCAL'),
       s.id,
       (CASE s.sku_code
          WHEN 'SKU-001' THEN 90  WHEN 'SKU-002' THEN 50
          WHEN 'SKU-003' THEN 150 WHEN 'SKU-004' THEN 130
          WHEN 'SKU-005' THEN 60  WHEN 'SKU-006' THEN 250
          WHEN 'SKU-007' THEN 40  WHEN 'SKU-008' THEN 75
          WHEN 'SKU-009' THEN 60  WHEN 'SKU-010' THEN 320
        END)::numeric,
       1,
       TRUE
FROM skus s
WHERE s.tenant_id = :'t'::uuid;

COMMIT;

\echo 'master seeded.'
