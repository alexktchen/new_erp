-- 修正取貨限制：只擋 shipping（出倉在途），其他 active 狀態均可取貨
-- shipping = 出倉單已派出但分店尚未收到；此時客人不能取貨
-- pending / reserved / ready / partially_completed 均可取貨

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

  -- 出倉在途中（分店尚未收到），不可取貨
  IF v_order.status = 'shipping' THEN
    RAISE EXCEPTION '訂單 % 目前正在運送中，需等分店確認收到後才可取貨', p_order_id;
  END IF;

  -- 已完成 / 取消 / 逾期的訂單也不可取
  IF v_order.status IN ('completed','expired','cancelled','transferred_out') THEN
    RAISE EXCEPTION '訂單 % 狀態為「%」，無法再取貨', p_order_id, v_order.status;
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
     SET status = 'picked_up',
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

  -- 寫 event (append-only)
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
  '顧客取貨；shipping 狀態（運送中）不可取貨，其餘 active 狀態均可；items 改 picked_up、order 改 completed/partially_completed';
