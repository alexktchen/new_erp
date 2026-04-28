-- rpc_outbound：「Insufficient stock」exception 加上 SKU 識別資訊
--
-- 原本只回 available=X required=Y，前端拿到不知道是哪一個 SKU。
-- 改成：'Insufficient stock for SKU <sku_code> (<product_name>): available=X, required=Y'
--
-- 對應前端 lib/rpcError.ts 的 mapping 同步更新。

CREATE OR REPLACE FUNCTION rpc_outbound(
  p_tenant_id       UUID,
  p_location_id     BIGINT,
  p_sku_id          BIGINT,
  p_quantity        NUMERIC,
  p_movement_type   TEXT,
  p_source_doc_type TEXT,
  p_source_doc_id   BIGINT,
  p_operator        UUID,
  p_allow_negative  BOOLEAN DEFAULT FALSE
) RETURNS BIGINT AS $$
DECLARE
  v_available NUMERIC;
  v_cost      NUMERIC;
  v_id        BIGINT;
  v_sku_code  TEXT;
  v_sku_name  TEXT;
BEGIN
  IF p_quantity <= 0 THEN
    RAISE EXCEPTION 'Outbound quantity must be positive';
  END IF;

  SELECT on_hand - reserved, avg_cost
    INTO v_available, v_cost
    FROM stock_balances
   WHERE tenant_id = p_tenant_id
     AND location_id = p_location_id
     AND sku_id = p_sku_id
   FOR UPDATE;

  IF NOT FOUND THEN
    v_available := 0;
    v_cost := 0;
  END IF;

  IF v_available < p_quantity AND NOT p_allow_negative THEN
    SELECT s.sku_code, COALESCE(s.product_name, '')
      INTO v_sku_code, v_sku_name
      FROM skus s
     WHERE s.id = p_sku_id;

    RAISE EXCEPTION 'Insufficient stock for SKU % (%): available=%, required=%',
      COALESCE(v_sku_code, p_sku_id::TEXT),
      COALESCE(v_sku_name, ''),
      v_available,
      p_quantity;
  END IF;

  INSERT INTO stock_movements
    (tenant_id, location_id, sku_id, quantity, unit_cost, movement_type,
     source_doc_type, source_doc_id, operator_id)
  VALUES
    (p_tenant_id, p_location_id, p_sku_id, -p_quantity, v_cost, p_movement_type,
     p_source_doc_type, p_source_doc_id, p_operator)
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
