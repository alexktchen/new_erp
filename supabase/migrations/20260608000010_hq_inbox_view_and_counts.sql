-- ============================================================
-- HQ 收件匣統一 view + counts RPC
--
-- 目的:
--   1. 一支 RPC 拿全部 4 來源 × 4 階段 的 count(取代前端 16 個並行 query)
--   2. 統一 view 讓「全部」視圖可以做 server-side 分頁
--
-- 4 個來源:
--   - restock  : restock_requests
--   - transfer : transfers
--   - aid      : customer_orders(含 aid_transfer 品項的訂單)
--   - shortage : v_order_shortage 聚合到 order 維度
--
-- 4 個階段(stage):
--   - pending    : 待處理
--   - in_transit : 在途
--   - done       : 已完成
--   - rejected   : 已拒絕 / 取消
--
-- 用法:
--   SELECT * FROM v_hq_inbox WHERE stage='pending' ORDER BY ts DESC LIMIT 20;
--   SELECT rpc_inbox_counts();  -- => { restock: { pending: N, ... }, transfer: ..., ... }
--   SELECT rpc_hq_inbox_keys('pending', NULL, NULL, 1, 20);
--
-- 注意:
--   admin JWT role 可能 NULL → 使用 SECURITY DEFINER 確保 admin 可用
-- ============================================================

-- ----------------------------------------------------------------
-- 1. v_hq_inbox — 統一 inbox view (跨 4 來源 / 含 stage 分類)
-- ----------------------------------------------------------------
DROP VIEW IF EXISTS public.v_hq_inbox CASCADE;

CREATE OR REPLACE VIEW public.v_hq_inbox AS
-- 補貨申請
SELECT
  'restock-' || id::text                                AS row_key,
  'restock'::text                                       AS source,
  CASE
    WHEN status = 'pending'                                                     THEN 'pending'
    WHEN status IN ('approved_transfer','approved_pr','shipped')                THEN 'in_transit'
    WHEN status = 'received'                                                    THEN 'done'
    ELSE 'rejected'
  END                                                   AS stage,
  requested_at                                          AS ts,
  id                                                    AS source_id
FROM public.restock_requests

UNION ALL

-- 轉貨單
SELECT
  'transfer-' || id::text,
  'transfer',
  CASE
    WHEN status IN ('draft','confirmed') THEN 'pending'
    WHEN status = 'shipped'              THEN 'in_transit'
    WHEN status = 'received'             THEN 'done'
    ELSE 'rejected'
  END,
  created_at,
  id
FROM public.transfers

UNION ALL

-- 互助訂單(只計含 aid_transfer 品項的訂單)
SELECT
  'aid-' || co.id::text,
  'aid',
  CASE
    WHEN co.status IN ('pending','confirmed')                     THEN 'pending'
    WHEN co.status = 'shipping'                                   THEN 'in_transit'
    WHEN co.status IN ('ready','completed','partially_completed') THEN 'done'
    ELSE 'rejected'
  END,
  co.updated_at,
  co.id
FROM public.customer_orders co
WHERE EXISTS (
  SELECT 1 FROM public.customer_order_items coi
  WHERE coi.order_id = co.id AND coi.source = 'aid_transfer'
)

UNION ALL

-- 短少訂單(從 v_order_shortage 的 order × sku 維度去重到 order)
SELECT DISTINCT
  'shortage-' || order_id::text,
  'shortage',
  CASE
    WHEN shortage_resolution IS NULL                              THEN 'pending'
    WHEN shortage_resolution IN ('notified','waiting_next_po')    THEN 'in_transit'
    WHEN shortage_resolution IN ('cancelled','reallocated')       THEN 'done'
    ELSE 'pending'
  END,
  order_updated_at,
  order_id
FROM public.v_order_shortage;

COMMENT ON VIEW public.v_hq_inbox IS
  'HQ 收件匣統一 view:跨 restock / transfer / aid / shortage 4 來源,提供 (row_key, source, stage, ts, source_id),供 inbox 分頁與計數用。';

-- ----------------------------------------------------------------
-- 2. rpc_inbox_counts — 一次拿 4 來源 × 4 階段 的 count
-- ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rpc_inbox_counts()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH src(source) AS (VALUES ('restock'),('transfer'),('aid'),('shortage')),
       stg(stage)  AS (VALUES ('pending'),('in_transit'),('done'),('rejected')),
       grid AS (SELECT s.source, st.stage FROM src s CROSS JOIN stg st),
       counts AS (
         SELECT v.source, v.stage, COUNT(*)::int AS cnt
         FROM v_hq_inbox v
         GROUP BY v.source, v.stage
       )
  SELECT jsonb_object_agg(g.source, stages_obj)
  FROM (
    SELECT
      g.source,
      jsonb_object_agg(g.stage, COALESCE(c.cnt, 0)) AS stages_obj
    FROM grid g
    LEFT JOIN counts c ON c.source = g.source AND c.stage = g.stage
    GROUP BY g.source
  ) g;
$$;

COMMENT ON FUNCTION public.rpc_inbox_counts() IS
  'HQ 收件匣計數:一次回傳 4 來源 × 4 階段 共 16 個數字(JSONB)。';

GRANT EXECUTE ON FUNCTION public.rpc_inbox_counts() TO authenticated;

-- ----------------------------------------------------------------
-- 3. rpc_hq_inbox_keys — 「全部」視圖分頁 key list
-- ----------------------------------------------------------------
-- 回傳:
--   {
--     "total": N,
--     "rows": [{ "row_key", "source", "stage", "ts", "source_id" }, ...]
--   }
--
-- client 拿到 page keys 後,依 source 分組,再 batch 抓各表 by id 補完整欄位
-- ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rpc_hq_inbox_keys(
  p_stage     text DEFAULT NULL,
  p_date_from timestamptz DEFAULT NULL,
  p_date_to   timestamptz DEFAULT NULL,
  p_page      int DEFAULT 1,
  p_page_size int DEFAULT 20
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_total int;
  v_rows jsonb;
BEGIN
  SELECT COUNT(*) INTO v_total
  FROM v_hq_inbox v
  WHERE (p_stage     IS NULL OR v.stage = p_stage)
    AND (p_date_from IS NULL OR v.ts >= p_date_from)
    AND (p_date_to   IS NULL OR v.ts <= p_date_to);

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'row_key',   t.row_key,
           'source',    t.source,
           'stage',     t.stage,
           'ts',        t.ts,
           'source_id', t.source_id
         ) ORDER BY t.ts DESC), '[]'::jsonb)
  INTO v_rows
  FROM (
    SELECT v.row_key, v.source, v.stage, v.ts, v.source_id
    FROM v_hq_inbox v
    WHERE (p_stage     IS NULL OR v.stage = p_stage)
      AND (p_date_from IS NULL OR v.ts >= p_date_from)
      AND (p_date_to   IS NULL OR v.ts <= p_date_to)
    ORDER BY v.ts DESC
    LIMIT p_page_size
    OFFSET GREATEST(0, (p_page - 1) * p_page_size)
  ) t;

  RETURN jsonb_build_object(
    'total', v_total,
    'rows',  v_rows
  );
END;
$$;

COMMENT ON FUNCTION public.rpc_hq_inbox_keys(text, timestamptz, timestamptz, int, int) IS
  'HQ 收件匣「全部」分頁 key list:用 v_hq_inbox 跨 4 來源 ORDER BY ts DESC,回傳當前頁的 (row_key, source, stage, ts, source_id) 與 total。';

GRANT EXECUTE ON FUNCTION public.rpc_hq_inbox_keys(text, timestamptz, timestamptz, int, int) TO authenticated;
