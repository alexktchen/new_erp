-- ============================================================
-- 社群商品候選池
-- BRIEF: docs/BRIEF-社群商品候選池與商品行事曆.md
-- 流程: LINE 群組 #選品 → 機器人(NAS) → Apps Script Web App
--       → 1) 寫 Google Sheet (現況)
--          2) 轉發 POST 給 community-bot-ingest Edge Function (新增)
--       → community_product_candidates 表
--       → admin 候選池清單 / 週曆 / 今日待確認
--       → 老闆採用 → 建 product+sku+price → campaign_from_products RPC 開團
-- ============================================================

CREATE TABLE community_product_candidates (
  id                 BIGSERIAL PRIMARY KEY,
  tenant_id          UUID NOT NULL,

  -- 來源 (機器人 → Apps Script payload)
  source_channel     TEXT,                -- 之後可填 LINE 群組名/id (現況沒抓)
  source_post_url    TEXT,                -- 之後可填 LINE 訊息 deep link (現況沒抓)
  source_user_id     TEXT,                -- Apps Script payload.userId
  source_user_name   TEXT,                -- 之後可填 LINE display name (現況沒抓)
  source_external_id TEXT,                -- 防重 dedup key (建議: LINE message_id; 機器人沒填則 NULL = 不防重)
  product_name_hint  TEXT,                -- Apps Script payload.productName: 機器人猜的商品名 (Sheet B 欄)
  raw_text           TEXT NOT NULL,       -- Apps Script payload.text: LINE 文案原文
  raw                JSONB NOT NULL DEFAULT '{}'::jsonb,  -- 完整 payload 留底 (彈性欄位)
  parsed             JSONB,               -- 之後 AI 解析填 (issue #102 預留)
  parsed_at          TIMESTAMPTZ,

  -- 雙軸狀態 (BRIEF §7 Q1)
  system_status      TEXT NOT NULL DEFAULT 'new'
                       CHECK (system_status IN (
                         'new','duplicate_hint','insufficient_data','archived_by_age'
                       )),
  owner_action       TEXT NOT NULL DEFAULT 'none'
                       CHECK (owner_action IN (
                         'none','collected','scheduled','adopted','ignored'
                       )),

  -- 排程 (BRIEF §7 Q3 - 行事曆排程)
  scheduled_open_at  DATE,                -- 預計開團日 (NULL = 未排程)
  scheduled_by       UUID,
  scheduled_at       TIMESTAMPTZ,

  -- 採用後關聯
  adopted_product_id BIGINT REFERENCES products(id),
  adopted_at         TIMESTAMPTZ,
  adopted_by         UUID,

  -- 重複偵測 (BRIEF §7 Q4 - 系統提示、不自動合併)
  similar_product_id BIGINT REFERENCES products(id),
  similarity_score   NUMERIC(4,3) CHECK (
                       similarity_score IS NULL
                       OR (similarity_score >= 0 AND similarity_score <= 1)
                     ),

  -- 稽核四欄位 (new_erp 慣例)
  created_by         UUID,
  updated_by         UUID,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE community_product_candidates IS
  '(2026-04-30) 社群商品候選池：LINE 群組 #選品 → Apps Script Web App → 此表 → 老闆挑選 → 採用建商品 → 開團';

COMMENT ON COLUMN community_product_candidates.system_status IS
  'new=新抓到 / duplicate_hint=系統提示重複 / insufficient_data=資料不足 / archived_by_age=超過 30 天 cron 自動 archive';

COMMENT ON COLUMN community_product_candidates.owner_action IS
  'none=未動 / collected=老闆收藏(沒日期) / scheduled=已排到週曆 / adopted=已採用建商品 / ignored=老闆忽略';

COMMENT ON COLUMN community_product_candidates.scheduled_open_at IS
  'BRIEF §7 Q3: 老闆在週曆拖排的「預計開團日」(DATE only)；UPDATE 此欄即拖排操作';

COMMENT ON COLUMN community_product_candidates.adopted_product_id IS
  'BRIEF §3: 採用 = 接到既有商品(老闆選 70% 相似的) 或 建新商品(走 rpc_next_product_code)';

COMMENT ON COLUMN community_product_candidates.product_name_hint IS
  'Apps Script payload.productName (機器人猜的、可能很爛如「好鄰居敲碗回歸」)；給老闆 quick label 用、不寫進正式商品名';

-- ============================================================
-- 索引
-- ============================================================

-- 候選池清單預設「最近 7 天」
CREATE INDEX idx_ccp_recent
  ON community_product_candidates (tenant_id, created_at DESC);

-- 週曆查詢 (BRIEF §7 Q3 partial index)
CREATE INDEX idx_ccp_scheduled
  ON community_product_candidates (tenant_id, scheduled_open_at)
  WHERE scheduled_open_at IS NOT NULL;

-- 老闆動作篩選 (collected / scheduled / ignored)
CREATE INDEX idx_ccp_owner_action
  ON community_product_candidates (tenant_id, owner_action);

-- 系統狀態篩選 (duplicate_hint / archived_by_age)
CREATE INDEX idx_ccp_system_status
  ON community_product_candidates (tenant_id, system_status);

-- 重複偵測查詢 (similar_product_id 不為 NULL 才需要)
CREATE INDEX idx_ccp_similar
  ON community_product_candidates (tenant_id, similar_product_id)
  WHERE similar_product_id IS NOT NULL;

-- 防重: 同一 LINE message 多次 retry 不會重複寫入
-- (partial index: 機器人沒填 source_external_id 時 NULL、不參加 dedup)
CREATE UNIQUE INDEX idx_ccp_source_external
  ON community_product_candidates (tenant_id, source_external_id)
  WHERE source_external_id IS NOT NULL;

-- ============================================================
-- updated_at 自動更新 (沿用 product 模組的 touch_updated_at)
-- ============================================================
CREATE TRIGGER trg_touch_community_product_candidates
  BEFORE UPDATE ON community_product_candidates
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ============================================================
-- RLS (依 docs/decisions/2026-04-23-系統立場-混合型.md)
-- 候選池只給 admin / assistant 看 (BRIEF Q3 拍板)
-- 機器人寫入走 Edge Function service_role 繞過 RLS
-- 沿用 purchase_rls_admin / fix_purchase_rls_role_path 慣例
--   - tenant_id 比對 auth.jwt() ->> 'tenant_id'
--   - role 從 app_metadata 讀 (不是 supabase 內建的 PG role)
--   - 空字串也允許 (沒設業務 role 的 admin 帳號預設能用)
-- ============================================================

ALTER TABLE community_product_candidates ENABLE ROW LEVEL SECURITY;

-- 單一 policy: admin/assistant 可讀寫 (FOR ALL 涵蓋 SELECT/INSERT/UPDATE/DELETE)
-- 機器人 INSERT 走 Edge Function service_role 繞過 RLS (不適用此 policy)
-- 明寫 WITH CHECK (跟 USING 同條件): admin 不能 INSERT/UPDATE 到別 tenant 或變造 role
CREATE POLICY ccp_hq_all
  ON community_product_candidates
  FOR ALL
  USING (
    tenant_id = (auth.jwt() ->> 'tenant_id')::uuid
    AND COALESCE(auth.jwt() -> 'app_metadata' ->> 'role', '')
        = ANY (ARRAY['owner','admin','hq_manager','assistant',''])
  )
  WITH CHECK (
    tenant_id = (auth.jwt() ->> 'tenant_id')::uuid
    AND COALESCE(auth.jwt() -> 'app_metadata' ->> 'role', '')
        = ANY (ARRAY['owner','admin','hq_manager','assistant',''])
  );
