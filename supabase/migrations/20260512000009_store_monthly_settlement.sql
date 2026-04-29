-- ============================================================
-- 店月結算 — HQ 對各加盟店每月計算貨款（賣斷制）
--
-- 業態：總倉 hq_to_store 出貨 → 分店收貨即欠總倉貨款
-- 計費：Σ (qty_received × out_movement.unit_cost)（出貨當下平均成本）
-- 月結：每月結算一次、產生 vendor_bill 給該分店的 supplier 入帳
--
-- 為什麼不共用 transfer_settlements：
--   transfer_settlements 是雙向結構（store_a / store_b、a_to_b / b_to_a）
--   且有 CHECK (store_a_id < store_b_id)；HQ 不是 store、不適用該 schema。
-- ============================================================

-- ------------------------------------------------------------
-- 1. 擴展 vendor_bills.source_type 加 'store_monthly_settlement'
-- ------------------------------------------------------------
ALTER TABLE public.vendor_bills
  DROP CONSTRAINT IF EXISTS vendor_bills_source_type_check;

ALTER TABLE public.vendor_bills
  ADD CONSTRAINT vendor_bills_source_type_check CHECK (
    source_type = ANY (ARRAY[
      'purchase_order',
      'goods_receipt',
      'transfer_settlement',
      'store_monthly_settlement',  -- HQ 對店月結
      'xiaolan_import',
      'manual'
    ])
  );

-- ------------------------------------------------------------
-- 2. store_monthly_settlements 主檔
-- ------------------------------------------------------------
CREATE TABLE public.store_monthly_settlements (
  id                       BIGSERIAL PRIMARY KEY,
  tenant_id                UUID NOT NULL,
  settlement_month         DATE NOT NULL,            -- 該月第一天（DATE_TRUNC('month'))
  store_id                 BIGINT NOT NULL REFERENCES stores(id),
  payable_amount           NUMERIC(18,4) NOT NULL DEFAULT 0,  -- 該店本月應付總倉
  transfer_count           INTEGER NOT NULL DEFAULT 0,         -- 該月 hq_to_store transfer 數
  item_count               INTEGER NOT NULL DEFAULT 0,         -- 該月 transfer_items 行數
  status                   TEXT NOT NULL DEFAULT 'draft'
                             CHECK (status IN ('draft','confirmed','settled','disputed','cancelled')),
  confirmed_at             TIMESTAMPTZ,
  confirmed_by             UUID,
  settled_at               TIMESTAMPTZ,
  settled_by               UUID,
  generated_vendor_bill_id BIGINT,  -- FK 到 vendor_bills（confirm 時建）
  notes                    TEXT,
  created_by               UUID,
  updated_by               UUID,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, settlement_month, store_id)
);

CREATE INDEX idx_sms_month       ON store_monthly_settlements (tenant_id, settlement_month DESC);
CREATE INDEX idx_sms_store       ON store_monthly_settlements (tenant_id, store_id, settlement_month DESC);
CREATE INDEX idx_sms_status      ON store_monthly_settlements (tenant_id, status);

-- ------------------------------------------------------------
-- 3. store_monthly_settlement_items 明細 (append-only)
-- ------------------------------------------------------------
CREATE TABLE public.store_monthly_settlement_items (
  id                BIGSERIAL PRIMARY KEY,
  tenant_id         UUID NOT NULL,
  settlement_id     BIGINT NOT NULL REFERENCES store_monthly_settlements(id) ON DELETE CASCADE,
  transfer_id       BIGINT NOT NULL REFERENCES transfers(id),
  transfer_item_id  BIGINT NOT NULL REFERENCES transfer_items(id),
  sku_id            BIGINT NOT NULL REFERENCES skus(id),
  qty_received      NUMERIC(18,3) NOT NULL,
  unit_cost         NUMERIC(18,4) NOT NULL,
  line_amount       NUMERIC(18,4) NOT NULL,                  -- qty_received × unit_cost
  received_at       TIMESTAMPTZ NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_smsi_settlement ON store_monthly_settlement_items (settlement_id);
CREATE INDEX idx_smsi_transfer   ON store_monthly_settlement_items (transfer_id);

-- ------------------------------------------------------------
-- 4. Triggers
-- ------------------------------------------------------------
CREATE TRIGGER trg_touch_sms BEFORE UPDATE ON store_monthly_settlements
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TRIGGER trg_no_mut_smsi BEFORE UPDATE OR DELETE ON store_monthly_settlement_items
  FOR EACH ROW EXECUTE FUNCTION forbid_append_only_mutation();

-- ------------------------------------------------------------
-- 5. RLS
-- ------------------------------------------------------------
ALTER TABLE store_monthly_settlements      ENABLE ROW LEVEL SECURITY;
ALTER TABLE store_monthly_settlement_items ENABLE ROW LEVEL SECURITY;

-- HQ 全權；店家只讀自己（比照 transfer_settlements pattern）
CREATE POLICY sms_hq_all ON store_monthly_settlements
  FOR ALL USING (
    tenant_id = (auth.jwt() ->> 'tenant_id')::uuid
    AND (auth.jwt() ->> 'role') IN ('owner','admin','hq_manager','hq_accountant')
  );
CREATE POLICY sms_store_read ON store_monthly_settlements
  FOR SELECT USING (
    tenant_id = (auth.jwt() ->> 'tenant_id')::uuid
    AND (auth.jwt() ->> 'store_id')::bigint = store_id
  );

CREATE POLICY smsi_hq_all ON store_monthly_settlement_items
  FOR ALL USING (
    tenant_id = (auth.jwt() ->> 'tenant_id')::uuid
    AND (auth.jwt() ->> 'role') IN ('owner','admin','hq_manager','hq_accountant')
  );


-- ============================================================
-- 6. RPC: rpc_generate_hq_to_store_settlement
--   產生 / 重算指定月份所有分店的 draft 月結單
--   - 逐家分店掃 hq_to_store 已收貨 transfers (received/closed)
--   - 從 transfer_items.out_movement_id → stock_movements.unit_cost 取成本
--   - 計算 line_amount = qty_received × unit_cost
--   - 已 confirmed/settled 的不重算（避免覆蓋）
-- ============================================================
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
  v_payable        NUMERIC(18,4);
  v_xfer_count     INTEGER;
  v_item_count     INTEGER;
  v_total_stores   INTEGER := 0;
  v_total_amount   NUMERIC(18,4) := 0;
BEGIN
  -- 從 operator 反查 tenant_id（單 tenant 假設）
  SELECT tenant_id INTO v_tenant FROM stores LIMIT 1;
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'no stores found, cannot infer tenant_id';
  END IF;

  -- 逐家分店計算
  FOR v_store IN
    SELECT s.id, s.code, s.name, s.location_id
      FROM stores s
     WHERE s.tenant_id = v_tenant
       AND s.location_id IS NOT NULL
  LOOP
    -- 跳過已 confirmed/settled 的（避免覆蓋）
    IF EXISTS (
      SELECT 1 FROM store_monthly_settlements
       WHERE tenant_id = v_tenant
         AND settlement_month = v_month_start
         AND store_id = v_store.id
         AND status IN ('confirmed','settled')
    ) THEN
      CONTINUE;
    END IF;

    -- 該店該月所有 hq_to_store 已收貨 transfers 的 line_amount 加總
    SELECT
      COALESCE(SUM(ti.qty_received * COALESCE(sm.unit_cost, 0)), 0),
      COUNT(DISTINCT t.id),
      COUNT(ti.id)
      INTO v_payable, v_xfer_count, v_item_count
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

    -- 沒交易就 skip
    IF v_xfer_count = 0 THEN
      -- 但若先前有 draft、刪除（資料消失要反映）
      DELETE FROM store_monthly_settlements
       WHERE tenant_id = v_tenant
         AND settlement_month = v_month_start
         AND store_id = v_store.id
         AND status = 'draft';
      CONTINUE;
    END IF;

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

    -- 重建 items（先清舊、再插新）
    DELETE FROM store_monthly_settlement_items WHERE settlement_id = v_settlement_id;

    INSERT INTO store_monthly_settlement_items (
      tenant_id, settlement_id, transfer_id, transfer_item_id,
      sku_id, qty_received, unit_cost, line_amount, received_at
    )
    SELECT
      v_tenant, v_settlement_id, t.id, ti.id,
      ti.sku_id, ti.qty_received, COALESCE(sm.unit_cost, 0),
      ti.qty_received * COALESCE(sm.unit_cost, 0),
      t.received_at
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

GRANT EXECUTE ON FUNCTION public.rpc_generate_hq_to_store_settlement(DATE, UUID) TO authenticated;

COMMENT ON FUNCTION public.rpc_generate_hq_to_store_settlement IS
  'HQ→店月結算：聚合該月所有分店的 hq_to_store 已收貨貨款，產生 draft store_monthly_settlements。已 confirmed/settled 的不覆蓋。';


-- ============================================================
-- 7. RPC: rpc_confirm_store_monthly_settlement
--   把 draft 轉 confirmed、自動建立 vendor_bill
-- ============================================================
CREATE OR REPLACE FUNCTION public.rpc_confirm_store_monthly_settlement(
  p_settlement_id BIGINT,
  p_operator      UUID
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_s              store_monthly_settlements%ROWTYPE;
  v_supplier_id    BIGINT;
  v_bill_id        BIGINT;
  v_bill_no        TEXT;
  v_now            TIMESTAMPTZ := NOW();
BEGIN
  SELECT * INTO v_s FROM store_monthly_settlements
   WHERE id = p_settlement_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'settlement % not found', p_settlement_id;
  END IF;
  IF v_s.status <> 'draft' THEN
    RAISE EXCEPTION 'settlement % not draft (current: %)', p_settlement_id, v_s.status;
  END IF;
  IF v_s.payable_amount <= 0 THEN
    RAISE EXCEPTION 'settlement % payable_amount must be > 0 (got %)',
      p_settlement_id, v_s.payable_amount;
  END IF;

  -- 確保該店有 supplier_id（on-demand）
  v_supplier_id := public.ensure_store_supplier(v_s.store_id);

  -- 產 bill_no（格式：SMS-YYYYMM-{store_id}-{seq}）
  v_bill_no := 'SMS-' || to_char(v_s.settlement_month, 'YYYYMM')
            || '-' || v_s.store_id::text
            || '-' || nextval('vendor_bills_id_seq')::text;

  -- 建 vendor_bill
  INSERT INTO vendor_bills (
    tenant_id, bill_no, supplier_id,
    source_type, source_id,
    bill_date, due_date, amount,
    status, currency, notes,
    created_by, updated_by
  ) VALUES (
    v_s.tenant_id, v_bill_no, v_supplier_id,
    'store_monthly_settlement', v_s.id,
    v_s.settlement_month + INTERVAL '1 month' - INTERVAL '1 day',  -- bill_date = 月底
    (v_s.settlement_month + INTERVAL '2 month' - INTERVAL '1 day')::DATE, -- due_date 次月底
    v_s.payable_amount,
    'pending', 'TWD',
    format('店月結算 %s %s', to_char(v_s.settlement_month, 'YYYY-MM'),
           (SELECT name FROM stores WHERE id = v_s.store_id)),
    p_operator, p_operator
  ) RETURNING id INTO v_bill_id;

  -- 更新 settlement 狀態 + FK
  UPDATE store_monthly_settlements
     SET status                   = 'confirmed',
         confirmed_at             = v_now,
         confirmed_by             = p_operator,
         generated_vendor_bill_id = v_bill_id,
         updated_by               = p_operator,
         updated_at               = v_now
   WHERE id = p_settlement_id;

  RETURN jsonb_build_object(
    'settlement_id', p_settlement_id,
    'vendor_bill_id', v_bill_id,
    'bill_no',       v_bill_no,
    'supplier_id',   v_supplier_id,
    'amount',        v_s.payable_amount
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.rpc_confirm_store_monthly_settlement(BIGINT, UUID) TO authenticated;

COMMENT ON FUNCTION public.rpc_confirm_store_monthly_settlement IS
  '把 draft 月結單推到 confirmed、自動建 vendor_bill 入 AP。store→supplier 用 ensure_store_supplier on-demand 建立。';
