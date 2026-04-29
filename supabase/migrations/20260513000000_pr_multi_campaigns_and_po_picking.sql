-- ============================================================
-- 採購撿貨流程重構 — Schema 變更
--
-- 三個改變：
-- 1. PR 改成多對多 campaigns（既有 source_close_date 保留向下相容）
-- 2. picking_waves 加 source_po_id（撿貨單對應一個 PO）
-- 3. 兩個新 view：v_pr_purchased_history、v_picking_demand_by_po
-- ============================================================

-- ------------------------------------------------------------
-- 1. purchase_request_campaigns: PR ↔ campaigns 多對多
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.purchase_request_campaigns (
  pr_id        BIGINT NOT NULL REFERENCES purchase_requests(id) ON DELETE CASCADE,
  campaign_id  BIGINT NOT NULL REFERENCES group_buy_campaigns(id),
  tenant_id    UUID NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (pr_id, campaign_id)
);

CREATE INDEX IF NOT EXISTS idx_prc_campaign ON purchase_request_campaigns (campaign_id);
CREATE INDEX IF NOT EXISTS idx_prc_tenant   ON purchase_request_campaigns (tenant_id);

ALTER TABLE purchase_request_campaigns ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS auth_read_prc ON purchase_request_campaigns;
CREATE POLICY auth_read_prc ON purchase_request_campaigns
  FOR SELECT USING (tenant_id = (auth.jwt() ->> 'tenant_id')::uuid);

DROP POLICY IF EXISTS auth_write_prc ON purchase_request_campaigns;
CREATE POLICY auth_write_prc ON purchase_request_campaigns
  FOR ALL USING (tenant_id = (auth.jwt() ->> 'tenant_id')::uuid)
            WITH CHECK (tenant_id = (auth.jwt() ->> 'tenant_id')::uuid);

COMMENT ON TABLE purchase_request_campaigns IS
  '採購單 ↔ 開團活動 多對多關聯（取代既有 source_close_date 單一日期）';


-- ------------------------------------------------------------
-- 2. picking_waves 加 source_po_id（撿貨單對應一個 PO）
-- ------------------------------------------------------------
ALTER TABLE picking_waves
  ADD COLUMN IF NOT EXISTS source_po_id BIGINT REFERENCES purchase_orders(id);

CREATE INDEX IF NOT EXISTS idx_picking_waves_po ON picking_waves (source_po_id)
  WHERE source_po_id IS NOT NULL;

COMMENT ON COLUMN picking_waves.source_po_id IS
  '該撿貨單對應的 PO（按 PO 維度撿貨）。舊資料為 NULL';


-- ------------------------------------------------------------
-- 3. v_pr_purchased_history — PR item 顯示「該 sku 在該 campaign 已採購過多少」
--   給 PR 編輯頁顯示「已採購過數量」用、避免重複採購
-- ------------------------------------------------------------
DROP VIEW IF EXISTS public.v_pr_purchased_history CASCADE;

CREATE OR REPLACE VIEW public.v_pr_purchased_history AS
SELECT
  pr.tenant_id,
  pr.id            AS current_pr_id,
  prc.campaign_id,
  pri.sku_id,
  -- 該 campaign × sku 在「其他已通過 PR」總計 qty_requested（不含當前 PR 自己）
  COALESCE(SUM(other_pri.qty_requested) FILTER (
    WHERE other_pr.id <> pr.id
      AND other_pr.status NOT IN ('cancelled')
      AND other_pr.review_status = 'approved'
  ), 0) AS purchased_so_far
FROM purchase_requests pr
JOIN purchase_request_campaigns prc ON prc.pr_id = pr.id
JOIN purchase_request_items pri ON pri.pr_id = pr.id
LEFT JOIN purchase_request_campaigns other_prc
  ON other_prc.campaign_id = prc.campaign_id
LEFT JOIN purchase_requests other_pr
  ON other_pr.id = other_prc.pr_id
LEFT JOIN purchase_request_items other_pri
  ON other_pri.pr_id = other_pr.id
 AND other_pri.sku_id = pri.sku_id
GROUP BY pr.tenant_id, pr.id, prc.campaign_id, pri.sku_id;

GRANT SELECT ON public.v_pr_purchased_history TO authenticated;

COMMENT ON VIEW public.v_pr_purchased_history IS
  'PR 編輯頁用：顯示該 (campaign, sku) 在其他已通過 PR 已採購過多少';


-- ------------------------------------------------------------
-- 4. v_picking_demand_by_po — PO × SKU × store 矩陣
--   工作站主視圖：只列「未派完」的 PO 行
--
--   邏輯：
--   - 只看 status IN (sent, partially_received, fully_received) 的 PO
--   - 該 (po, sku) 的進貨量 = SUM(gri.qty_received) where gr.status='confirmed'
--   - 該 (po, sku, store) 的訂單需求量 =
--       透過 PR 的 campaigns 找該 store 的 customer_orders 需求
--   - 該 (po, sku, store) 已撿貨 wave 量 = SUM(pwi.qty) WHERE wave.source_po_id = po.id
--   - 該 (po, sku, store) 已派貨量（C 選項）=
--       SUM(transfer_items.qty_received) WHERE transfer linked to wave AND status='received'
--   - 過濾條件：未派完 = SUM(shipped_qty) < SUM(gr_qty)
-- ------------------------------------------------------------
DROP VIEW IF EXISTS public.v_picking_demand_by_po CASCADE;

CREATE OR REPLACE VIEW public.v_picking_demand_by_po AS
WITH po_skus AS (
  -- 每個 PO 的 SKU 清單
  SELECT
    po.id            AS po_id,
    po.tenant_id,
    po.po_no,
    po.supplier_id,
    poi.id           AS po_item_id,
    poi.sku_id,
    poi.qty_ordered
  FROM purchase_orders po
  JOIN purchase_order_items poi ON poi.po_id = po.id
  WHERE po.status IN ('sent', 'partially_received', 'fully_received')
),
gr_qty AS (
  -- 各 (po_item) 已進貨 confirmed 量
  SELECT
    gri.po_item_id,
    SUM(gri.qty_received) AS gr_qty
  FROM goods_receipt_items gri
  JOIN goods_receipts gr ON gr.id = gri.gr_id
  WHERE gr.status = 'confirmed'
  GROUP BY gri.po_item_id
),
po_campaigns AS (
  -- PO 來源的 campaigns（透過 PR.po_item_id 反查）
  SELECT DISTINCT
    poi.id AS po_item_id,
    prc.campaign_id
  FROM purchase_order_items poi
  JOIN purchase_request_items pri ON pri.po_item_id = poi.id
  JOIN purchase_requests pr ON pr.id = pri.pr_id
  JOIN purchase_request_campaigns prc ON prc.pr_id = pr.id
),
store_demand AS (
  -- 每個 (po_item, store) 的訂單需求量
  SELECT
    pc.po_item_id,
    co.pickup_store_id AS store_id,
    SUM(coi.qty) AS demand_qty
  FROM po_campaigns pc
  JOIN customer_orders co ON co.campaign_id = pc.campaign_id
                         AND co.status NOT IN ('cancelled','expired','transferred_out')
                         AND co.transferred_from_order_id IS NULL  -- 排除衍生訂單
  JOIN customer_order_items coi ON coi.order_id = co.id
                               AND coi.status NOT IN ('cancelled','expired')
  JOIN purchase_order_items poi ON poi.id = pc.po_item_id
                               AND poi.sku_id = coi.sku_id
  GROUP BY pc.po_item_id, co.pickup_store_id
),
wave_qty AS (
  -- 每個 (po, sku, store) 已撿貨 wave 量
  SELECT
    pw.source_po_id,
    pwi.sku_id,
    pwi.store_id,
    SUM(pwi.qty) AS wave_qty
  FROM picking_wave_items pwi
  JOIN picking_waves pw ON pw.id = pwi.wave_id
  WHERE pw.status <> 'cancelled'
    AND pw.source_po_id IS NOT NULL
  GROUP BY pw.source_po_id, pwi.sku_id, pwi.store_id
),
shipped_qty AS (
  -- 每個 (po, sku, store) 已派貨 transfer received 量
  SELECT
    pw.source_po_id,
    ti.sku_id,
    -- 從 transfer_no 'WAVE-{wave_id}-S{store_id}' 反推 store
    (substring(t.transfer_no FROM 'WAVE-\d+-S(\d+)'))::BIGINT AS store_id,
    SUM(ti.qty_received) AS shipped_qty
  FROM transfers t
  JOIN transfer_items ti ON ti.transfer_id = t.id
  JOIN picking_waves pw ON t.transfer_no LIKE 'WAVE-' || pw.id || '-S%'
  WHERE t.transfer_type = 'hq_to_store'
    AND t.status IN ('received', 'closed')
    AND pw.source_po_id IS NOT NULL
  GROUP BY pw.source_po_id, ti.sku_id, store_id
)
SELECT
  ps.tenant_id,
  ps.po_id,
  ps.po_no,
  ps.supplier_id,
  ps.po_item_id,
  ps.sku_id,
  s.sku_code,
  COALESCE(s.product_name, '') || COALESCE(' ' || NULLIF(s.variant_name,''), '') AS sku_label,
  ps.qty_ordered,
  COALESCE(g.gr_qty, 0)::NUMERIC AS gr_qty,
  sd.store_id,
  st.code AS store_code,
  st.name AS store_name,
  COALESCE(sd.demand_qty, 0)::NUMERIC AS demand_qty,
  COALESCE(wq.wave_qty, 0)::NUMERIC AS wave_qty,
  COALESCE(sq.shipped_qty, 0)::NUMERIC AS shipped_qty
FROM po_skus ps
JOIN skus s ON s.id = ps.sku_id
LEFT JOIN gr_qty g ON g.po_item_id = ps.po_item_id
LEFT JOIN store_demand sd ON sd.po_item_id = ps.po_item_id
LEFT JOIN stores st ON st.id = sd.store_id
LEFT JOIN wave_qty wq ON wq.source_po_id = ps.po_id AND wq.sku_id = ps.sku_id AND wq.store_id = sd.store_id
LEFT JOIN shipped_qty sq ON sq.source_po_id = ps.po_id AND sq.sku_id = ps.sku_id AND sq.store_id = sd.store_id
WHERE
  -- 只列「有進貨」且「未派完」的 (po, sku, store)
  COALESCE(g.gr_qty, 0) > 0
  AND COALESCE(sq.shipped_qty, 0) < COALESCE(g.gr_qty, 0);

GRANT SELECT ON public.v_picking_demand_by_po TO authenticated;

COMMENT ON VIEW public.v_picking_demand_by_po IS
  '撿貨工作站新主視圖：按 PO × SKU × store 顯示未派完的撿貨需求。「派完」= shipped_qty >= gr_qty。';
