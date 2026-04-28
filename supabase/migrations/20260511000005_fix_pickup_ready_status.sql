-- ============================================================
-- 修正取貨限制（最終版）：
--   1. rpc_record_pickup：只有 ready / partially_completed 可取貨
--   2. 一次性資料修復：已收貨但 order 仍在 shipping 的，補推到 ready
-- ============================================================

-- ============================================================
-- 1. rpc_record_pickup：只允許 ready / partially_completed
-- ============================================================
CREATE OR REPLACE FUNCTION rpc_record_pickup(
  p_order_id  BIGINT,
  p_item_ids  BIGINT[],
  p_operator  UUID,
  p_notes     TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_order            customer_orders%ROWTYPE;
  v_item_id          BIGINT;
  v_picked_count     INT := 0;
  v_active_remaining INT;
  v_new_status       TEXT;
  v_event_type       TEXT;
  v_event_id         BIGINT;
  v_now              TIMESTAMPTZ := NOW();
BEGIN
  IF p_item_ids IS NULL OR array_length(p_item_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'p_item_ids is empty';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('order_pickup:' || p_order_id::text));

  SELECT * INTO v_order FROM customer_orders WHERE id = p_order_id FOR UPDATE;
  IF v_order.id IS NULL THEN
    RAISE EXCEPTION '找不到訂單 %', p_order_id;
  END IF;

  -- 只有分店已收到貨（ready / partially_completed）才可取貨
  IF v_order.status NOT IN ('ready', 'partially_completed') THEN
    CASE v_order.status
      WHEN 'shipping' THEN
        RAISE EXCEPTION '訂單 % 正在運送中，請等分店在「收貨待辦」確認收貨後再取貨', p_order_id;
      WHEN 'completed' THEN
        RAISE EXCEPTION '訂單 % 已全部取貨完成', p_order_id;
      WHEN 'cancelled' THEN
        RAISE EXCEPTION '訂單 % 已取消', p_order_id;
      WHEN 'expired' THEN
        RAISE EXCEPTION '訂單 % 已逾期', p_order_id;
      ELSE
        RAISE EXCEPTION '訂單 % 目前狀態「%」尚無法取貨，需等出倉完成並分店收貨後才可操作', p_order_id, v_order.status;
    END CASE;
  END IF;

  -- 驗每個 item 屬本訂單、且 status 可取
  FOR v_item_id IN SELECT unnest(p_item_ids) LOOP
    PERFORM 1 FROM customer_order_items
      WHERE id = v_item_id
        AND order_id = p_order_id
        AND status IN ('pending','reserved','ready')
      FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION '品項 % 不屬於訂單 % 或狀態不可取貨', v_item_id, p_order_id;
    END IF;
  END LOOP;

  -- 標記 picked_up
  UPDATE customer_order_items
     SET status     = 'picked_up',
         updated_by = p_operator,
         updated_at = v_now
   WHERE id = ANY(p_item_ids);
  GET DIAGNOSTICS v_picked_count = ROW_COUNT;

  -- 重算 order status
  SELECT COUNT(*) INTO v_active_remaining
    FROM customer_order_items
   WHERE order_id = p_order_id
     AND status IN ('pending','reserved','ready');

  IF v_active_remaining = 0 THEN
    v_new_status := 'completed';
    v_event_type := 'picked_up';
  ELSE
    v_new_status := 'partially_completed';
    v_event_type := 'partial_pickup';
  END IF;

  UPDATE customer_orders
     SET status       = v_new_status,
         completed_at = CASE WHEN v_new_status = 'completed' THEN v_now ELSE NULL END,
         updated_by   = p_operator,
         updated_at   = v_now
   WHERE id = p_order_id;

  INSERT INTO order_pickup_events (
    tenant_id, order_id, pickup_store_id, event_type, item_ids, notes, created_by
  ) VALUES (
    v_order.tenant_id, p_order_id, v_order.pickup_store_id, v_event_type,
    to_jsonb(p_item_ids), p_notes, p_operator
  ) RETURNING id INTO v_event_id;

  RETURN jsonb_build_object(
    'event_id',         v_event_id,
    'event_type',       v_event_type,
    'picked_count',     v_picked_count,
    'active_remaining', v_active_remaining,
    'new_order_status', v_new_status
  );
END;
$$;

GRANT EXECUTE ON FUNCTION rpc_record_pickup(BIGINT, BIGINT[], UUID, TEXT) TO authenticated;

COMMENT ON FUNCTION rpc_record_pickup IS
  '顧客取貨；僅 ready/partially_completed 訂單可取；寫 order_pickup_events + 更新 items/order 狀態';

-- ============================================================
-- 2. 一次性資料修復：
--    status='shipping' 的 customer_orders，若其 pickup_store 對應的
--    hq_to_store transfer 已 received，補推到 ready
-- ============================================================
WITH fixed AS (
  UPDATE customer_orders co
     SET status     = 'ready',
         ready_at   = NOW(),
         updated_by = (SELECT id FROM auth.users LIMIT 1),
         updated_at = NOW()
   WHERE co.status = 'shipping'
     AND EXISTS (
       SELECT 1
         FROM transfers t
         JOIN stores s
           ON s.location_id = t.dest_location
          AND s.tenant_id   = co.tenant_id
        WHERE s.id               = co.pickup_store_id
          AND t.transfer_type    = 'hq_to_store'
          AND t.status           = 'received'
     )
  RETURNING co.id, co.order_no
)
SELECT COUNT(*) AS backfilled FROM fixed;
