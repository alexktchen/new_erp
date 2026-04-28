-- ============================================================================
-- 拆開進貨 / 撿貨 / 派貨三步
-- 舊版 rpc_arrive_and_distribute 一次完成 GR + wave(picked) + transfer(shipped)，
-- 改為只做 GR 入倉 + wave(picking)，後續由撿貨工作站手動確認再派貨。
--
-- 受影響的 picking_wave_items：picked_qty 改為 0（等人工撿貨輸入）
-- wave status：停在 'picking'，不再跳 'picked' / 'shipped'
-- transfer 建立：完全移出，改由 generate_transfer_from_wave 在確認撿完後呼叫
-- ============================================================================

CREATE OR REPLACE FUNCTION public.rpc_arrive_and_distribute(
  p_po_id      BIGINT,
  p_arrivals   JSONB,
  p_operator   UUID,
  p_invoice_no TEXT DEFAULT NULL,
  p_notes      TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_po              RECORD;
  v_close_dates     DATE[];
  v_close_date      DATE;
  v_gr_id           BIGINT;
  v_gr_no           TEXT;
  v_wave_id         BIGINT := NULL;
  v_wave_code       TEXT := NULL;
  v_arrival         JSONB;
  v_alloc           JSONB;
  v_po_item_id      BIGINT;
  v_sku_id          BIGINT;
  v_qty_received    NUMERIC(18,3);
  v_qty_damaged     NUMERIC(18,3);
  v_unit_cost       NUMERIC(18,4);
  v_alloc_total     NUMERIC(18,3);
  v_default_cost    NUMERIC(18,4);
  v_item_count      INTEGER;
  v_store_count     INTEGER;
  v_total_qty       NUMERIC(18,3);
BEGIN
  -- 1. PO 守衛
  SELECT id, tenant_id, supplier_id, dest_location_id, status
    INTO v_po
    FROM purchase_orders
   WHERE id = p_po_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'PO % not found', p_po_id;
  END IF;
  IF v_po.status NOT IN ('sent','partially_received') THEN
    RAISE EXCEPTION 'PO % must be sent/partially_received (current: %)', p_po_id, v_po.status;
  END IF;

  -- 2. 反查 close_date
  SELECT array_agg(DISTINCT pr.source_close_date)
    INTO v_close_dates
    FROM purchase_order_items poi
    JOIN purchase_request_items pri ON pri.po_item_id = poi.id
    JOIN purchase_requests pr ON pr.id = pri.pr_id
   WHERE poi.po_id = p_po_id
     AND pr.source_close_date IS NOT NULL;

  IF v_close_dates IS NOT NULL AND array_length(v_close_dates, 1) > 1 THEN
    RAISE EXCEPTION 'PO % spans multiple close_dates: %', p_po_id, v_close_dates;
  END IF;

  v_close_date := COALESCE(v_close_dates[1], NULL);

  -- 3. GR header
  v_gr_no := public.rpc_next_gr_no();
  INSERT INTO goods_receipts (
    tenant_id, gr_no, po_id, supplier_id, dest_location_id,
    status, supplier_invoice_no, received_by, notes, created_by, updated_by
  ) VALUES (
    v_po.tenant_id, v_gr_no, v_po.id, v_po.supplier_id, v_po.dest_location_id,
    'draft', p_invoice_no, p_operator, p_notes, p_operator, p_operator
  ) RETURNING id INTO v_gr_id;

  -- 4. GR items
  FOR v_arrival IN SELECT * FROM jsonb_array_elements(p_arrivals) LOOP
    v_po_item_id   := (v_arrival->>'po_item_id')::BIGINT;
    v_sku_id       := (v_arrival->>'sku_id')::BIGINT;
    v_qty_received := (v_arrival->>'qty_received')::NUMERIC;
    v_qty_damaged  := COALESCE((v_arrival->>'qty_damaged')::NUMERIC, 0);
    v_unit_cost    := (v_arrival->>'unit_cost')::NUMERIC;

    IF v_qty_received IS NULL OR v_qty_received <= 0 THEN
      RAISE EXCEPTION 'arrival sku_id % has invalid qty_received', v_sku_id;
    END IF;

    IF v_unit_cost IS NULL THEN
      SELECT unit_cost INTO v_default_cost FROM purchase_order_items WHERE id = v_po_item_id;
      v_unit_cost := COALESCE(v_default_cost, 0);
    END IF;

    INSERT INTO goods_receipt_items (
      gr_id, po_item_id, sku_id,
      qty_expected, qty_received, qty_damaged, unit_cost,
      batch_no, expiry_date, variance_reason, created_by, updated_by
    ) VALUES (
      v_gr_id, v_po_item_id, v_sku_id,
      (SELECT qty_ordered FROM purchase_order_items WHERE id = v_po_item_id),
      v_qty_received, v_qty_damaged, v_unit_cost,
      v_arrival->>'batch_no',
      NULLIF(v_arrival->>'expiry_date','')::DATE,
      v_arrival->>'variance_reason',
      p_operator, p_operator
    );
  END LOOP;

  -- 5. confirm GR（入總倉庫存）
  PERFORM rpc_confirm_gr(v_gr_id, p_operator);

  -- 6. 建 picking_wave（停在 picking，等撿貨工作站人工確認）
  IF v_close_date IS NOT NULL THEN
    v_wave_code := public.rpc_next_wave_code();

    INSERT INTO picking_waves (
      tenant_id, wave_code, wave_date, status, note, created_by, updated_by
    ) VALUES (
      v_po.tenant_id, v_wave_code, v_close_date, 'picking',
      'auto from PO ' || p_po_id::text || ' / GR ' || v_gr_no,
      p_operator, p_operator
    ) RETURNING id INTO v_wave_id;

    FOR v_arrival IN SELECT * FROM jsonb_array_elements(p_arrivals) LOOP
      v_sku_id      := (v_arrival->>'sku_id')::BIGINT;
      v_qty_received := (v_arrival->>'qty_received')::NUMERIC;
      v_alloc_total := 0;

      IF v_arrival ? 'allocations' AND jsonb_array_length(v_arrival->'allocations') > 0 THEN
        FOR v_alloc IN SELECT * FROM jsonb_array_elements(v_arrival->'allocations') LOOP
          IF (v_alloc->>'qty')::NUMERIC > 0 THEN
            INSERT INTO picking_wave_items (
              tenant_id, wave_id, sku_id, store_id, qty, picked_qty,
              created_by, updated_by
            ) VALUES (
              v_po.tenant_id, v_wave_id, v_sku_id,
              (v_alloc->>'store_id')::BIGINT,
              (v_alloc->>'qty')::NUMERIC,
              0,                              -- 待撿貨，人工填
              p_operator, p_operator
            )
            ON CONFLICT (wave_id, sku_id, store_id) DO UPDATE
              SET qty        = picking_wave_items.qty + EXCLUDED.qty,
                  updated_by = p_operator;
            v_alloc_total := v_alloc_total + (v_alloc->>'qty')::NUMERIC;
          END IF;
        END LOOP;

        IF v_alloc_total > v_qty_received THEN
          RAISE EXCEPTION 'sku % allocation total % exceeds received %',
            v_sku_id, v_alloc_total, v_qty_received;
        END IF;
      END IF;
    END LOOP;

    SELECT COUNT(*), COUNT(DISTINCT store_id), COALESCE(SUM(qty), 0)
      INTO v_item_count, v_store_count, v_total_qty
      FROM picking_wave_items WHERE wave_id = v_wave_id;

    UPDATE picking_waves
       SET item_count  = v_item_count,
           store_count = v_store_count,
           total_qty   = v_total_qty,
           updated_at  = NOW()
     WHERE id = v_wave_id;

    INSERT INTO picking_wave_audit_log (tenant_id, wave_id, action, after_value, created_by)
    VALUES (v_po.tenant_id, v_wave_id, 'wave_created',
            jsonb_build_object('wave_code', v_wave_code, 'po_id', p_po_id, 'gr_id', v_gr_id,
                               'item_count', v_item_count, 'store_count', v_store_count),
            p_operator);
  END IF;

  -- 派貨（transfer 建立）改由撿貨工作站確認後呼叫 generate_transfer_from_wave

  RETURN jsonb_build_object(
    'gr_id',      v_gr_id,
    'gr_no',      v_gr_no,
    'wave_id',    v_wave_id,
    'wave_code',  v_wave_code,
    'close_date', v_close_date
  );
END;
$$;

COMMENT ON FUNCTION public.rpc_arrive_and_distribute IS
  '進貨確認：GR 入倉 + picking_wave(picking)。撿貨/派貨由工作站人工操作。';
