-- rpc_receive_transfer：店家收貨同步推進 aid customer_orders → ready
--
-- 背景：
--   原本 customer_orders 的 shipping → ready 是「總倉檢視（/transfers/aid）」端
--   手動點擊 rpc_advance_order_status 推進，跟店家收貨完全脫鉤。
--
-- 改變：
--   收貨 RPC 在原邏輯（transfers.shipped→received + stock_in）之後，
--   找到 dest_location 對應的 store，把該 store 所有：
--     - status='shipping'
--     - 至少一個 customer_order_items.source='aid_transfer'
--     - 且該 item 的 sku_id 是這次 transfer 涵蓋的
--   的 customer_orders 推到 'ready'。
--
-- 涵蓋兩種 transfer_type：'hq_to_store'（經總倉）+ 'store_to_store'（空中轉）。
-- 用 dest_location → stores.location_id 反查 store；非 store-bound 的 transfer
-- （例如 return_to_hq）找不到 store 就跳過 aid 推進。

CREATE OR REPLACE FUNCTION rpc_receive_transfer(
  p_transfer_id BIGINT,
  p_lines       JSONB,
  p_operator    UUID,
  p_notes       TEXT DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE
  v_tenant_id            UUID;
  v_status               TEXT;
  v_dest_location        BIGINT;
  v_dest_store_id        BIGINT;
  v_existing_notes       TEXT;
  v_item                 RECORD;
  v_qty_received         NUMERIC;
  v_unit_cost            NUMERIC;
  v_in_mov_id            BIGINT;
  v_total_qty            NUMERIC := 0;
  v_total_variance       NUMERIC := 0;
  v_items_received       INTEGER := 0;
  v_lines_consumed       INTEGER := 0;
  v_lines_count          INTEGER;
  v_aid_orders_advanced  INTEGER := 0;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('transfer:' || p_transfer_id));

  SELECT tenant_id, status, dest_location, notes
    INTO v_tenant_id, v_status, v_dest_location, v_existing_notes
    FROM transfers
   WHERE id = p_transfer_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'transfer % not found', p_transfer_id;
  END IF;

  IF v_status <> 'shipped' THEN
    RAISE EXCEPTION 'transfer % is in status %, expected shipped', p_transfer_id, v_status;
  END IF;

  IF p_lines IS NOT NULL THEN
    v_lines_count := jsonb_array_length(p_lines);

    IF EXISTS (
      SELECT 1
        FROM jsonb_array_elements(p_lines) AS l
        LEFT JOIN transfer_items ti
          ON ti.id = (l->>'transfer_item_id')::BIGINT
         AND ti.transfer_id = p_transfer_id
       WHERE ti.id IS NULL
    ) THEN
      RAISE EXCEPTION 'p_lines contains transfer_item_id not belonging to transfer %', p_transfer_id;
    END IF;
  END IF;

  FOR v_item IN
    SELECT ti.id, ti.sku_id, ti.qty_shipped, sm.unit_cost AS out_cost
      FROM transfer_items ti
      LEFT JOIN stock_movements sm ON sm.id = ti.out_movement_id
     WHERE ti.transfer_id = p_transfer_id
     ORDER BY ti.id
  LOOP
    v_qty_received := v_item.qty_shipped;

    IF p_lines IS NOT NULL THEN
      SELECT (l->>'qty_received')::NUMERIC
        INTO v_qty_received
        FROM jsonb_array_elements(p_lines) AS l
       WHERE (l->>'transfer_item_id')::BIGINT = v_item.id
       LIMIT 1;

      IF FOUND THEN
        v_lines_consumed := v_lines_consumed + 1;
      ELSE
        v_qty_received := v_item.qty_shipped;
      END IF;
    END IF;

    IF v_qty_received IS NULL OR v_qty_received < 0 THEN
      RAISE EXCEPTION 'transfer_item % qty_received must be >= 0, got %', v_item.id, v_qty_received;
    END IF;
    IF v_qty_received > v_item.qty_shipped THEN
      RAISE EXCEPTION 'transfer_item % over-receipt: qty_received=% > qty_shipped=%',
        v_item.id, v_qty_received, v_item.qty_shipped;
    END IF;

    IF v_qty_received > 0 THEN
      v_unit_cost := COALESCE(ABS(v_item.out_cost), 0);

      v_in_mov_id := rpc_inbound(
        p_tenant_id       => v_tenant_id,
        p_location_id     => v_dest_location,
        p_sku_id          => v_item.sku_id,
        p_quantity        => v_qty_received,
        p_unit_cost       => v_unit_cost,
        p_movement_type   => 'transfer_in',
        p_source_doc_type => 'transfer',
        p_source_doc_id   => p_transfer_id,
        p_operator        => p_operator
      );

      UPDATE transfer_items
         SET qty_received   = v_qty_received,
             in_movement_id = v_in_mov_id,
             updated_by     = p_operator
       WHERE id = v_item.id;
    ELSE
      UPDATE transfer_items
         SET qty_received = 0,
             updated_by   = p_operator
       WHERE id = v_item.id;
    END IF;

    v_total_qty      := v_total_qty + v_qty_received;
    v_total_variance := v_total_variance + (v_qty_received - v_item.qty_shipped);
    v_items_received := v_items_received + 1;
  END LOOP;

  UPDATE transfers
     SET status      = 'received',
         received_by = p_operator,
         received_at = NOW(),
         notes       = CASE
                         WHEN p_notes IS NULL OR p_notes = '' THEN v_existing_notes
                         WHEN v_existing_notes IS NULL OR v_existing_notes = '' THEN p_notes
                         ELSE v_existing_notes || E'\n' || p_notes
                       END,
         updated_by  = p_operator
   WHERE id = p_transfer_id;

  -- 推進 aid customer_orders → ready
  --   1. 找 dest_location 對應的 store（非 store-bound 的 transfer 跳過）
  --   2. 該 store 所有 status='shipping' + 含 aid_transfer items 且 SKU
  --      被本 transfer 涵蓋的 customer_orders 推到 'ready'
  SELECT id INTO v_dest_store_id
    FROM stores
   WHERE tenant_id = v_tenant_id
     AND location_id = v_dest_location
   LIMIT 1;

  IF v_dest_store_id IS NOT NULL THEN
    WITH advanced AS (
      UPDATE customer_orders co
         SET status     = 'ready',
             updated_by = p_operator,
             updated_at = NOW()
       WHERE co.tenant_id = v_tenant_id
         AND co.pickup_store_id = v_dest_store_id
         AND co.status = 'shipping'
         AND EXISTS (
           SELECT 1
             FROM customer_order_items coi
            WHERE coi.order_id = co.id
              AND coi.source = 'aid_transfer'
              AND coi.sku_id IN (
                SELECT sku_id FROM transfer_items WHERE transfer_id = p_transfer_id
              )
         )
      RETURNING co.id
    )
    SELECT COUNT(*) INTO v_aid_orders_advanced FROM advanced;
  END IF;

  RETURN jsonb_build_object(
    'transfer_id',          p_transfer_id,
    'items_received',       v_items_received,
    'total_qty_received',   v_total_qty,
    'total_variance',       v_total_variance,
    'aid_orders_advanced',  v_aid_orders_advanced
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION rpc_receive_transfer(BIGINT, JSONB, UUID, TEXT) TO authenticated;
