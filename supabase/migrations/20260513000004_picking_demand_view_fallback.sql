-- ============================================================
-- v_picking_demand_by_po 加 fallback：PR join 表空時走 source_close_date
--
-- 問題：PR2604290031 (close_date=2026-05-02) 的 purchase_request_campaigns
-- 是空的（backfill 那天沒 closed campaigns）→ view 找不到 store demand →
-- store_id 全 null → 前端 skip 該 PO。
--
-- 修正：po_campaigns CTE 加 UNION fallback：
--   如果 PR 沒 join 表記錄、改走 PR.source_close_date 找同日 campaigns
-- ============================================================

DROP VIEW IF EXISTS public.v_picking_demand_by_po CASCADE;

CREATE OR REPLACE VIEW public.v_picking_demand_by_po AS
WITH po_skus AS (
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
  SELECT gri.po_item_id, SUM(gri.qty_received) AS gr_qty
    FROM goods_receipt_items gri
    JOIN goods_receipts gr ON gr.id = gri.gr_id
   WHERE gr.status = 'confirmed'
   GROUP BY gri.po_item_id
),
po_campaigns AS (
  -- 路徑 1: 透過 purchase_request_campaigns join 表
  SELECT DISTINCT poi.id AS po_item_id, prc.campaign_id
    FROM purchase_order_items poi
    JOIN purchase_request_items pri ON pri.po_item_id = poi.id
    JOIN purchase_requests pr ON pr.id = pri.pr_id
    JOIN purchase_request_campaigns prc ON prc.pr_id = pr.id

  UNION

  -- 路徑 2 fallback: PR 沒 join 表記錄、走 source_close_date 找同日 closed campaigns
  SELECT DISTINCT poi.id AS po_item_id, gbc.id AS campaign_id
    FROM purchase_order_items poi
    JOIN purchase_request_items pri ON pri.po_item_id = poi.id
    JOIN purchase_requests pr ON pr.id = pri.pr_id
    JOIN group_buy_campaigns gbc
      ON gbc.tenant_id = pr.tenant_id
     AND DATE(gbc.end_at AT TIME ZONE 'Asia/Taipei') = pr.source_close_date
     AND gbc.status NOT IN ('cancelled')
   WHERE pr.source_close_date IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM purchase_request_campaigns prc2 WHERE prc2.pr_id = pr.id)
),
store_demand AS (
  SELECT
    pc.po_item_id,
    co.pickup_store_id AS store_id,
    SUM(coi.qty) AS demand_qty
  FROM po_campaigns pc
  JOIN customer_orders co ON co.campaign_id = pc.campaign_id
                         AND co.status NOT IN ('cancelled','expired','transferred_out')
                         AND co.transferred_from_order_id IS NULL
  JOIN customer_order_items coi ON coi.order_id = co.id
                               AND coi.status NOT IN ('cancelled','expired')
  JOIN purchase_order_items poi ON poi.id = pc.po_item_id
                               AND poi.sku_id = coi.sku_id
  GROUP BY pc.po_item_id, co.pickup_store_id
),
wave_qty AS (
  SELECT
    pw.source_po_id,
    pwi.sku_id,
    pwi.store_id,
    SUM(pwi.qty) AS wave_qty
  FROM picking_wave_items pwi
  JOIN picking_waves pw ON pw.id = pwi.wave_id
  WHERE pw.status <> 'cancelled' AND pw.source_po_id IS NOT NULL
  GROUP BY pw.source_po_id, pwi.sku_id, pwi.store_id
),
shipped_qty AS (
  SELECT
    pw.source_po_id,
    ti.sku_id,
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
  COALESCE(g.gr_qty, 0) > 0
  AND COALESCE(sq.shipped_qty, 0) < COALESCE(g.gr_qty, 0);

GRANT SELECT ON public.v_picking_demand_by_po TO authenticated;

COMMENT ON VIEW public.v_picking_demand_by_po IS
  '撿貨工作站主視圖 v2：PO × SKU × store 矩陣。po_campaigns 加 fallback：PR 無 join 表時走 source_close_date 找同日 campaigns';
