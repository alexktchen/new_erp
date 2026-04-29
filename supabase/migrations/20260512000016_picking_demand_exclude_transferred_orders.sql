-- ============================================================================
-- v_picking_demand_by_close_date: 排除已透過互助/空中轉處理的訂單
--
-- 問題：訂單轉移後（互助 leg-2 hq_to_store 或空中轉 store_to_store）、
-- 衍生訂單 (TF0002/TF0003 等) 的 status='shipping'/'ready'、
-- 但貨物已透過 transfer 流程送到分店、不需要 HQ 再撿一次。
--
-- 但 view 把這些 orders 也算進 demand_qty、導致「批次撿貨工作站」誤顯示
-- 已經有 transfer 流程的 SKU。
--
-- 修正：排除「customer_order_id 已關聯到任一 transfer」的 orders
--   (不論 transfer status — 因為一旦建立 transfer 就走別的路徑)
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
                       -- 新增：排除已走 transfer 路徑的訂單（互助/空中轉衍生訂單）
                       AND NOT EXISTS (
                         SELECT 1 FROM transfers t
                          WHERE t.customer_order_id = co.id
                            AND t.tenant_id = co.tenant_id
                            AND t.status NOT IN ('cancelled')
                       )
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
  '撿貨工作站需求矩陣：排除已走 transfer 路徑（互助/空中轉）的衍生訂單、避免重複撿貨。';
