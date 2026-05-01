-- Fix: rpc_upsert_push_subscription 支援由 Edge Function 傳入 member_id
-- 因為使用 service_role 呼叫時，auth.jwt() 會抓不到資料

CREATE OR REPLACE FUNCTION rpc_upsert_push_subscription(
  p_endpoint   TEXT,
  p_p256dh     TEXT,
  p_auth       TEXT,
  p_user_agent TEXT DEFAULT NULL,
  p_member_id  BIGINT DEFAULT NULL,  -- 新增可選參數
  p_tenant_id  UUID DEFAULT NULL    -- 新增可選參數
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
    RAISE EXCEPTION 'missing tenant_id or member_id (v_tenant=%, v_member_id=%)', v_tenant, v_member_id;
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
