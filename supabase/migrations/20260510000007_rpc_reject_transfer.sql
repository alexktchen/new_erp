-- ============================================================
-- rpc_reject_transfer：dest 端拒收
--
-- 流程：
--   1. 反向 inbound（貨退回 source_location）
--   2. 此 transfer status = 'cancelled'
--   3. 往後 walk chain：next_transfer_id 鏈中的 draft / shipped 一律 cancel
--      （shipped 也要反向）
--   4. 找 customer_order（current.customer_order_id 或 chain 終端的 customer_order_id）
--      → status = 'cancelled', cancelled_at = NOW()
--   5. source order 回到 confirmed（決策 Q）
--   6. 決策 Y：若往前有 received 的 leg（= 經總倉 dest 拒 Leg-2 的場景），
--      自動建 Leg-3：current.source_location → 原 source store location，
--      transfer_type='hq_to_store'（複用），status='shipped'，
--      customer_order_id=NULL，HQ outbound 此 Leg-3
--      並把 current.next_transfer_id 指向 Leg-3 以利 timeline 串接
-- ============================================================

CREATE OR REPLACE FUNCTION rpc_reject_transfer(
  p_transfer_id BIGINT,
  p_reason      TEXT,
  p_operator    UUID
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_xfer            transfers%ROWTYPE;
  v_ti              RECORD;
  v_next            transfers%ROWTYPE;
  v_prev            transfers%ROWTYPE;
  v_co_id           BIGINT;
  v_co              customer_orders%ROWTYPE;
  v_leg3_id         BIGINT;
  v_leg3_no         TEXT;
  v_leg3_dest_loc   BIGINT;
  v_leg3_mov        BIGINT;
  v_reason_note     TEXT;
  v_cancelled_ids   BIGINT[] := ARRAY[]::BIGINT[];
  v_epoch           BIGINT;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('transfer:' || p_transfer_id));

  SELECT * INTO v_xfer FROM transfers WHERE id = p_transfer_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'transfer % not found', p_transfer_id;
  END IF;
  IF v_xfer.status <> 'shipped' THEN
    RAISE EXCEPTION 'transfer % is %, only shipped can be rejected', p_transfer_id, v_xfer.status;
  END IF;

  v_reason_note := '[rejected: ' || COALESCE(p_reason, '') || ']';

  -- 1. 反向：把 outbound 過的貨退回 source_location
  FOR v_ti IN
    SELECT id, sku_id, qty_shipped FROM transfer_items
     WHERE transfer_id = p_transfer_id AND qty_shipped > 0
  LOOP
    PERFORM rpc_inbound(
      p_tenant_id       => v_xfer.tenant_id,
      p_location_id     => v_xfer.source_location,
      p_sku_id          => v_ti.sku_id,
      p_quantity        => v_ti.qty_shipped,
      p_unit_cost       => 0,
      p_movement_type   => 'transfer_reject',
      p_source_doc_type => 'transfer',
      p_source_doc_id   => p_transfer_id,
      p_operator        => p_operator
    );
  END LOOP;

  UPDATE transfers
     SET status = 'cancelled',
         notes = CASE
                   WHEN notes IS NULL OR notes = '' THEN v_reason_note
                   ELSE notes || E'\n' || v_reason_note
                 END,
         updated_by = p_operator
   WHERE id = p_transfer_id;
  v_cancelled_ids := v_cancelled_ids || p_transfer_id;

  -- 2. 往後 walk：next chain 的 draft/shipped cancel 掉
  IF v_xfer.next_transfer_id IS NOT NULL THEN
    SELECT * INTO v_next FROM transfers WHERE id = v_xfer.next_transfer_id FOR UPDATE;
    IF v_next.id IS NOT NULL AND v_next.status IN ('draft', 'shipped') THEN
      IF v_next.status = 'shipped' THEN
        FOR v_ti IN
          SELECT id, sku_id, qty_shipped FROM transfer_items
           WHERE transfer_id = v_next.id AND qty_shipped > 0
        LOOP
          PERFORM rpc_inbound(
            p_tenant_id       => v_next.tenant_id,
            p_location_id     => v_next.source_location,
            p_sku_id          => v_ti.sku_id,
            p_quantity        => v_ti.qty_shipped,
            p_unit_cost       => 0,
            p_movement_type   => 'transfer_reject',
            p_source_doc_type => 'transfer',
            p_source_doc_id   => v_next.id,
            p_operator        => p_operator
          );
        END LOOP;
      END IF;
      UPDATE transfers
         SET status = 'cancelled',
             notes = CASE
                       WHEN notes IS NULL OR notes = '' THEN v_reason_note
                       ELSE notes || E'\n' || v_reason_note
                     END,
             updated_by = p_operator
       WHERE id = v_next.id;
      v_cancelled_ids := v_cancelled_ids || v_next.id;
    END IF;
  END IF;

  -- 3. 找 customer_order
  v_co_id := v_xfer.customer_order_id;
  IF v_co_id IS NULL AND v_next.id IS NOT NULL THEN
    v_co_id := v_next.customer_order_id;
  END IF;

  IF v_co_id IS NOT NULL THEN
    SELECT * INTO v_co FROM customer_orders WHERE id = v_co_id;
    UPDATE customer_orders
       SET status       = 'cancelled',
           cancelled_at = NOW(),
           updated_by   = p_operator,
           updated_at   = NOW()
     WHERE id = v_co_id;

    IF v_co.transferred_from_order_id IS NOT NULL THEN
      UPDATE customer_orders
         SET status                  = 'confirmed',
             transferred_to_order_id = NULL,
             updated_by              = p_operator,
             updated_at              = NOW()
       WHERE id = v_co.transferred_from_order_id
         AND status = 'transferred_out';
    END IF;
  END IF;

  -- 4. 決策 Y：若往前有 received 的 leg，自動建 Leg-3 退回原 source
  SELECT * INTO v_prev
    FROM transfers
   WHERE next_transfer_id = p_transfer_id
   LIMIT 1;

  IF v_prev.id IS NOT NULL AND v_prev.status = 'received' THEN
    v_leg3_dest_loc := v_prev.source_location;  -- 退回原 source 店

    v_epoch := EXTRACT(EPOCH FROM NOW())::BIGINT;
    v_leg3_no := 'AT-RET-' || p_transfer_id || '-' || v_epoch;

    INSERT INTO transfers (
      tenant_id, transfer_no, source_location, dest_location,
      status, transfer_type, customer_order_id, next_transfer_id,
      requested_by, shipped_by, shipped_at,
      created_by, updated_by, notes
    ) VALUES (
      v_xfer.tenant_id, v_leg3_no, v_xfer.source_location, v_leg3_dest_loc,
      'shipped', 'hq_to_store', NULL, NULL,
      p_operator, p_operator, NOW(),
      p_operator, p_operator, '[Leg-3 退回 source after reject]'
    ) RETURNING id INTO v_leg3_id;

    -- 用拒收 transfer 的 qty_shipped 當 Leg-3 出貨量
    FOR v_ti IN
      SELECT sku_id, qty_shipped FROM transfer_items
       WHERE transfer_id = p_transfer_id AND qty_shipped > 0
    LOOP
      v_leg3_mov := rpc_outbound(
        p_tenant_id       => v_xfer.tenant_id,
        p_location_id     => v_xfer.source_location,
        p_sku_id          => v_ti.sku_id,
        p_quantity        => v_ti.qty_shipped,
        p_movement_type   => 'transfer_out',
        p_source_doc_type => 'transfer',
        p_source_doc_id   => v_leg3_id,
        p_operator        => p_operator
      );
      INSERT INTO transfer_items (
        transfer_id, sku_id, qty_requested, qty_shipped,
        out_movement_id, created_by, updated_by
      ) VALUES (
        v_leg3_id, v_ti.sku_id, v_ti.qty_shipped, v_ti.qty_shipped,
        v_leg3_mov, p_operator, p_operator
      );
    END LOOP;

    -- 把拒收 leg 的 next_transfer_id 指向 Leg-3，方便 timeline 串接
    UPDATE transfers SET next_transfer_id = v_leg3_id, updated_by = p_operator
     WHERE id = p_transfer_id;
  END IF;

  RETURN jsonb_build_object(
    'rejected_transfer_id', p_transfer_id,
    'cancelled_transfer_ids', to_jsonb(v_cancelled_ids),
    'cancelled_co_id', v_co_id,
    'leg3_transfer_id', v_leg3_id,
    'source_order_reverted', v_co.transferred_from_order_id IS NOT NULL
  );
END;
$$;

GRANT EXECUTE ON FUNCTION rpc_reject_transfer(BIGINT, TEXT, UUID) TO authenticated;

COMMENT ON FUNCTION rpc_reject_transfer IS
  'Aid transfer 拒收：反向 inbound、cancel 後續 chain、customer_order 取消、source order 回 confirmed。經總倉 dest 拒 Leg-2 自動建 Leg-3 退回原 source（決策 Y）。';
