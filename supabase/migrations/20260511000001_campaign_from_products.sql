-- ============================================================
-- 從商品頁多選商品後一鍵開團
-- 1. rpc_next_campaign_no()  → 自動產生團號 GRP-YYYYMMDD-NNN
-- 2. rpc_create_campaign_from_products(...)
--      建立 group_buy_campaigns + 對應的 campaign_items
--      (抓所有 active SKU + 最新 retail 定價)
-- ============================================================

-- ────────────────────────────────────────
-- 1. 自動團號
-- ────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.rpc_next_campaign_no()
RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_tenant UUID  := public._current_tenant_id();
  v_prefix TEXT  := 'GRP-' || TO_CHAR(NOW() AT TIME ZONE 'Asia/Taipei', 'YYYYMMDD') || '-';
  v_next   INT;
BEGIN
  SELECT COALESCE(
    MAX(
      SUBSTRING(campaign_no FROM LENGTH(v_prefix) + 1)::INT
    ), 0
  ) + 1
    INTO v_next
    FROM group_buy_campaigns
   WHERE tenant_id   = v_tenant
     AND campaign_no LIKE v_prefix || '%'
     AND campaign_no ~ ('^' || v_prefix || '\d+$');

  RETURN v_prefix || LPAD(v_next::TEXT, 3, '0');
END;
$$;

GRANT EXECUTE ON FUNCTION public.rpc_next_campaign_no TO authenticated;
COMMENT ON FUNCTION public.rpc_next_campaign_no IS '自動產生當日流水團號 GRP-YYYYMMDD-NNN';

-- ────────────────────────────────────────
-- 2. 從商品多選建團
-- ────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.rpc_create_campaign_from_products(
  p_name           TEXT,
  p_end_at         TIMESTAMPTZ,
  p_pickup_deadline DATE,
  p_product_ids    BIGINT[]
) RETURNS BIGINT
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_tenant      UUID   := public._current_tenant_id();
  v_no          TEXT;
  v_campaign_id BIGINT;
  v_sort        INT    := 1;
  r             RECORD;
BEGIN
  -- 1. 產生團號
  v_no := public.rpc_next_campaign_no();

  -- 2. 建立活動（status=open，start_at=now）
  INSERT INTO group_buy_campaigns (
    tenant_id, campaign_no, name, status,
    start_at, end_at, pickup_deadline,
    created_by, updated_by
  ) VALUES (
    v_tenant, v_no, p_name, 'open',
    NOW(), p_end_at, p_pickup_deadline,
    auth.uid(), auth.uid()
  ) RETURNING id INTO v_campaign_id;

  -- 3. 對每個商品的每個 active SKU，抓最新 retail 定價後塞入 campaign_items
  FOR r IN
    SELECT
      s.id        AS sku_id,
      COALESCE(
        (SELECT p.price
           FROM prices p
          WHERE p.sku_id = s.id
            AND p.scope  = 'retail'
            AND p.tenant_id = v_tenant
          ORDER BY p.effective_from DESC NULLS LAST
          LIMIT 1),
        0
      ) AS unit_price
    FROM skus s
   WHERE s.product_id = ANY(p_product_ids)
     AND s.tenant_id  = v_tenant
     AND s.status     = 'active'
   ORDER BY s.product_id, s.id
  LOOP
    INSERT INTO campaign_items (
      tenant_id, campaign_id, sku_id, unit_price, sort_order,
      created_by, updated_by
    ) VALUES (
      v_tenant, v_campaign_id, r.sku_id, r.unit_price, v_sort,
      auth.uid(), auth.uid()
    )
    ON CONFLICT (campaign_id, sku_id) DO NOTHING;

    v_sort := v_sort + 1;
  END LOOP;

  RETURN v_campaign_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.rpc_create_campaign_from_products TO authenticated;
COMMENT ON FUNCTION public.rpc_create_campaign_from_products IS
  '從選定商品建立開團：自動產生團號、塞入所有 active SKU（帶最新 retail 定價）';
