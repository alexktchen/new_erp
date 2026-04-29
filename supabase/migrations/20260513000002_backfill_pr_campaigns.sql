-- ============================================================
-- Backfill purchase_request_campaigns 從既有 PR
--
-- 既有 PR 走兩種路徑：
-- 1. source_type='campaign' + source_campaign_id → 直接 join
-- 2. source_type='close_date' + source_close_date → 找該日期所有 closed campaigns
-- ============================================================

-- 路徑 1: campaign 型 PR
INSERT INTO purchase_request_campaigns (pr_id, campaign_id, tenant_id)
SELECT pr.id, pr.source_campaign_id, pr.tenant_id
  FROM purchase_requests pr
 WHERE pr.source_type = 'campaign'
   AND pr.source_campaign_id IS NOT NULL
   AND pr.status NOT IN ('cancelled')
ON CONFLICT (pr_id, campaign_id) DO NOTHING;

-- 路徑 2: close_date 型 PR
INSERT INTO purchase_request_campaigns (pr_id, campaign_id, tenant_id)
SELECT pr.id, gbc.id, pr.tenant_id
  FROM purchase_requests pr
  JOIN group_buy_campaigns gbc
    ON gbc.tenant_id = pr.tenant_id
   AND DATE(gbc.end_at AT TIME ZONE 'Asia/Taipei') = pr.source_close_date
   AND gbc.status NOT IN ('cancelled')
 WHERE pr.source_type = 'close_date'
   AND pr.source_close_date IS NOT NULL
   AND pr.status NOT IN ('cancelled')
ON CONFLICT (pr_id, campaign_id) DO NOTHING;

-- ============================================================
-- 同時 backfill picking_waves.source_po_id
-- 既有 wave 透過 picking_wave_items.campaign_id → PR → PO 反推
-- 但因為 wave 可能跨多 PO、只填「最常見」的那個 PO（實務上 wave 通常對應一個 close_date 的所有 POs）
-- 為簡化、若 wave 對應的 items 都來自同一個 PO、就 backfill；否則留 NULL
-- ============================================================
WITH wave_po_map AS (
  SELECT
    pw.id AS wave_id,
    -- 找出該 wave 所有 items 對應的 PO（透過 wave_items.campaign_id → PR → PO）
    array_agg(DISTINCT poi.po_id) AS po_ids
  FROM picking_waves pw
  JOIN picking_wave_items pwi ON pwi.wave_id = pw.id
  LEFT JOIN purchase_request_items pri
    ON pri.po_item_id IS NOT NULL
   AND pri.sku_id = pwi.sku_id
  LEFT JOIN purchase_request_campaigns prc
    ON prc.pr_id = pri.pr_id AND prc.campaign_id = pwi.campaign_id
  LEFT JOIN purchase_order_items poi ON poi.id = pri.po_item_id
  WHERE pw.source_po_id IS NULL
  GROUP BY pw.id
)
UPDATE picking_waves pw
   SET source_po_id = (wpm.po_ids)[1]
  FROM wave_po_map wpm
 WHERE pw.id = wpm.wave_id
   AND array_length(wpm.po_ids, 1) = 1;
