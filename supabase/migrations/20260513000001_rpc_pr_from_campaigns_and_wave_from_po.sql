-- ============================================================
-- RPC: rpc_create_pr_from_campaigns 跟 rpc_create_wave_from_po
-- ============================================================

-- ------------------------------------------------------------
-- 1. rpc_create_pr_from_campaigns(p_campaign_ids[], p_operator)
--   建 PR + 寫入 purchase_request_campaigns join 表
--   不檢查重複（同 campaigns 可重複開、補單）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rpc_create_pr_from_campaigns(
  p_campaign_ids BIGINT[],
  p_operator     UUID
) RETURNS BIGINT
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_tenant      UUID := public._current_tenant_id();
  v_pr_id       BIGINT;
  v_pr_no       TEXT;
  v_dest_loc    BIGINT;
  v_demand_count INTEGER;
  v_min_close_date DATE;
BEGIN
  IF p_campaign_ids IS NULL OR array_length(p_campaign_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'p_campaign_ids is empty';
  END IF;

  -- 守衛：所有 campaigns 都必須屬同 tenant 且 status='closed'
  IF EXISTS (
    SELECT 1 FROM group_buy_campaigns
     WHERE id = ANY(p_campaign_ids)
       AND (tenant_id <> v_tenant OR status NOT IN ('closed','ordered','receiving','ready','completed'))
  ) THEN
    RAISE EXCEPTION 'some campaigns not in tenant or not closed yet';
  END IF;

  -- 至少有訂單可彙總
  SELECT COUNT(*) INTO v_demand_count
    FROM customer_orders co
    JOIN customer_order_items coi ON coi.order_id = co.id
   WHERE co.campaign_id = ANY(p_campaign_ids)
     AND co.tenant_id = v_tenant
     AND co.status NOT IN ('cancelled','expired','transferred_out')
     AND coi.status NOT IN ('cancelled','expired');

  IF v_demand_count = 0 THEN
    RAISE EXCEPTION 'no orders to aggregate for given campaigns';
  END IF;

  -- 取最小 close_date 作 source_close_date（向下相容用、實際資料看 join 表）
  SELECT MIN(DATE(end_at AT TIME ZONE 'Asia/Taipei')) INTO v_min_close_date
    FROM group_buy_campaigns
   WHERE id = ANY(p_campaign_ids);

  -- dest location
  SELECT id INTO v_dest_loc FROM locations WHERE tenant_id = v_tenant ORDER BY id LIMIT 1;
  IF v_dest_loc IS NULL THEN
    RAISE EXCEPTION 'no locations defined';
  END IF;

  -- PR header（source_type='campaigns' 表示走多 campaigns 路徑）
  v_pr_no := public.rpc_next_pr_no();

  INSERT INTO purchase_requests (
    tenant_id, pr_no, source_type, source_close_date,
    source_location_id, status, total_amount,
    created_by, updated_by
  ) VALUES (
    v_tenant, v_pr_no, 'close_date', v_min_close_date,
    v_dest_loc, 'draft', 0,
    p_operator, p_operator
  ) RETURNING id INTO v_pr_id;

  -- 寫入 join 表
  INSERT INTO purchase_request_campaigns (pr_id, campaign_id, tenant_id)
  SELECT v_pr_id, unnest(p_campaign_ids), v_tenant
  ON CONFLICT (pr_id, campaign_id) DO NOTHING;

  -- 彙總所選 campaigns 的訂單需求 → PR items（含售價 snapshot）
  INSERT INTO purchase_request_items (
    pr_id, sku_id, qty_requested,
    suggested_supplier_id, unit_cost,
    retail_price, franchise_price,
    source_campaign_id,
    created_by, updated_by
  )
  SELECT
    v_pr_id, agg.sku_id, agg.qty_total,
    ss.supplier_id, COALESCE(ss.default_unit_cost, 0),
    pr_retail.price, pr_franchise.price,
    agg.first_campaign_id, p_operator, p_operator
  FROM (
    SELECT
      coi.sku_id,
      SUM(coi.qty) AS qty_total,
      MIN(co.campaign_id) AS first_campaign_id
      FROM customer_orders co
      JOIN customer_order_items coi ON coi.order_id = co.id
     WHERE co.campaign_id = ANY(p_campaign_ids)
       AND co.tenant_id = v_tenant
       AND co.status NOT IN ('cancelled','expired','transferred_out')
       AND coi.status NOT IN ('cancelled','expired')
     GROUP BY coi.sku_id
  ) agg
  LEFT JOIN LATERAL (
    SELECT supplier_id, default_unit_cost
      FROM supplier_skus
     WHERE tenant_id = v_tenant AND sku_id = agg.sku_id AND is_preferred = TRUE
     LIMIT 1
  ) ss ON TRUE
  LEFT JOIN LATERAL (
    SELECT price FROM prices WHERE sku_id = agg.sku_id AND scope = 'retail'
     ORDER BY effective_from DESC NULLS LAST LIMIT 1
  ) pr_retail ON TRUE
  LEFT JOIN LATERAL (
    SELECT price FROM prices WHERE sku_id = agg.sku_id AND scope = 'franchise'
     ORDER BY effective_from DESC NULLS LAST LIMIT 1
  ) pr_franchise ON TRUE;

  -- total snapshot
  UPDATE purchase_requests pr
     SET total_amount = COALESCE((
           SELECT SUM(line_subtotal) FROM purchase_request_items WHERE pr_id = v_pr_id
         ), 0),
         updated_at = NOW()
   WHERE pr.id = v_pr_id;

  RETURN v_pr_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.rpc_create_pr_from_campaigns(BIGINT[], UUID) TO authenticated;

COMMENT ON FUNCTION public.rpc_create_pr_from_campaigns IS
  '從多選 campaigns 建 PR（取代 rpc_create_pr_from_close_date 的單日邏輯）。同 campaigns 可重複開、補單。';


-- ------------------------------------------------------------
-- 2. rpc_create_wave_from_po(p_po_id, p_allocations, p_operator)
--   按 PO 建撿貨單、p_allocations 是 (sku_id, store_id, qty)[] 三元組
--   - 守衛：每 sku 的 Σqty ≤ 該 PO 該 sku 「未撿量」(gr_qty - already_wave_qty)
--   - 建 picking_wave (source_po_id = p_po_id, status='draft')
--   - 建 picking_wave_items
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rpc_create_wave_from_po(
  p_po_id        BIGINT,
  p_wave_date    DATE,
  p_allocations  JSONB,  -- [{ sku_id, store_id, qty }]
  p_operator     UUID
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_po           purchase_orders%ROWTYPE;
  v_tenant       UUID;
  v_wave_id      BIGINT;
  v_wave_code    TEXT;
  v_alloc        JSONB;
  v_sku_id       BIGINT;
  v_store_id     BIGINT;
  v_qty          NUMERIC(18,3);
  v_first_campaign_id BIGINT;
  v_total_qty    NUMERIC(18,3) := 0;
  v_item_count   INTEGER := 0;
  v_store_count  INTEGER := 0;
BEGIN
  -- 1. PO 守衛
  SELECT * INTO v_po FROM purchase_orders WHERE id = p_po_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PO % not found', p_po_id;
  END IF;
  IF v_po.status NOT IN ('sent','partially_received','fully_received') THEN
    RAISE EXCEPTION 'PO % must be sent/partially_received/fully_received (current: %)', p_po_id, v_po.status;
  END IF;
  v_tenant := v_po.tenant_id;

  -- 2. 守衛：allocations 不能空、qty 必須 > 0
  IF p_allocations IS NULL OR jsonb_array_length(p_allocations) = 0 THEN
    RAISE EXCEPTION 'p_allocations is empty';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('wave:po:' || p_po_id::text));

  -- 3. 守衛：每 sku 的總分配量 ≤ (GR 量 − 已 wave 量)
  FOR v_alloc IN SELECT * FROM jsonb_array_elements(p_allocations) LOOP
    v_qty := (v_alloc->>'qty')::NUMERIC;
    IF v_qty IS NULL OR v_qty <= 0 THEN
      RAISE EXCEPTION 'allocation qty must be > 0';
    END IF;
  END LOOP;

  -- 按 sku 聚合 allocations 跟既有狀況比對
  WITH alloc_agg AS (
    SELECT
      (a->>'sku_id')::BIGINT  AS sku_id,
      SUM((a->>'qty')::NUMERIC) AS total_alloc
    FROM jsonb_array_elements(p_allocations) a
    GROUP BY (a->>'sku_id')::BIGINT
  ),
  po_sku_state AS (
    SELECT
      poi.sku_id,
      COALESCE(SUM(gri.qty_received) FILTER (WHERE gr.status = 'confirmed'), 0) AS gr_qty,
      COALESCE((
        SELECT SUM(pwi.qty)
          FROM picking_wave_items pwi
          JOIN picking_waves pw ON pw.id = pwi.wave_id
         WHERE pw.source_po_id = p_po_id
           AND pwi.sku_id = poi.sku_id
           AND pw.status <> 'cancelled'
      ), 0) AS already_wave
    FROM purchase_order_items poi
    LEFT JOIN goods_receipt_items gri ON gri.po_item_id = poi.id
    LEFT JOIN goods_receipts gr ON gr.id = gri.gr_id
    WHERE poi.po_id = p_po_id
    GROUP BY poi.sku_id
  )
  SELECT 1 INTO v_alloc
  FROM alloc_agg aa
  JOIN po_sku_state ps ON ps.sku_id = aa.sku_id
  WHERE aa.total_alloc > (ps.gr_qty - ps.already_wave)
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION 'allocation exceeds available (gr_qty - already_wave) for some sku';
  END IF;

  -- 4. wave header
  v_wave_code := 'WV' || to_char(NOW() AT TIME ZONE 'Asia/Taipei', 'YYMMDDHH24MISS');

  INSERT INTO picking_waves (
    tenant_id, wave_code, wave_date, status, source_po_id,
    created_by, updated_by
  ) VALUES (
    v_tenant, v_wave_code, p_wave_date, 'draft', p_po_id,
    p_operator, p_operator
  ) RETURNING id INTO v_wave_id;

  -- 5. wave items（campaign_id 取該 PO 第一個 campaign 作代表）
  SELECT prc.campaign_id INTO v_first_campaign_id
    FROM purchase_order_items poi
    JOIN purchase_request_items pri ON pri.po_item_id = poi.id
    JOIN purchase_request_campaigns prc ON prc.pr_id = pri.pr_id
   WHERE poi.po_id = p_po_id
   ORDER BY prc.campaign_id
   LIMIT 1;

  FOR v_alloc IN SELECT * FROM jsonb_array_elements(p_allocations) LOOP
    v_sku_id   := (v_alloc->>'sku_id')::BIGINT;
    v_store_id := (v_alloc->>'store_id')::BIGINT;
    v_qty      := (v_alloc->>'qty')::NUMERIC;

    INSERT INTO picking_wave_items (
      tenant_id, wave_id, sku_id, store_id, qty, campaign_id,
      created_by, updated_by
    ) VALUES (
      v_tenant, v_wave_id, v_sku_id, v_store_id, v_qty, v_first_campaign_id,
      p_operator, p_operator
    )
    ON CONFLICT (wave_id, sku_id, store_id) DO UPDATE
      SET qty = picking_wave_items.qty + EXCLUDED.qty,
          updated_by = p_operator,
          updated_at = NOW();
  END LOOP;

  -- 6. 統計 wave header
  SELECT COUNT(*), COUNT(DISTINCT store_id), COALESCE(SUM(qty), 0)
    INTO v_item_count, v_store_count, v_total_qty
    FROM picking_wave_items WHERE wave_id = v_wave_id;

  UPDATE picking_waves
     SET item_count = v_item_count,
         store_count = v_store_count,
         total_qty = v_total_qty,
         updated_at = NOW()
   WHERE id = v_wave_id;

  RETURN jsonb_build_object(
    'wave_id', v_wave_id,
    'wave_code', v_wave_code,
    'item_count', v_item_count,
    'store_count', v_store_count,
    'total_qty', v_total_qty
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.rpc_create_wave_from_po(BIGINT, DATE, JSONB, UUID) TO authenticated;

COMMENT ON FUNCTION public.rpc_create_wave_from_po IS
  '按 PO 建撿貨單；allocations 含 (sku_id, store_id, qty) 三元組；守衛 Σqty ≤ (gr_qty - already_wave)';
