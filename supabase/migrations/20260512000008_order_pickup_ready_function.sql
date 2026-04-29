-- ============================================================
-- is_order_pickup_ready function + v_order_pickup_ready view
--
-- 問題：customer_orders.status 在多種情境下沒被同步到 'ready'
-- （例如 rpc_receive_transfer 對普通直購訂單漏推），導致：
--   - OrderDetail timeline 顯示「分店收貨 ✓」(讀 transfer.status)
--   - 但訂單頂部 status 仍是 'pending' (讀 customer_orders.status)
--   - 取貨按鈕 disabled、RPC 拒收
--
-- 解法：把「能不能取貨」改為讀「分店收貨 transfer 的實際狀態」
-- 而不是 customer_orders.status。建立 single source of truth：
--
--   public.is_order_pickup_ready(order_id) → boolean
--   public.v_order_pickup_ready (order_id, pickup_ready)
--
-- 兩條取貨路徑：
--   A. 互助訂單：transfers.customer_order_id = order.id
--   B. 普通團購：picking_wave_items.campaign_id = order.campaign_id
--                AND store_id = order.pickup_store_id
--                → transfer_no LIKE 'WAVE-{wave_id}-S{store_id}'
--
-- 同時更新 rpc_record_pickup：用新 function 取代既有的
--   IF status NOT IN ('ready','partially_completed') 檢查。
-- ============================================================

-- ------------------------------------------------------------
-- 1. 核心 function：is_order_pickup_ready
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_order_pickup_ready(p_order_id BIGINT)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT EXISTS (
    SELECT 1
      FROM customer_orders co
     WHERE co.id = p_order_id
       AND co.status NOT IN ('completed','expired','cancelled','transferred_out')
       AND (
         -- 路徑 A：互助訂單 — transfer 直接 FK 到 order
         EXISTS (
           SELECT 1 FROM transfers t
            WHERE t.customer_order_id = co.id
              AND t.tenant_id = co.tenant_id
              AND t.status IN ('received','closed')
         )
         OR
         -- 路徑 B：普通團購 — campaign + store join wave、transfer_no 拼接
         EXISTS (
           SELECT 1
             FROM picking_wave_items pwi
             JOIN transfers t
               ON t.tenant_id = pwi.tenant_id
              AND t.transfer_type = 'hq_to_store'
              AND t.transfer_no = 'WAVE-' || pwi.wave_id || '-S' || co.pickup_store_id
              AND t.status IN ('received','closed')
            WHERE pwi.tenant_id = co.tenant_id
              AND pwi.campaign_id = co.campaign_id
              AND pwi.store_id = co.pickup_store_id
         )
       )
  );
$$;

GRANT EXECUTE ON FUNCTION public.is_order_pickup_ready(BIGINT) TO authenticated;

COMMENT ON FUNCTION public.is_order_pickup_ready IS
  '訂單是否可取貨：基於分店收貨 transfer 的實際狀態（不依賴 customer_orders.status 同步）。覆蓋互助 (FK) + 普通團購 (campaign+store join wave) 兩條路徑。';


-- ------------------------------------------------------------
-- 2. 共用 view：v_order_pickup_ready
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW public.v_order_pickup_ready AS
SELECT
  co.id AS order_id,
  co.tenant_id,
  public.is_order_pickup_ready(co.id) AS pickup_ready
FROM customer_orders co;

GRANT SELECT ON public.v_order_pickup_ready TO authenticated;

COMMENT ON VIEW public.v_order_pickup_ready IS
  '訂單可取貨判斷 view，UI 直接 join 取 pickup_ready 欄位';


-- ------------------------------------------------------------
-- 3. 更新 rpc_record_pickup：改用 is_order_pickup_ready
-- ------------------------------------------------------------
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

  -- 排除終態
  IF v_order.status IN ('completed','expired','cancelled','transferred_out') THEN
    RAISE EXCEPTION '訂單 % 目前狀態為「%」，無法取貨', p_order_id, v_order.status;
  END IF;

  -- 改為讀分店收貨 transfer 的實際狀態（不依賴 customer_orders.status）
  IF NOT public.is_order_pickup_ready(p_order_id) THEN
    RAISE EXCEPTION '訂單 % 對應的分店尚未確認收到出倉單，無法取貨', p_order_id;
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
    'event_id',        v_event_id,
    'event_type',      v_event_type,
    'picked_count',    v_picked_count,
    'active_remaining', v_active_remaining,
    'new_status',      v_new_status
  );
END;
$$;

GRANT EXECUTE ON FUNCTION rpc_record_pickup(BIGINT, BIGINT[], UUID, TEXT) TO authenticated;

COMMENT ON FUNCTION rpc_record_pickup IS
  '顧客取貨 RPC；用 is_order_pickup_ready() 判斷取貨可行性（基於分店收貨 transfer 狀態、不依賴 customer_orders.status 同步）';
