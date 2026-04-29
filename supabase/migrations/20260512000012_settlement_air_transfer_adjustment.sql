-- ============================================================
-- 月結算加上「空中轉」調整邏輯
--
-- 業態：訂單轉移會產生 transfers 兩種：
--   1. 經 HQ 中轉：leg-1 (store→HQ, store_to_store) + leg-2 (HQ→store, hq_to_store)
--      → leg-2 已被 hq_to_store 邏輯吃進結算
--   2. 空中轉 (is_air_transfer=true)：1 段 (source店→dest店, store_to_store, customer_order_id!=null)
--      → 之前 RPC 只看 hq_to_store、會漏掉
--
-- 修正：把空中轉加進結算
--   air_in:  該店是 dest_location 的 store_to_store with customer_order_id  → 加應付
--   air_out: 該店是 source_location 的 store_to_store with customer_order_id → 減應付
--   payable_amount = hq_inbound + air_in - air_out
--
-- Schema 變動：items 加 entry_type 欄位區分 3 類；line_amount 對 air_out 用負值
-- ============================================================

-- ------------------------------------------------------------
-- 1. items 表加 entry_type
-- ------------------------------------------------------------
ALTER TABLE public.store_monthly_settlement_items
  ADD COLUMN IF NOT EXISTS entry_type TEXT NOT NULL DEFAULT 'hq_inbound'
    CHECK (entry_type IN ('hq_inbound','air_in','air_out'));

CREATE INDEX IF NOT EXISTS idx_smsi_entry_type
  ON store_monthly_settlement_items (settlement_id, entry_type);

COMMENT ON COLUMN store_monthly_settlement_items.entry_type IS
  '結算明細類型：hq_inbound=從 HQ 收貨；air_in=空中轉收進；air_out=空中轉送出（line_amount 為負）';


-- ------------------------------------------------------------
-- 2. 重寫 rpc_generate_hq_to_store_settlement，加空中轉調整
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rpc_generate_hq_to_store_settlement(
  p_month    DATE,
  p_operator UUID
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_tenant         UUID;
  v_month_start    DATE := DATE_TRUNC('month', p_month)::DATE;
  v_month_end      DATE := (DATE_TRUNC('month', p_month) + INTERVAL '1 month')::DATE;
  v_store          RECORD;
  v_settlement_id  BIGINT;
  v_hq_inbound     NUMERIC(18,4);
  v_air_in         NUMERIC(18,4);
  v_air_out        NUMERIC(18,4);
  v_payable        NUMERIC(18,4);
  v_xfer_count     INTEGER;
  v_item_count     INTEGER;
  v_total_stores   INTEGER := 0;
  v_total_amount   NUMERIC(18,4) := 0;
BEGIN
  SELECT tenant_id INTO v_tenant FROM stores LIMIT 1;
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'no stores found, cannot infer tenant_id';
  END IF;

  FOR v_store IN
    SELECT s.id, s.code, s.name, s.location_id
      FROM stores s
     WHERE s.tenant_id = v_tenant
       AND s.location_id IS NOT NULL
  LOOP
    -- 跳過已 confirmed/settled
    IF EXISTS (
      SELECT 1 FROM store_monthly_settlements
       WHERE tenant_id = v_tenant
         AND settlement_month = v_month_start
         AND store_id = v_store.id
         AND status IN ('confirmed','settled')
    ) THEN
      CONTINUE;
    END IF;

    -- A) hq_inbound: 從 HQ 收貨
    SELECT
      COALESCE(SUM(ti.qty_received * COALESCE(sm.unit_cost, 0)), 0)
      INTO v_hq_inbound
      FROM transfers t
      JOIN transfer_items ti ON ti.transfer_id = t.id
      LEFT JOIN stock_movements sm ON sm.id = ti.out_movement_id
     WHERE t.tenant_id = v_tenant
       AND t.transfer_type = 'hq_to_store'
       AND t.status IN ('received','closed')
       AND t.dest_location = v_store.location_id
       AND t.received_at >= v_month_start
       AND t.received_at < v_month_end
       AND ti.qty_received > 0;

    -- B) air_in: 空中轉收進來（該店是 dest）
    SELECT
      COALESCE(SUM(ti.qty_received * COALESCE(sm.unit_cost, 0)), 0)
      INTO v_air_in
      FROM transfers t
      JOIN transfer_items ti ON ti.transfer_id = t.id
      LEFT JOIN stock_movements sm ON sm.id = ti.out_movement_id
     WHERE t.tenant_id = v_tenant
       AND t.transfer_type = 'store_to_store'
       AND t.customer_order_id IS NOT NULL
       AND t.status IN ('received','closed')
       AND t.dest_location = v_store.location_id
       AND t.received_at >= v_month_start
       AND t.received_at < v_month_end
       AND ti.qty_received > 0;

    -- C) air_out: 空中轉送出去（該店是 source）
    SELECT
      COALESCE(SUM(ti.qty_received * COALESCE(sm.unit_cost, 0)), 0)
      INTO v_air_out
      FROM transfers t
      JOIN transfer_items ti ON ti.transfer_id = t.id
      LEFT JOIN stock_movements sm ON sm.id = ti.out_movement_id
     WHERE t.tenant_id = v_tenant
       AND t.transfer_type = 'store_to_store'
       AND t.customer_order_id IS NOT NULL
       AND t.status IN ('received','closed')
       AND t.source_location = v_store.location_id
       AND t.received_at >= v_month_start
       AND t.received_at < v_month_end
       AND ti.qty_received > 0;

    v_payable := v_hq_inbound + v_air_in - v_air_out;

    -- 沒任何活動就 skip + 砍 draft
    IF v_hq_inbound = 0 AND v_air_in = 0 AND v_air_out = 0 THEN
      DELETE FROM store_monthly_settlements
       WHERE tenant_id = v_tenant
         AND settlement_month = v_month_start
         AND store_id = v_store.id
         AND status = 'draft';
      CONTINUE;
    END IF;

    -- 計 transfer_count + item_count
    SELECT
      COUNT(DISTINCT t.id), COUNT(ti.id)
      INTO v_xfer_count, v_item_count
      FROM transfers t
      JOIN transfer_items ti ON ti.transfer_id = t.id
     WHERE t.tenant_id = v_tenant
       AND t.status IN ('received','closed')
       AND t.received_at >= v_month_start
       AND t.received_at < v_month_end
       AND ti.qty_received > 0
       AND (
         (t.transfer_type = 'hq_to_store' AND t.dest_location = v_store.location_id)
         OR
         (t.transfer_type = 'store_to_store' AND t.customer_order_id IS NOT NULL
          AND (t.dest_location = v_store.location_id OR t.source_location = v_store.location_id))
       );

    -- upsert (draft only)
    INSERT INTO store_monthly_settlements (
      tenant_id, settlement_month, store_id,
      payable_amount, transfer_count, item_count,
      status, created_by, updated_by
    ) VALUES (
      v_tenant, v_month_start, v_store.id,
      v_payable, v_xfer_count, v_item_count,
      'draft', p_operator, p_operator
    )
    ON CONFLICT (tenant_id, settlement_month, store_id)
    DO UPDATE SET
      payable_amount = EXCLUDED.payable_amount,
      transfer_count = EXCLUDED.transfer_count,
      item_count     = EXCLUDED.item_count,
      updated_by     = p_operator,
      updated_at     = NOW()
    WHERE store_monthly_settlements.status = 'draft'
    RETURNING id INTO v_settlement_id;

    -- 重建 items
    DELETE FROM store_monthly_settlement_items WHERE settlement_id = v_settlement_id;

    -- A) hq_inbound items
    INSERT INTO store_monthly_settlement_items (
      tenant_id, settlement_id, transfer_id, transfer_item_id,
      sku_id, qty_received, unit_cost, line_amount, received_at, entry_type
    )
    SELECT
      v_tenant, v_settlement_id, t.id, ti.id,
      ti.sku_id, ti.qty_received, COALESCE(sm.unit_cost, 0),
      ti.qty_received * COALESCE(sm.unit_cost, 0),
      t.received_at, 'hq_inbound'
      FROM transfers t
      JOIN transfer_items ti ON ti.transfer_id = t.id
      LEFT JOIN stock_movements sm ON sm.id = ti.out_movement_id
     WHERE t.tenant_id = v_tenant
       AND t.transfer_type = 'hq_to_store'
       AND t.status IN ('received','closed')
       AND t.dest_location = v_store.location_id
       AND t.received_at >= v_month_start
       AND t.received_at < v_month_end
       AND ti.qty_received > 0;

    -- B) air_in items
    INSERT INTO store_monthly_settlement_items (
      tenant_id, settlement_id, transfer_id, transfer_item_id,
      sku_id, qty_received, unit_cost, line_amount, received_at, entry_type
    )
    SELECT
      v_tenant, v_settlement_id, t.id, ti.id,
      ti.sku_id, ti.qty_received, COALESCE(sm.unit_cost, 0),
      ti.qty_received * COALESCE(sm.unit_cost, 0),
      t.received_at, 'air_in'
      FROM transfers t
      JOIN transfer_items ti ON ti.transfer_id = t.id
      LEFT JOIN stock_movements sm ON sm.id = ti.out_movement_id
     WHERE t.tenant_id = v_tenant
       AND t.transfer_type = 'store_to_store'
       AND t.customer_order_id IS NOT NULL
       AND t.status IN ('received','closed')
       AND t.dest_location = v_store.location_id
       AND t.received_at >= v_month_start
       AND t.received_at < v_month_end
       AND ti.qty_received > 0;

    -- C) air_out items（line_amount 用負值）
    INSERT INTO store_monthly_settlement_items (
      tenant_id, settlement_id, transfer_id, transfer_item_id,
      sku_id, qty_received, unit_cost, line_amount, received_at, entry_type
    )
    SELECT
      v_tenant, v_settlement_id, t.id, ti.id,
      ti.sku_id, ti.qty_received, COALESCE(sm.unit_cost, 0),
      -1 * ti.qty_received * COALESCE(sm.unit_cost, 0),  -- 負值
      t.received_at, 'air_out'
      FROM transfers t
      JOIN transfer_items ti ON ti.transfer_id = t.id
      LEFT JOIN stock_movements sm ON sm.id = ti.out_movement_id
     WHERE t.tenant_id = v_tenant
       AND t.transfer_type = 'store_to_store'
       AND t.customer_order_id IS NOT NULL
       AND t.status IN ('received','closed')
       AND t.source_location = v_store.location_id
       AND t.received_at >= v_month_start
       AND t.received_at < v_month_end
       AND ti.qty_received > 0;

    v_total_stores := v_total_stores + 1;
    v_total_amount := v_total_amount + v_payable;
  END LOOP;

  RETURN jsonb_build_object(
    'month',         to_char(v_month_start, 'YYYY-MM'),
    'stores_count',  v_total_stores,
    'total_amount',  v_total_amount
  );
END;
$$;

COMMENT ON FUNCTION public.rpc_generate_hq_to_store_settlement IS
  'HQ→店月結算（含空中轉調整）：payable = hq_inbound + air_in - air_out。已 confirmed/settled 不重算。';
