-- ============================================================
-- E2E reset · step 02 · base fixtures
-- 所有 scenario 都會跑這支：
--   - 1 個測試會員（手機 0900000001、家店 = S001 平鎮店、tier = T-NORMAL）
--   - LINE 暱稱 ↔ 會員綁定（讓「貼單建單」的解析能命中）
--
-- 不動 auth.users（員工帳號 / 員工→店家的綁定一律手動透過 Supabase
-- Dashboard 維護 raw_app_meta_data.location_id）
-- ============================================================
\set ON_ERROR_STOP on

BEGIN;

-- 測試會員 M-TEST-001
INSERT INTO members (
  tenant_id, member_no, phone_hash, name, member_type,
  tier_id, home_store_id, status, joined_at
) VALUES (
  :'tenant_id'::uuid,
  'M-TEST-001',
  encode(digest('0900000001', 'sha256'), 'hex'),
  '測試小明',
  'full',
  (SELECT id FROM member_tiers WHERE tenant_id = :'tenant_id'::uuid AND code = 'T-NORMAL'),
  (SELECT id FROM stores       WHERE tenant_id = :'tenant_id'::uuid AND code = 'S001'),
  'active',
  NOW()
);

-- 第二個會員 M-TEST-002（家店 S002 松山，金卡）
INSERT INTO members (
  tenant_id, member_no, phone_hash, name, member_type,
  tier_id, home_store_id, status, joined_at
) VALUES (
  :'tenant_id'::uuid,
  'M-TEST-002',
  encode(digest('0900000002', 'sha256'), 'hex'),
  '測試小華',
  'full',
  (SELECT id FROM member_tiers WHERE tenant_id = :'tenant_id'::uuid AND code = 'T-GOLD'),
  (SELECT id FROM stores       WHERE tenant_id = :'tenant_id'::uuid AND code = 'S002'),
  'active',
  NOW()
);

-- LINE 暱稱 ↔ 會員（讓 LINE 貼單解析能找到）
INSERT INTO customer_line_aliases (tenant_id, channel_id, nickname, member_id)
SELECT :'tenant_id'::uuid,
       (SELECT id FROM line_channels WHERE tenant_id = :'tenant_id'::uuid AND code = 'LC-MAIN'),
       n.nickname,
       (SELECT id FROM members WHERE tenant_id = :'tenant_id'::uuid AND member_no = n.member_no)
FROM (VALUES
  ('小明', 'M-TEST-001'),
  ('小華', 'M-TEST-002')
) AS n(nickname, member_no);

-- member_points_balance 初始化
INSERT INTO member_points_balance (tenant_id, member_id, balance)
SELECT tenant_id, id, 0 FROM members WHERE tenant_id = :'tenant_id'::uuid;

INSERT INTO wallet_balances (tenant_id, member_id, balance)
SELECT tenant_id, id, 0 FROM members WHERE tenant_id = :'tenant_id'::uuid;

COMMIT;

\echo 'base fixtures seeded.'
