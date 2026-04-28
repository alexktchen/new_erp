-- ============================================================
-- 修 generate_transfer_from_wave：
-- 1. 出倉前若有 picked_qty IS NULL，自動補成 qty（防禦性修補）
-- 2. 若所有品項 picked_qty = 0，給明確中文錯誤
-- 3. 所有英文 RAISE EXCEPTION 換成中文
-- ============================================================

CREATE OR REPLACE FUNCTION generate_transfer_from_wave(
  p_wave_id        BIGINT,
  p_hq_location_id BIGINT,
  p_operator       UUID
) RETURNS JSONB AS $$
DECLARE
  v_tenant_id            UUID;
  v_wave_status          TEXT;
  v_expected_store_count INTEGER;
  v_expected_item_count  INTEGER;
  v_actual_xfer_count    INTEGER;
  v_store_rec            RECORD;
  v_dest_location_id     BIGINT;
  v_new_xfer_id          BIGINT;
  v_inserted_items       INTEGER;
  v_xfer_ids             BIGINT[] := ARRAY[]::BIGINT[];
  v_pwi                  RECORD;
  v_out_mov_id           BIGINT;
BEGIN
  PERFORM pg_advisory_xact_lock(p_wave_id);

  SELECT tenant_id, status INTO v_tenant_id, v_wave_status
    FROM picking_waves WHERE id = p_wave_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION '找不到撿貨單 %', p_wave_id;
  END IF;

  IF v_wave_status <> 'picked' THEN
    RAISE EXCEPTION '撿貨單 % 目前狀態為「%」，需先確認撿貨完成（picked）才能派貨', p_wave_id, v_wave_status;
  END IF;

  -- 防禦性修補：若有 picked_qty IS NULL（未手動填），補成 qty
  UPDATE picking_wave_items
     SET picked_qty = qty,
         updated_by = p_operator
   WHERE wave_id   = p_wave_id
     AND picked_qty IS NULL;

  -- 檢查是否有任何品項有撿貨量
  SELECT COUNT(DISTINCT store_id), COUNT(*)
    INTO v_expected_store_count, v_expected_item_count
    FROM picking_wave_items
   WHERE wave_id = p_wave_id AND picked_qty > 0;

  IF v_expected_item_count = 0 THEN
    -- 區分「根本沒有品項」vs「全部撿貨量為 0」
    PERFORM 1 FROM picking_wave_items WHERE wave_id = p_wave_id LIMIT 1;
    IF NOT FOUND THEN
      RAISE EXCEPTION '撿貨單 % 沒有任何品項，無法產生出倉單', p_wave_id;
    ELSE
      RAISE EXCEPTION '撿貨單 % 所有品項撿貨數量均為 0，無法產生出倉單。請先在「修正數量」輸入實際撿貨量再派貨。', p_wave_id;
    END IF;
  END IF;

  FOR v_store_rec IN
    SELECT DISTINCT pwi.store_id, s.location_id
      FROM picking_wave_items pwi
      JOIN stores s ON s.id = pwi.store_id
     WHERE pwi.wave_id = p_wave_id AND pwi.picked_qty > 0
  LOOP
    v_dest_location_id := v_store_rec.location_id;
    IF v_dest_location_id IS NULL THEN
      RAISE EXCEPTION '分店 % 未設定倉庫位置（location_id）', v_store_rec.store_id;
    END IF;

    INSERT INTO transfers (tenant_id, transfer_no, source_location, dest_location,
                           status, transfer_type, requested_by, shipped_by, shipped_at,
                           created_by, updated_by)
    VALUES (v_tenant_id,
            'WAVE-' || p_wave_id || '-S' || v_store_rec.store_id,
            p_hq_location_id, v_dest_location_id,
            'shipped', 'hq_to_store', p_operator, p_operator, NOW(),
            p_operator, p_operator)
    RETURNING id INTO v_new_xfer_id;

    FOR v_pwi IN
      SELECT id, sku_id, picked_qty
        FROM picking_wave_items
       WHERE wave_id  = p_wave_id
         AND store_id = v_store_rec.store_id
         AND picked_qty > 0
    LOOP
      v_out_mov_id := rpc_outbound(
        p_tenant_id       => v_tenant_id,
        p_location_id     => p_hq_location_id,
        p_sku_id          => v_pwi.sku_id,
        p_quantity        => v_pwi.picked_qty,
        p_movement_type   => 'transfer_out',
        p_source_doc_type => 'transfer',
        p_source_doc_id   => v_new_xfer_id,
        p_operator        => p_operator,
        p_allow_negative  => FALSE
      );

      INSERT INTO transfer_items (transfer_id, sku_id, qty_requested, qty_shipped,
                                  out_movement_id, created_by, updated_by)
      VALUES (v_new_xfer_id, v_pwi.sku_id, v_pwi.picked_qty, v_pwi.picked_qty,
              v_out_mov_id, p_operator, p_operator);
    END LOOP;

    GET DIAGNOSTICS v_inserted_items = ROW_COUNT;

    UPDATE picking_wave_items
       SET generated_transfer_id = v_new_xfer_id, updated_by = p_operator
     WHERE wave_id  = p_wave_id
       AND store_id = v_store_rec.store_id
       AND picked_qty > 0;

    INSERT INTO picking_wave_audit_log (tenant_id, wave_id, action, after_value, created_by)
    VALUES (v_tenant_id, p_wave_id, 'so_generated',
            jsonb_build_object('transfer_id', v_new_xfer_id,
                               'store_id', v_store_rec.store_id,
                               'items_count', v_inserted_items),
            p_operator);

    v_xfer_ids := v_xfer_ids || v_new_xfer_id;
  END LOOP;

  UPDATE picking_waves SET status = 'shipped', updated_by = p_operator WHERE id = p_wave_id;

  -- 呼叫訂單狀態更新（若 function 存在）
  BEGIN
    PERFORM rpc_mark_orders_shipping_for_wave(p_wave_id, p_operator);
  EXCEPTION WHEN undefined_function THEN NULL;
  END;

  SELECT COUNT(DISTINCT generated_transfer_id)
    INTO v_actual_xfer_count
    FROM picking_wave_items
   WHERE wave_id = p_wave_id AND picked_qty > 0 AND generated_transfer_id IS NOT NULL;

  IF v_actual_xfer_count <> v_expected_store_count THEN
    RAISE EXCEPTION '出倉單數量不符：預期 % 張，實際建立 % 張', v_expected_store_count, v_actual_xfer_count;
  END IF;

  RETURN jsonb_build_object(
    'wave_id',      p_wave_id,
    'transfer_ids', to_jsonb(v_xfer_ids),
    'store_count',  v_expected_store_count,
    'item_count',   v_expected_item_count
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION generate_transfer_from_wave(BIGINT, BIGINT, UUID) TO authenticated;
COMMENT ON FUNCTION generate_transfer_from_wave IS
  '根據撿貨單產生分店出倉 transfer；需 status=picked 且至少一項 picked_qty > 0';
