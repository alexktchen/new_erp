-- ============================================================
-- HQ 應收帳款 — 分店欠 HQ 的 ledger
--
-- 業態：總倉賣斷給分店、月結時分店欠 HQ 貨款
-- 從 HQ 視角：這是「應收」(receivable)、不是「應付」(payable)
--
-- 之前錯把店月結算寫進 vendor_bills（HQ 應付廠商）— 語義反了。
-- 修正：新建 store_receivables 表專給店月結算用。
--
-- vendor_bills 維持只給「真的 HQ 應付廠商」(PO/GR/manual 觸發) 用。
-- ============================================================

-- ------------------------------------------------------------
-- 1. store_receivables 主檔
-- ------------------------------------------------------------
CREATE TABLE public.store_receivables (
  id                BIGSERIAL PRIMARY KEY,
  tenant_id         UUID NOT NULL,
  receivable_no     TEXT NOT NULL,                 -- 應收單號 SR-YYYYMM-{store}-{seq}
  store_id          BIGINT NOT NULL REFERENCES stores(id),
  source_type       TEXT NOT NULL DEFAULT 'store_monthly_settlement'
                      CHECK (source_type IN ('store_monthly_settlement','manual')),
  source_id         BIGINT,                        -- store_monthly_settlements.id
  bill_date         DATE NOT NULL,                 -- 帳單日（通常是月底）
  due_date          DATE NOT NULL,                 -- 到期日
  amount            NUMERIC(18,4) NOT NULL CHECK (amount > 0),
  paid_amount       NUMERIC(18,4) NOT NULL DEFAULT 0
                      CHECK (paid_amount >= 0 AND paid_amount <= amount),
  status            TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','partially_paid','paid','cancelled','disputed')),
  currency          TEXT NOT NULL DEFAULT 'TWD',
  notes             TEXT,
  created_by        UUID,
  updated_by        UUID,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, receivable_no)
);

CREATE INDEX idx_store_recv_store      ON store_receivables (tenant_id, store_id, bill_date DESC);
CREATE INDEX idx_store_recv_status     ON store_receivables (tenant_id, status);
CREATE INDEX idx_store_recv_due_date   ON store_receivables (tenant_id, due_date);
CREATE INDEX idx_store_recv_source     ON store_receivables (tenant_id, source_type, source_id);

-- ------------------------------------------------------------
-- 2. store_receivable_payments 收款記錄
-- ------------------------------------------------------------
CREATE TABLE public.store_receivable_payments (
  id                BIGSERIAL PRIMARY KEY,
  tenant_id         UUID NOT NULL,
  payment_no        TEXT NOT NULL,
  receivable_id     BIGINT NOT NULL REFERENCES store_receivables(id),
  amount            NUMERIC(18,4) NOT NULL CHECK (amount > 0),
  method            TEXT NOT NULL DEFAULT 'bank_transfer'
                      CHECK (method IN ('cash','bank_transfer','check','offset','other')),
  paid_at           DATE NOT NULL,
  notes             TEXT,
  created_by        UUID,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, payment_no)
);

CREATE INDEX idx_store_recv_pay_receivable ON store_receivable_payments (receivable_id);

-- ------------------------------------------------------------
-- 3. RLS
-- ------------------------------------------------------------
ALTER TABLE store_receivables          ENABLE ROW LEVEL SECURITY;
ALTER TABLE store_receivable_payments  ENABLE ROW LEVEL SECURITY;

CREATE POLICY auth_read_sr  ON store_receivables          FOR SELECT USING (tenant_id = (auth.jwt() ->> 'tenant_id')::uuid);
CREATE POLICY auth_write_sr ON store_receivables          FOR ALL    USING (tenant_id = (auth.jwt() ->> 'tenant_id')::uuid)
                                                                     WITH CHECK (tenant_id = (auth.jwt() ->> 'tenant_id')::uuid);
CREATE POLICY auth_read_srp ON store_receivable_payments  FOR SELECT USING (tenant_id = (auth.jwt() ->> 'tenant_id')::uuid);
CREATE POLICY auth_write_srp ON store_receivable_payments FOR ALL    USING (tenant_id = (auth.jwt() ->> 'tenant_id')::uuid)
                                                                     WITH CHECK (tenant_id = (auth.jwt() ->> 'tenant_id')::uuid);

-- ------------------------------------------------------------
-- 4. 觸發 updated_at
-- ------------------------------------------------------------
CREATE TRIGGER trg_touch_sr BEFORE UPDATE ON store_receivables
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ------------------------------------------------------------
-- 5. store_monthly_settlements 改 FK：generated_vendor_bill_id → generated_receivable_id
-- ------------------------------------------------------------
ALTER TABLE store_monthly_settlements
  ADD COLUMN IF NOT EXISTS generated_receivable_id BIGINT REFERENCES store_receivables(id);

COMMENT ON COLUMN store_monthly_settlements.generated_receivable_id IS
  'confirm 後產生的應收單 id（HQ 應收分店貨款）';
COMMENT ON COLUMN store_monthly_settlements.generated_vendor_bill_id IS
  '已棄用 — 之前錯放在 vendor_bills（HQ 應付）；改用 generated_receivable_id';


-- ------------------------------------------------------------
-- 6. 重寫 rpc_confirm_store_monthly_settlement
--   不再建 vendor_bill、改建 store_receivable
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rpc_confirm_store_monthly_settlement(
  p_settlement_id BIGINT,
  p_operator      UUID
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_s              store_monthly_settlements%ROWTYPE;
  v_recv_id        BIGINT;
  v_recv_no        TEXT;
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
    RAISE EXCEPTION 'settlement % amount must be > 0 (got %)',
      p_settlement_id, v_s.payable_amount;
  END IF;

  -- 產 receivable_no（格式：SR-YYYYMM-{store}-{seq}）
  v_recv_no := 'SR-' || to_char(v_s.settlement_month, 'YYYYMM')
            || '-' || v_s.store_id::text
            || '-' || nextval('store_receivables_id_seq')::text;

  -- 建 store_receivable
  INSERT INTO store_receivables (
    tenant_id, receivable_no, store_id,
    source_type, source_id,
    bill_date, due_date, amount,
    status, currency, notes,
    created_by, updated_by
  ) VALUES (
    v_s.tenant_id, v_recv_no, v_s.store_id,
    'store_monthly_settlement', v_s.id,
    (v_s.settlement_month + INTERVAL '1 month' - INTERVAL '1 day')::DATE,  -- 月底
    (v_s.settlement_month + INTERVAL '2 month' - INTERVAL '1 day')::DATE,  -- 次月底
    v_s.payable_amount,
    'pending', 'TWD',
    format('店月結算 %s %s', to_char(v_s.settlement_month, 'YYYY-MM'),
           (SELECT name FROM stores WHERE id = v_s.store_id)),
    p_operator, p_operator
  ) RETURNING id INTO v_recv_id;

  -- 更新 settlement 狀態 + FK
  UPDATE store_monthly_settlements
     SET status                  = 'confirmed',
         confirmed_at            = v_now,
         confirmed_by            = p_operator,
         generated_receivable_id = v_recv_id,
         updated_by              = p_operator,
         updated_at              = v_now
   WHERE id = p_settlement_id;

  RETURN jsonb_build_object(
    'settlement_id', p_settlement_id,
    'receivable_id', v_recv_id,
    'receivable_no', v_recv_no,
    'store_id',      v_s.store_id,
    'amount',        v_s.payable_amount
  );
END;
$$;

COMMENT ON FUNCTION public.rpc_confirm_store_monthly_settlement IS
  '把 draft 月結單推到 confirmed、自動建 store_receivable（HQ 應收分店貨款）。';

-- ------------------------------------------------------------
-- 7. RPC：紀錄收款（標記分店付款）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rpc_record_store_receivable_payment(
  p_receivable_id BIGINT,
  p_amount        NUMERIC,
  p_method        TEXT,
  p_paid_at       DATE,
  p_operator      UUID,
  p_notes         TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_r             store_receivables%ROWTYPE;
  v_payment_id    BIGINT;
  v_payment_no    TEXT;
  v_new_paid      NUMERIC(18,4);
  v_new_status    TEXT;
  v_now           TIMESTAMPTZ := NOW();
BEGIN
  SELECT * INTO v_r FROM store_receivables
   WHERE id = p_receivable_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'receivable % not found', p_receivable_id;
  END IF;
  IF v_r.status IN ('paid','cancelled') THEN
    RAISE EXCEPTION 'receivable % is %, cannot accept payment', p_receivable_id, v_r.status;
  END IF;
  IF p_amount <= 0 THEN
    RAISE EXCEPTION 'amount must be > 0';
  END IF;
  IF v_r.paid_amount + p_amount > v_r.amount THEN
    RAISE EXCEPTION 'over-payment: paid=% + new=% > amount=%',
      v_r.paid_amount, p_amount, v_r.amount;
  END IF;

  v_payment_no := 'SRP-' || to_char(p_paid_at, 'YYYYMMDD') || '-' || nextval('store_receivable_payments_id_seq')::text;

  INSERT INTO store_receivable_payments (
    tenant_id, payment_no, receivable_id, amount, method, paid_at, notes, created_by
  ) VALUES (
    v_r.tenant_id, v_payment_no, p_receivable_id, p_amount, p_method, p_paid_at, p_notes, p_operator
  ) RETURNING id INTO v_payment_id;

  v_new_paid := v_r.paid_amount + p_amount;
  v_new_status := CASE WHEN v_new_paid >= v_r.amount THEN 'paid' ELSE 'partially_paid' END;

  UPDATE store_receivables
     SET paid_amount = v_new_paid,
         status      = v_new_status,
         updated_by  = p_operator,
         updated_at  = v_now
   WHERE id = p_receivable_id;

  RETURN jsonb_build_object(
    'receivable_id', p_receivable_id,
    'payment_id',    v_payment_id,
    'payment_no',    v_payment_no,
    'paid_amount',   v_new_paid,
    'new_status',    v_new_status
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.rpc_record_store_receivable_payment(BIGINT, NUMERIC, TEXT, DATE, UUID, TEXT) TO authenticated;

COMMENT ON FUNCTION public.rpc_record_store_receivable_payment IS
  '記錄分店付款給 HQ；自動更新 store_receivable.paid_amount 跟 status。';
