-- ============================================================
-- rpc_cancel_aid_order：取消 / 撤回派貨
--
-- 場景：
--   A. 早期取消（pending / confirmed）：直接 status='cancelled'
--   B. 派貨後撤回（shipping）：找出整條 transfer chain，
--      shipped 的反向 inbound、draft 的直接 cancel；
--      已 received 的不能撤（RAISE）
--
-- 取消後：
--   - customer_orders.status = 'cancelled', cancelled_at = NOW()
--   - 原 source order（transferred_from_order_id）回到 'confirmed'
--     並清掉 transferred_to_order_id（決策 Q）
-- ============================================================

CREATE OR REPLACE FUNCTION rpc_cancel_aid_order(
  p_order_id BIGINT,
  p_reason   TEXT,
  p_operator UUID
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_order            customer_orders%ROWTYPE;
  v_terminal_id      BIGINT;
  v_xfer             transfers%ROWTYPE;
  v_ti               RECORD;
  v_cancelled_ids    BIGINT[] := ARRAY[]::BIGINT[];
  v_reason_note      TEXT;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('aid_order:' || p_order_id));

  SELECT * INTO v_order FROM customer_orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'order % not found', p_order_id;
  END IF;
  IF v_order.status NOT IN ('pending', 'confirmed', 'shipping') THEN
    RAISE EXCEPTION 'order % is %, only pending/confirmed/shipping can be cancelled', p_order_id, v_order.status;
  END IF;

  v_reason_note := '[cancelled by source: ' || COALESCE(p_reason, '') || ']';

  -- 場景 B：已派貨，要回收 transfer chain
  IF v_order.status = 'shipping' THEN
    -- 找最終 leg（customer_order_id 指向本單的那張）
    SELECT id INTO v_terminal_id
      FROM transfers
     WHERE customer_order_id = p_order_id
       AND tenant_id = v_order.tenant_id
     LIMIT 1;

    IF v_terminal_id IS NULL THEN
      RAISE EXCEPTION 'order % is shipping but has no terminal transfer', p_order_id;
    END IF;

    -- 用 recursive CTE 找整條 chain（從頭走到尾）
    FOR v_xfer IN
      WITH RECURSIVE chain_back AS (
        -- 從 terminal 倒走找 head
        SELECT * FROM transfers WHERE id = v_terminal_id
        UNION ALL
        SELECT t.* FROM transfers t
          JOIN chain_back c ON c.id = ANY(
            SELECT id FROM transfers WHERE next_transfer_id = c.id
          )
      ),
      head AS (
        SELECT id FROM chain_back
         WHERE id NOT IN (SELECT next_transfer_id FROM transfers WHERE next_transfer_id IS NOT NULL)
         LIMIT 1
      ),
      chain_forward AS (
        SELECT * FROM transfers WHERE id = (SELECT id FROM head)
        UNION ALL
        SELECT t.* FROM transfers t
          JOIN chain_forward c ON t.id = c.next_transfer_id
      )
      SELECT * FROM chain_forward ORDER BY id
    LOOP
      IF v_xfer.status = 'received' THEN
        RAISE EXCEPTION 'transfer % already received, cannot cancel chain', v_xfer.id;
      END IF;

      IF v_xfer.status = 'shipped' THEN
        -- 反向：把 outbound 過的貨退回 source_location
        FOR v_ti IN
          SELECT id, sku_id, qty_shipped FROM transfer_items
           WHERE transfer_id = v_xfer.id AND qty_shipped > 0
        LOOP
          PERFORM rpc_inbound(
            p_tenant_id       => v_xfer.tenant_id,
            p_location_id     => v_xfer.source_location,
            p_sku_id          => v_ti.sku_id,
            p_quantity        => v_ti.qty_shipped,
            p_unit_cost       => 0,
            p_movement_type   => 'transfer_cancel',
            p_source_doc_type => 'transfer',
            p_source_doc_id   => v_xfer.id,
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
       WHERE id = v_xfer.id;
      v_cancelled_ids := v_cancelled_ids || v_xfer.id;
    END LOOP;
  END IF;

  -- 場景 A & B 共同：標記訂單 cancelled
  UPDATE customer_orders
     SET status       = 'cancelled',
         cancelled_at = NOW(),
         updated_by   = p_operator,
         updated_at   = NOW()
   WHERE id = p_order_id;

  -- source order 回到 confirmed（決策 Q）
  IF v_order.transferred_from_order_id IS NOT NULL THEN
    UPDATE customer_orders
       SET status                   = 'confirmed',
           transferred_to_order_id  = NULL,
           updated_by               = p_operator,
           updated_at               = NOW()
     WHERE id = v_order.transferred_from_order_id
       AND status = 'transferred_out';
  END IF;

  RETURN jsonb_build_object(
    'order_id', p_order_id,
    'cancelled_transfer_ids', to_jsonb(v_cancelled_ids),
    'source_order_reverted', v_order.transferred_from_order_id IS NOT NULL
  );
END;
$$;

GRANT EXECUTE ON FUNCTION rpc_cancel_aid_order(BIGINT, TEXT, UUID) TO authenticated;

COMMENT ON FUNCTION rpc_cancel_aid_order IS
  'Aid order 取消 / 撤回派貨：早期 status only；shipping 階段反向回收整條 transfer chain。source order 回到 confirmed。';
