-- ============================================================
-- rpc_ship_aid_order：派貨 RPC（confirmed → shipping）
--
-- 從 customer_orders.transferred_from_order_id 找 source 店，
-- 依 is_air_transfer 建 transfer chain：
--
--   空中轉（is_air_transfer=true）：
--     Leg-1 (source 店 → dest 店, status=shipped, customer_order_id=本單)
--     source 店即時 outbound
--
--   經總倉（is_air_transfer=false）：
--     Leg-1 (source 店 → HQ, status=shipped, customer_order_id=NULL,
--            next_transfer_id=Leg-2)
--       source 店即時 outbound
--     Leg-2 (HQ → dest 店, status=draft, customer_order_id=本單,
--            next_transfer_id=NULL)
--       transfer_items 已建立但 outbound 等 Leg-1 receive 觸發
--
-- 任一步失敗 → 整 transaction rollback。
-- ============================================================

CREATE OR REPLACE FUNCTION rpc_ship_aid_order(
  p_order_id BIGINT,
  p_operator UUID
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_order        customer_orders%ROWTYPE;
  v_src_order    customer_orders%ROWTYPE;
  v_src_store_id BIGINT;
  v_src_location BIGINT;
  v_dst_location BIGINT;
  v_hq_location  BIGINT;
  v_leg1_id      BIGINT;
  v_leg2_id      BIGINT;
  v_leg1_no      TEXT;
  v_leg2_no      TEXT;
  v_item         RECORD;
  v_mov_id       BIGINT;
  v_items_count  INTEGER := 0;
  v_total_qty    NUMERIC := 0;
  v_epoch        BIGINT;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('aid_order:' || p_order_id));

  SELECT * INTO v_order FROM customer_orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'order % not found', p_order_id;
  END IF;
  IF v_order.status <> 'confirmed' THEN
    RAISE EXCEPTION 'aid order % is %, only confirmed can ship', p_order_id, v_order.status;
  END IF;

  IF v_order.transferred_from_order_id IS NULL THEN
    RAISE EXCEPTION 'aid order % has no transferred_from_order_id', p_order_id;
  END IF;

  SELECT * INTO v_src_order
    FROM customer_orders
   WHERE id = v_order.transferred_from_order_id;
  IF NOT FOUND OR v_src_order.pickup_store_id IS NULL THEN
    RAISE EXCEPTION 'source order % has no pickup_store', v_order.transferred_from_order_id;
  END IF;
  v_src_store_id := v_src_order.pickup_store_id;

  SELECT location_id INTO v_src_location
    FROM stores WHERE id = v_src_store_id;
  IF v_src_location IS NULL THEN
    RAISE EXCEPTION 'store % has no location_id', v_src_store_id;
  END IF;

  SELECT location_id INTO v_dst_location
    FROM stores WHERE id = v_order.pickup_store_id;
  IF v_dst_location IS NULL THEN
    RAISE EXCEPTION 'store % has no location_id', v_order.pickup_store_id;
  END IF;

  IF v_src_location = v_dst_location THEN
    RAISE EXCEPTION 'source and dest store share location_id %, cannot ship', v_src_location;
  END IF;

  -- 經總倉才需要 HQ
  IF NOT COALESCE(v_order.is_air_transfer, FALSE) THEN
    SELECT id INTO v_hq_location
      FROM locations
     WHERE tenant_id = v_order.tenant_id
       AND type = 'central_warehouse'
       AND is_active
     ORDER BY id
     LIMIT 1;
    IF v_hq_location IS NULL THEN
      RAISE EXCEPTION 'no central warehouse location for tenant';
    END IF;
  END IF;

  v_epoch := EXTRACT(EPOCH FROM NOW())::BIGINT;

  -- 收 aid items 預檢
  IF NOT EXISTS (
    SELECT 1 FROM customer_order_items
     WHERE order_id = p_order_id AND source = 'aid_transfer'
  ) THEN
    RAISE EXCEPTION 'order % has no aid_transfer items', p_order_id;
  END IF;

  IF COALESCE(v_order.is_air_transfer, FALSE) THEN
    -- ========== 空中轉：1 段 ==========
    v_leg1_no := 'AT-O' || p_order_id || '-' || v_epoch;

    INSERT INTO transfers (
      tenant_id, transfer_no, source_location, dest_location,
      status, transfer_type, customer_order_id, next_transfer_id,
      requested_by, shipped_by, shipped_at, created_by, updated_by
    ) VALUES (
      v_order.tenant_id, v_leg1_no, v_src_location, v_dst_location,
      'shipped', 'store_to_store', p_order_id, NULL,
      p_operator, p_operator, NOW(), p_operator, p_operator
    ) RETURNING id INTO v_leg1_id;

    FOR v_item IN
      SELECT sku_id, qty FROM customer_order_items
       WHERE order_id = p_order_id AND source = 'aid_transfer'
    LOOP
      v_mov_id := rpc_outbound(
        p_tenant_id       => v_order.tenant_id,
        p_location_id     => v_src_location,
        p_sku_id          => v_item.sku_id,
        p_quantity        => v_item.qty,
        p_movement_type   => 'transfer_out',
        p_source_doc_type => 'transfer',
        p_source_doc_id   => v_leg1_id,
        p_operator        => p_operator
      );
      INSERT INTO transfer_items (
        transfer_id, sku_id, qty_requested, qty_shipped,
        out_movement_id, created_by, updated_by
      ) VALUES (
        v_leg1_id, v_item.sku_id, v_item.qty, v_item.qty,
        v_mov_id, p_operator, p_operator
      );
      v_items_count := v_items_count + 1;
      v_total_qty := v_total_qty + v_item.qty;
    END LOOP;

    UPDATE customer_orders
       SET status = 'shipping',
           shipping_at = NOW(),
           updated_by = p_operator,
           updated_at = NOW()
     WHERE id = p_order_id;

    RETURN jsonb_build_object(
      'order_id', p_order_id,
      'is_air_transfer', TRUE,
      'transfer_ids', jsonb_build_array(v_leg1_id),
      'items_count', v_items_count,
      'total_qty', v_total_qty
    );
  ELSE
    -- ========== 經總倉：2 段 ==========
    v_leg1_no := 'AT-O' || p_order_id || '-L1-' || v_epoch;
    v_leg2_no := 'AT-O' || p_order_id || '-L2-' || v_epoch;

    -- Leg-2：先建（draft），拿 id
    INSERT INTO transfers (
      tenant_id, transfer_no, source_location, dest_location,
      status, transfer_type, customer_order_id, next_transfer_id,
      requested_by, created_by, updated_by
    ) VALUES (
      v_order.tenant_id, v_leg2_no, v_hq_location, v_dst_location,
      'draft', 'hq_to_store', p_order_id, NULL,
      p_operator, p_operator, p_operator
    ) RETURNING id INTO v_leg2_id;

    FOR v_item IN
      SELECT sku_id, qty FROM customer_order_items
       WHERE order_id = p_order_id AND source = 'aid_transfer'
    LOOP
      INSERT INTO transfer_items (
        transfer_id, sku_id, qty_requested, qty_shipped,
        created_by, updated_by
      ) VALUES (
        v_leg2_id, v_item.sku_id, v_item.qty, 0,
        p_operator, p_operator
      );
    END LOOP;

    -- Leg-1：source → HQ，立刻 ship + outbound source
    INSERT INTO transfers (
      tenant_id, transfer_no, source_location, dest_location,
      status, transfer_type, customer_order_id, next_transfer_id,
      requested_by, shipped_by, shipped_at, created_by, updated_by
    ) VALUES (
      v_order.tenant_id, v_leg1_no, v_src_location, v_hq_location,
      'shipped', 'store_to_store', NULL, v_leg2_id,
      p_operator, p_operator, NOW(), p_operator, p_operator
    ) RETURNING id INTO v_leg1_id;

    FOR v_item IN
      SELECT sku_id, qty FROM customer_order_items
       WHERE order_id = p_order_id AND source = 'aid_transfer'
    LOOP
      v_mov_id := rpc_outbound(
        p_tenant_id       => v_order.tenant_id,
        p_location_id     => v_src_location,
        p_sku_id          => v_item.sku_id,
        p_quantity        => v_item.qty,
        p_movement_type   => 'transfer_out',
        p_source_doc_type => 'transfer',
        p_source_doc_id   => v_leg1_id,
        p_operator        => p_operator
      );
      INSERT INTO transfer_items (
        transfer_id, sku_id, qty_requested, qty_shipped,
        out_movement_id, created_by, updated_by
      ) VALUES (
        v_leg1_id, v_item.sku_id, v_item.qty, v_item.qty,
        v_mov_id, p_operator, p_operator
      );
      v_items_count := v_items_count + 1;
      v_total_qty := v_total_qty + v_item.qty;
    END LOOP;

    UPDATE customer_orders
       SET status = 'shipping',
           shipping_at = NOW(),
           updated_by = p_operator,
           updated_at = NOW()
     WHERE id = p_order_id;

    RETURN jsonb_build_object(
      'order_id', p_order_id,
      'is_air_transfer', FALSE,
      'transfer_ids', jsonb_build_array(v_leg1_id, v_leg2_id),
      'items_count', v_items_count,
      'total_qty', v_total_qty
    );
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION rpc_ship_aid_order(BIGINT, UUID) TO authenticated;

COMMENT ON FUNCTION rpc_ship_aid_order IS
  'Aid order 派貨：confirmed → shipping，建 transfer chain（空中轉 1 段 / 經總倉 2 段），source 店即時 outbound。';
