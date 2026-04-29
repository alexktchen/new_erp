-- ============================================================================
-- v_picking_demand_by_close_date 修正：用 transferred_from_order_id 判定
--
-- 問題：上一支 migration 用 NOT EXISTS (transfers WHERE customer_order_id)
-- 排除衍生訂單。但「經 HQ 轉移」的訂單在「派貨」之前是 pending 狀態、
-- 還沒產生 transfer 記錄、所以被誤判成需要 HQ 撿貨。
--
-- 修正：直接用 customer_orders.transferred_from_order_id IS NULL 判斷
-- 凡是衍生訂單 (TF000X) 都不該走批次撿貨流程、無論是否已派貨。
-- ============================================================================

DROP VIEW IF EXISTS public.v_picking_demand_by_close_date CASCADE;

CREATE OR REPLACE VIEW public.v_picking_demand_by_close_date AS
SELECT
  gbc.tenant_id,
  DATE(gbc.end_at AT TIME ZONE 'Asia/Taipei') AS close_date,
  coi.sku_id,
  COALESCE(s.product_name, '') || COALESCE(' ' || NULLIF(s.variant_name,''), '') AS sku_label,
  s.sku_code,
  co.pickup_store_id AS store_id,
  st.code AS store_code,
  st.name AS store_name,
  SUM(coi.qty) AS demand_qty,
  COUNT(DISTINCT co.id) AS order_count,
  array_agg(DISTINCT gbc.id) AS campaign_ids,
  COALESCE(SUM(gri.qty_received) FILTER (WHERE gr.status = 'confirmed'), 0)::NUMERIC AS received_qty,
  COALESCE(picked_agg.picked_qty, 0)::NUMERIC AS picked_qty,
  array_agg(DISTINCT po.po_no) FILTER (WHERE po.po_no IS NOT NULL) AS po_numbers,
  array_agg(DISTINCT co.order_no) FILTER (WHERE co.order_no IS NOT NULL) AS order_numbers
FROM group_buy_campaigns gbc
JOIN customer_orders co ON co.campaign_id = gbc.id
                       AND co.status NOT IN ('cancelled','expired','transferred_out')
                       -- 排除「衍生訂單」(從別店轉移而來)：transferred_from_order_id 非 NULL
                       -- 這類訂單走 transfer 路徑（互助 / 空中轉）、不該由 HQ 批次撿貨
                       AND co.transferred_from_order_id IS NULL
JOIN customer_order_items coi ON coi.order_id = co.id
                             AND coi.status NOT IN ('cancelled','expired')
JOIN skus s ON s.id = coi.sku_id
JOIN stores st ON st.id = co.pickup_store_id
LEFT JOIN goods_receipt_items gri ON gri.sku_id = coi.sku_id
LEFT JOIN goods_receipts gr ON gr.id = gri.gr_id AND gr.tenant_id = gbc.tenant_id AND gr.status = 'confirmed'
LEFT JOIN purchase_orders po ON po.id = gr.po_id
LEFT JOIN LATERAL (
  SELECT SUM(COALESCE(pwi.picked_qty, 0)) AS picked_qty
    FROM picking_wave_items pwi
    JOIN picking_waves pw ON pw.id = pwi.wave_id
    JOIN group_buy_campaigns gbc2 ON gbc2.id = pwi.campaign_id
   WHERE pwi.tenant_id = gbc.tenant_id
     AND pwi.sku_id = coi.sku_id
     AND pwi.store_id = co.pickup_store_id
     AND pw.status <> 'cancelled'
     AND DATE(gbc2.end_at AT TIME ZONE 'Asia/Taipei') = DATE(gbc.end_at AT TIME ZONE 'Asia/Taipei')
) picked_agg ON TRUE
WHERE gbc.status NOT IN ('cancelled')
  AND EXISTS (
    SELECT 1
      FROM purchase_request_items pri
      JOIN purchase_requests pr ON pr.id = pri.pr_id
     WHERE pr.tenant_id = gbc.tenant_id
       AND pr.source_close_date = DATE(gbc.end_at AT TIME ZONE 'Asia/Taipei')
       AND pri.sku_id = coi.sku_id
       AND pri.po_item_id IS NOT NULL
       AND pr.status NOT IN ('cancelled')
  )
GROUP BY
  gbc.tenant_id,
  DATE(gbc.end_at AT TIME ZONE 'Asia/Taipei'),
  coi.sku_id, s.product_name, s.variant_name, s.sku_code,
  co.pickup_store_id, st.code, st.name,
  picked_agg.picked_qty;

GRANT SELECT ON public.v_picking_demand_by_close_date TO authenticated;

COMMENT ON VIEW public.v_picking_demand_by_close_date IS
  '撿貨工作站需求矩陣：排除衍生訂單 (transferred_from_order_id IS NOT NULL)、避免重複撿貨。';
