-- ============================================================
-- v_pr_progress 修正：transfer 計算改用 picking_waves.source_po_id 直接 join
--
-- 問題：close_date 型 PR 之間互相不排除、同日多張 close_date PR 都會看到
-- 同一份 transfers、導致 PR2604290034 還沒拆 PO 就顯示「已派貨」。
--
-- 修正：transfer 嚴格用「PR → PO_items → wave (透過 source_po_id) → transfer」
-- 連結。PR 沒拆 PO 就 transfer_total = 0。
-- ============================================================

DROP VIEW IF EXISTS public.v_pr_progress CASCADE;

CREATE OR REPLACE VIEW public.v_pr_progress AS
SELECT
  pr.id AS pr_id,
  pr.tenant_id,
  pr.source_close_date,
  COALESCE(po_agg.po_total, 0::bigint) AS po_total,
  COALESCE(po_agg.po_sent, 0::bigint) AS po_sent,
  COALESCE(po_agg.po_received_fully, 0::bigint) AS po_received_fully,
  COALESCE(xfer_agg.transfer_total, 0::bigint) AS transfer_total,
  COALESCE(xfer_agg.transfer_shipped, 0::bigint) AS transfer_shipped,
  COALESCE(xfer_agg.transfer_delivered, 0::bigint) AS transfer_delivered,
  COALESCE(item_agg.item_count, 0::bigint) AS item_count,
  COALESCE(item_agg.unassigned_supplier_count, 0::bigint) AS unassigned_supplier_count,
  CASE
    WHEN pr.source_close_date IS NULL THEN false
    WHEN cmp.total_campaigns = 0 THEN false
    ELSE cmp.completed_campaigns = cmp.total_campaigns
  END AS all_campaigns_finalized
FROM purchase_requests pr
LEFT JOIN LATERAL (
  SELECT
    count(DISTINCT po.id) AS po_total,
    count(DISTINCT po.id) FILTER (
      WHERE po.status = ANY (ARRAY['sent','partially_received','fully_received','closed'])
    ) AS po_sent,
    count(DISTINCT po.id) FILTER (
      WHERE po.status = ANY (ARRAY['fully_received','closed'])
    ) AS po_received_fully
  FROM purchase_request_items pri
  JOIN purchase_order_items poi ON poi.id = pri.po_item_id
  JOIN purchase_orders po ON po.id = poi.po_id
  WHERE pri.pr_id = pr.id
) po_agg ON true
LEFT JOIN LATERAL (
  -- transfers 計算：嚴格走 PR → pri.po_item_id → poi.po_id → pw.source_po_id → transfer
  -- 這樣 close_date PR 之間不會互相串水
  SELECT
    count(DISTINCT t.id) AS transfer_total,
    count(DISTINCT t.id) FILTER (
      WHERE t.status = ANY (ARRAY['shipped','received','closed'])
    ) AS transfer_shipped,
    count(DISTINCT t.id) FILTER (
      WHERE t.status = ANY (ARRAY['received','closed'])
    ) AS transfer_delivered
  FROM purchase_request_items pri
  JOIN purchase_order_items poi ON poi.id = pri.po_item_id
  JOIN picking_waves pw ON pw.source_po_id = poi.po_id
  JOIN transfers t
    ON t.tenant_id = pr.tenant_id
   AND t.transfer_type = 'hq_to_store'
   AND t.transfer_no LIKE 'WAVE-' || pw.id || '-S%'
  WHERE pri.pr_id = pr.id
    AND pri.po_item_id IS NOT NULL
) xfer_agg ON true
LEFT JOIN LATERAL (
  SELECT
    count(*) AS item_count,
    count(*) FILTER (WHERE pri.suggested_supplier_id IS NULL) AS unassigned_supplier_count
  FROM purchase_request_items pri
  WHERE pri.pr_id = pr.id
) item_agg ON true
LEFT JOIN LATERAL (
  SELECT
    count(*) AS total_campaigns,
    count(*) FILTER (WHERE gbc.status = 'completed') AS completed_campaigns
  FROM group_buy_campaigns gbc
  WHERE gbc.tenant_id = pr.tenant_id
    AND pr.source_close_date IS NOT NULL
    AND date(gbc.end_at AT TIME ZONE 'Asia/Taipei') = pr.source_close_date
    AND gbc.status <> 'cancelled'
) cmp ON true;

GRANT SELECT ON public.v_pr_progress TO authenticated;

COMMENT ON VIEW public.v_pr_progress IS
  'PR 進度（含 PO/Transfer 聚合）。transfer 計算嚴格走 pr → pri.po_item_id → poi.po_id → pw.source_po_id；PR 沒拆 PO transfer_total=0。';
