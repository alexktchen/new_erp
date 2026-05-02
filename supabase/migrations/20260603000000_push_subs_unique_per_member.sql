-- ============================================================
-- push_subscriptions:每位 member 只保留一筆訂閱
-- 原本 UNIQUE (tenant_id, endpoint) → 改 UNIQUE (tenant_id, member_id)
-- 同 member 換手機 / 重新 install PWA → 直接覆蓋舊 endpoint
-- ============================================================

-- Step 1: 清理重複(每個 (tenant_id, member_id) 只保留 id 最大那筆)
DELETE FROM push_subscriptions a
USING push_subscriptions b
WHERE a.tenant_id = b.tenant_id
  AND a.member_id = b.member_id
  AND a.id < b.id;

-- Step 2: 移除舊的 (tenant_id, endpoint) UNIQUE
ALTER TABLE push_subscriptions
  DROP CONSTRAINT IF EXISTS push_subscriptions_tenant_id_endpoint_key;

-- Step 3: 加上新的 (tenant_id, member_id) UNIQUE
ALTER TABLE push_subscriptions
  ADD CONSTRAINT push_subscriptions_tenant_member_unique
  UNIQUE (tenant_id, member_id);

-- Step 4: RPC 改用 (tenant_id, member_id) 為衝突鍵
-- 先 DROP 舊 function(remote 上 return type 可能跟我們 declare 的不同,
-- CREATE OR REPLACE 不能換 return type,得整個 drop 重建)
DROP FUNCTION IF EXISTS rpc_upsert_push_subscription(TEXT, TEXT, TEXT, TEXT, BIGINT, UUID);

CREATE OR REPLACE FUNCTION rpc_upsert_push_subscription(
  p_endpoint   TEXT,
  p_p256dh     TEXT,
  p_auth       TEXT,
  p_user_agent TEXT DEFAULT NULL,
  p_member_id  BIGINT DEFAULT NULL,
  p_tenant_id  UUID    DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant    UUID   := COALESCE(p_tenant_id, (auth.jwt() ->> 'tenant_id')::UUID);
  v_member_id BIGINT := COALESCE(p_member_id, (auth.jwt() ->> 'member_id')::BIGINT);
BEGIN
  IF v_tenant IS NULL OR v_member_id IS NULL THEN
    RAISE EXCEPTION 'missing tenant_id or member_id (v_tenant=%, v_member_id=%)',
                    v_tenant, v_member_id;
  END IF;

  INSERT INTO push_subscriptions (
    tenant_id, member_id, endpoint, p256dh, auth, user_agent
  ) VALUES (
    v_tenant, v_member_id, p_endpoint, p_p256dh, p_auth, p_user_agent
  )
  ON CONFLICT (tenant_id, member_id) DO UPDATE
  SET endpoint   = EXCLUDED.endpoint,
      p256dh     = EXCLUDED.p256dh,
      auth       = EXCLUDED.auth,
      user_agent = EXCLUDED.user_agent,
      updated_at = NOW();
END;
$$;

COMMENT ON CONSTRAINT push_subscriptions_tenant_member_unique ON push_subscriptions IS
  '每位 member 只保留一筆訂閱;換裝置 / 重新訂閱會覆蓋舊 endpoint';
