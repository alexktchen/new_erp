-- ============================================================
-- Adopt a community product candidate: create product + sku + retail price (optional)
-- Sets community_product_candidates.owner_action = 'adopted'
--
-- Scope: adds this function only, no changes to existing tables/columns/policies/triggers
-- Rollback: DROP FUNCTION IF EXISTS public.rpc_adopt_candidate(BIGINT, TEXT, NUMERIC);
-- ============================================================

CREATE OR REPLACE FUNCTION public.rpc_adopt_candidate(
  p_candidate_id  BIGINT,
  p_product_name  TEXT,
  p_retail_price  NUMERIC DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant        UUID   := public._current_tenant_id();
  v_user          UUID   := auth.uid();
  v_cand          RECORD;
  v_product_code  TEXT;
  v_product_id    BIGINT;
  v_sku_code      TEXT;
  v_sku_id        BIGINT;
  v_ret_code      TEXT;
  v_ret_sku_id    BIGINT;
BEGIN
  -- 1. role check
  IF COALESCE(auth.jwt() -> 'app_metadata' ->> 'role', '')
     NOT IN ('owner', 'admin', 'hq_manager', 'assistant') THEN
    RAISE EXCEPTION 'permission denied: role % cannot adopt candidate',
      COALESCE(auth.jwt() -> 'app_metadata' ->> 'role', '(empty)');
  END IF;

  -- 2. input validation
  IF TRIM(COALESCE(p_product_name, '')) = '' THEN
    RAISE EXCEPTION 'product_name must not be blank';
  END IF;

  IF p_retail_price IS NOT NULL AND p_retail_price < 0 THEN
    RAISE EXCEPTION 'retail_price must be >= 0, got %', p_retail_price;
  END IF;

  -- 3. lock candidate row to prevent concurrent double-adopt
  SELECT id, owner_action, adopted_product_id, raw_text
    INTO v_cand
    FROM community_product_candidates
   WHERE id        = p_candidate_id
     AND tenant_id = v_tenant
     FOR UPDATE;

  IF v_cand.id IS NULL THEN
    RAISE EXCEPTION 'candidate % not found or cross-tenant', p_candidate_id;
  END IF;

  -- 4. already adopted but adopted_product_id is NULL = data integrity issue, refuse
  IF v_cand.owner_action = 'adopted' AND v_cand.adopted_product_id IS NULL THEN
    RAISE EXCEPTION 'candidate % already adopted but adopted_product_id is null',
      p_candidate_id;
  END IF;

  -- 5. idempotent: already adopted normally, return existing product info
  IF v_cand.owner_action = 'adopted' THEN
    SELECT product_code
      INTO v_ret_code
      FROM products
     WHERE id        = v_cand.adopted_product_id
       AND tenant_id = v_tenant;

    SELECT id
      INTO v_ret_sku_id
      FROM skus
     WHERE product_id = v_cand.adopted_product_id
       AND tenant_id  = v_tenant
     ORDER BY id
     LIMIT 1;

    RETURN jsonb_build_object(
      'product_id',      v_cand.adopted_product_id,
      'product_code',    v_ret_code,
      'sku_id',          v_ret_sku_id,
      'already_adopted', TRUE
    );
  END IF;

  -- 6. generate product code and create product
  -- Note: rpc_next_product_code uses MAX+1; concurrent calls may collide,
  -- but products has UNIQUE(tenant_id, product_code) so a collision causes
  -- unique_violation -> full transaction rollback -> no partial data; caller may retry.
  v_product_code := public.rpc_next_product_code();

  v_product_id := public.rpc_upsert_product(
    p_id               := NULL,
    p_product_code     := v_product_code,
    p_name             := TRIM(p_product_name),
    p_short_name       := NULL,
    p_brand_id         := NULL,
    p_category_id      := NULL,
    p_description      := v_cand.raw_text,
    p_status           := 'active',
    p_reason           := 'adopt candidate #' || p_candidate_id::TEXT
  );

  -- 7. generate sku code and create sku (rpc_upsert_sku auto-creates sku_pack)
  -- rpc_next_sku_code requires product_id, so this must come after step 6
  v_sku_code := public.rpc_next_sku_code(v_product_id);

  v_sku_id := public.rpc_upsert_sku(
    p_id           := NULL,
    p_product_id   := v_product_id,
    p_sku_code     := v_sku_code,
    p_variant_name := NULL,
    p_spec         := '{}'::jsonb,
    p_base_unit    := NULL,
    p_weight_g     := NULL,
    p_tax_rate     := NULL,
    p_status       := 'active',
    p_reason       := 'adopt candidate #' || p_candidate_id::TEXT
  );

  -- 8. set retail price (optional), using wrapper to avoid passing tenant/operator manually
  IF p_retail_price IS NOT NULL THEN
    PERFORM public.rpc_set_retail_price(
      v_sku_id,
      p_retail_price,
      NOW(),
      'adopt candidate #' || p_candidate_id::TEXT
    );
  END IF;

  -- 9. mark candidate as adopted
  UPDATE community_product_candidates
     SET owner_action       = 'adopted',
         adopted_product_id = v_product_id,
         adopted_at         = NOW(),
         adopted_by         = v_user,
         updated_at         = NOW()
   WHERE id        = p_candidate_id
     AND tenant_id = v_tenant;

  RETURN jsonb_build_object(
    'product_id',      v_product_id,
    'product_code',    v_product_code,
    'sku_id',          v_sku_id,
    'already_adopted', FALSE
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.rpc_adopt_candidate(BIGINT, TEXT, NUMERIC)
  TO authenticated;

COMMENT ON FUNCTION public.rpc_adopt_candidate(BIGINT, TEXT, NUMERIC)
  IS 'Adopt a community candidate: creates product (active) + sku (active) + optional retail price. Idempotent. Does not create campaigns or modify existing products.';
