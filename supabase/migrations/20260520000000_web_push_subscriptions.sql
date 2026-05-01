-- ============================================================================
-- Web Push 訂閱表
-- 儲存 PWA 使用者的 Push Subscription
-- ============================================================================

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       UUID    NOT NULL,
  member_id       BIGINT  NOT NULL REFERENCES members(id),
  endpoint        TEXT    NOT NULL,
  p256dh          TEXT    NOT NULL,
  auth            TEXT    NOT NULL,
  user_agent      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (tenant_id, endpoint)
);

CREATE INDEX IF NOT EXISTS idx_push_subs_member ON push_subscriptions (tenant_id, member_id);

COMMENT ON TABLE  push_subscriptions IS 'Web Push 訂閱資料';
COMMENT ON COLUMN push_subscriptions.endpoint IS 'Push Service 的 URL';
COMMENT ON COLUMN push_subscriptions.p256dh   IS '瀏覽器生成的公鑰';
COMMENT ON COLUMN push_subscriptions.auth     IS '瀏覽器生成的 Auth Secret';

-- ── 2. RLS ─────────────────────────────────────────────────────────────────
ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;

-- 顧客只能管理自己的訂閱
CREATE POLICY push_subs_self_all ON push_subscriptions
  FOR ALL USING (
    tenant_id = (auth.jwt() ->> 'tenant_id')::UUID
    AND member_id = (auth.jwt() ->> 'member_id')::BIGINT
  );

-- HQ 全權
CREATE POLICY push_subs_hq_all ON push_subscriptions
  FOR ALL USING (
    tenant_id = (auth.jwt() ->> 'tenant_id')::UUID
    AND (auth.jwt() ->> 'role') = 'hq'
  );

-- ── 3. RPC：upsert_push_subscription ──────────────────────────────────────
CREATE OR REPLACE FUNCTION rpc_upsert_push_subscription(
  p_endpoint   TEXT,
  p_p256dh     TEXT,
  p_auth       TEXT,
  p_user_agent TEXT DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant    UUID   := (auth.jwt() ->> 'tenant_id')::UUID;
  v_member_id BIGINT := (auth.jwt() ->> 'member_id')::BIGINT;
BEGIN
  IF v_tenant IS NULL OR v_member_id IS NULL THEN
    RAISE EXCEPTION 'missing tenant_id or member_id in jwt';
  END IF;

  INSERT INTO push_subscriptions (
    tenant_id, member_id, endpoint, p256dh, auth, user_agent
  ) VALUES (
    v_tenant, v_member_id, p_endpoint, p_p256dh, p_auth, p_user_agent
  )
  ON CONFLICT (tenant_id, endpoint) DO UPDATE
  SET updated_at = NOW(),
      member_id = EXCLUDED.member_id,
      p256dh = EXCLUDED.p256dh,
      auth = EXCLUDED.auth,
      user_agent = EXCLUDED.user_agent;
END;
$$;

GRANT EXECUTE ON FUNCTION rpc_upsert_push_subscription(TEXT, TEXT, TEXT, TEXT) TO authenticated;
