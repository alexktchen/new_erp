-- ============================================================================
-- 關團超過 3 個月的商品圖／開團封面自動刪除（老闆 2026-10-28 指示）
--
-- 每天 pg_cron 跑 _storage_purge_tick()：
--   1. _queue_expired_campaign_images(3) 用 SQL 決定要刪哪些圖，從商品 / 團身上拿掉
--      （products.images 移除該元素、group_buy_campaigns.cover_image_url 設 NULL），
--      同一個交易裡排進 storage_purge_queue。
--   2. 佇列有東西才打 Edge Function storage-purge，由它走 Storage API 真的刪檔。
--      storage.objects 有 protect_objects_delete，SQL 刪不了；就算繞過也只刪那一列、
--      底層檔案還在。
--
-- 「過期商品」判準（全部成立才刪）：
--   - 至少被一個團用過（group_buy_campaigns.product_id 或 campaign_items → skus）。
--     從來沒開過團的商品不在範圍內。
--   - 每一個用到它的團都已結束（locked / closed / cancelled）而且 end_at 早於 N 個月前。
--     draft / open / receiving / ready 一律保留（內部補貨 sentinel 團永遠 open → 保留）。
--   - 近 N 個月沒有任何訂單用到它的 SKU（現貨直配 SP- / 轉單 / 補貨 RR- 等，
--     這些掛在 sentinel 團或沿用舊團 campaign_id，不看訂單會刪到最近才賣的貨）。
--   - 沒有還在等取貨的品項（pending / reserved / ready）。客人還沒領的單要看得到圖。
--   - 近 N 個月或進行中的互助板貼文沒用到它（現貨專區沒自己的圖時退用商品圖）。
-- 路徑層級再擋一次：同一張圖只要還掛在任何非過期商品 / 非過期團 / 近期互助貼文上就不刪
-- （複製商品、快速開團會沿用舊路徑）。
--
-- 刪掉之後：會員訂單卡 / 團頁 / 後台商品頁看到的是「沒有圖」（購物袋空框），
-- 不是破圖 —— 因為 DB 參照在同一個交易裡就拿掉了。
-- 舊團之後要重開，商品圖要重新上傳。
--
-- 還原：佇列列（deleted_at IS NULL）代表檔案還沒刪，可依 source / source_id 把
-- path 加回 products.images / cover_image_url 再刪掉佇列列；deleted_at 有值就救不回來。
--
-- 2026-10-28 試算：658 個商品、4,484 張、1,151 MB（products bucket 共 8.8 GB）。
-- 開團封面目前 0 張（cover_image_url 從 8/20 漂漂館才開始有）。
--
-- 部署（Edge Function 部署方式見 CLAUDE.md）：
--   1. 套本檔
--   2. 部署 supabase/functions/storage-purge（verify_jwt=false）
--   3. SELECT vault.create_secret('https://<ref>.supabase.co/functions/v1/storage-purge',
--                                 'storage_purge_worker_url');
--   沒設 vault 也不會壞：tick 只排佇列、拿掉參照，不叫 worker（檔案留著）。
--
-- 新函式 / 新表，無基底版本。
-- Rollback：SELECT cron.unschedule('storage-purge-daily');
--           DROP FUNCTION _storage_purge_tick, _queue_expired_campaign_images,
--                         rpc_storage_purge_claim, rpc_storage_purge_done;
--           DROP TABLE storage_purge_queue;（已刪的檔案不會回來）
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.storage_purge_queue (
  bucket      TEXT        NOT NULL,
  path        TEXT        NOT NULL,
  source      TEXT        NOT NULL CHECK (source IN ('product', 'campaign_cover')),
  source_id   BIGINT      NOT NULL,
  queued_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at  TIMESTAMPTZ,
  attempts    INT         NOT NULL DEFAULT 0,
  last_error  TEXT,
  PRIMARY KEY (bucket, path)
);

CREATE INDEX IF NOT EXISTS idx_storage_purge_queue_pending
  ON public.storage_purge_queue (queued_at, path) WHERE deleted_at IS NULL;

COMMENT ON TABLE public.storage_purge_queue IS
  '要從 Storage 刪掉的檔案（20261028000000）。deleted_at IS NULL = 還沒刪、可還原；'
  'source/source_id = 原本掛在哪個商品 / 團身上。只有 SQL 函式寫得進來。';

ALTER TABLE public.storage_purge_queue ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.storage_purge_queue FROM PUBLIC, anon, authenticated;


-- ── 1. 決定要刪哪些圖，拿掉參照並排進佇列 ─────────────────────────────────────
CREATE OR REPLACE FUNCTION public._queue_expired_campaign_images(p_months INT DEFAULT 3)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cutoff   TIMESTAMPTZ := now() - make_interval(months => p_months);
  v_exp_prod BIGINT[];
  v_exp_camp BIGINT[];
  v_queued   INT;
BEGIN
  IF p_months IS NULL OR p_months < 1 THEN
    RAISE EXCEPTION 'p_months 至少 1';
  END IF;

  -- 過期商品（判準見檔頭）
  WITH camp_prod AS (
    SELECT c.id AS cid, c.product_id AS pid
      FROM group_buy_campaigns c
     WHERE c.product_id IS NOT NULL
    UNION
    SELECT ci.campaign_id, s.product_id
      FROM campaign_items ci
      JOIN skus s ON s.id = ci.sku_id
  ),
  prod_state AS (
    SELECT cp.pid,
           bool_or(c.status NOT IN ('locked', 'closed', 'cancelled')
                   OR c.end_at IS NULL
                   OR c.end_at >= v_cutoff) AS has_live_campaign
      FROM camp_prod cp
      JOIN group_buy_campaigns c ON c.id = cp.cid
     GROUP BY cp.pid
  ),
  order_prod AS (
    SELECT DISTINCT s.product_id AS pid
      FROM customer_order_items coi
      JOIN customer_orders co ON co.id = coi.order_id
      JOIN skus s ON s.id = coi.sku_id
     WHERE co.created_at >= v_cutoff
        OR (coi.status IN ('pending', 'reserved', 'ready')
            AND co.status NOT IN ('cancelled', 'expired', 'transferred_out', 'completed'))
  ),
  aid_prod AS (
    SELECT DISTINCT s.product_id AS pid
      FROM mutual_aid_board b
      JOIN skus s ON s.id = b.sku_id
     WHERE b.status = 'active' OR b.created_at >= v_cutoff
  )
  SELECT COALESCE(array_agg(ps.pid), '{}')
    INTO v_exp_prod
    FROM prod_state ps
   WHERE NOT ps.has_live_campaign
     AND NOT EXISTS (SELECT 1 FROM order_prod o WHERE o.pid = ps.pid)
     AND NOT EXISTS (SELECT 1 FROM aid_prod a WHERE a.pid = ps.pid);

  SELECT COALESCE(array_agg(c.id), '{}')
    INTO v_exp_camp
    FROM group_buy_campaigns c
   WHERE c.cover_image_url IS NOT NULL
     AND c.status IN ('locked', 'closed', 'cancelled')
     AND c.end_at < v_cutoff;

  -- 候選路徑 − 還有人在用的路徑
  WITH cand AS (
    SELECT e AS path, 'product' AS source, p.id AS source_id
      FROM products p,
           jsonb_array_elements_text(CASE WHEN jsonb_typeof(p.images) = 'array'
                                          THEN p.images ELSE '[]'::jsonb END) e
     WHERE p.id = ANY (v_exp_prod)
    UNION ALL
    SELECT c.cover_image_url, 'campaign_cover', c.id
      FROM group_buy_campaigns c
     WHERE c.id = ANY (v_exp_camp)
  ),
  keep AS (
    SELECT e AS path
      FROM products p,
           jsonb_array_elements_text(CASE WHEN jsonb_typeof(p.images) = 'array'
                                          THEN p.images ELSE '[]'::jsonb END) e
     WHERE NOT (p.id = ANY (v_exp_prod))
    UNION
    SELECT c.cover_image_url
      FROM group_buy_campaigns c
     WHERE c.cover_image_url IS NOT NULL
       AND NOT (c.id = ANY (v_exp_camp))
    UNION
    SELECT e
      FROM mutual_aid_board b,
           jsonb_array_elements_text(CASE WHEN jsonb_typeof(b.spot_images) = 'array'
                                          THEN b.spot_images ELSE '[]'::jsonb END) e
     WHERE b.status = 'active' OR b.created_at >= v_cutoff
  )
  INSERT INTO storage_purge_queue (bucket, path, source, source_id)
  SELECT DISTINCT ON (cd.path) 'products', cd.path, cd.source, cd.source_id
    FROM cand cd
   WHERE cd.path IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM keep k WHERE k.path = cd.path)
   ORDER BY cd.path, cd.source DESC, cd.source_id
  ON CONFLICT (bucket, path) DO NOTHING;
  GET DIAGNOSTICS v_queued = ROW_COUNT;

  -- 拿掉參照：只動過期商品 / 過期團，只拿掉已排進佇列的那幾張
  UPDATE products p
     SET images = COALESCE((
           SELECT jsonb_agg(x.e ORDER BY x.o)
             FROM jsonb_array_elements(p.images) WITH ORDINALITY AS x(e, o)
            WHERE NOT EXISTS (SELECT 1 FROM storage_purge_queue q
                               WHERE q.bucket = 'products' AND q.path = x.e #>> '{}')
         ), '[]'::jsonb)
   WHERE p.id = ANY (v_exp_prod)
     AND jsonb_typeof(p.images) = 'array'
     AND EXISTS (SELECT 1
                   FROM jsonb_array_elements_text(p.images) e
                   JOIN storage_purge_queue q ON q.bucket = 'products' AND q.path = e);

  UPDATE group_buy_campaigns c
     SET cover_image_url = NULL
   WHERE c.id = ANY (v_exp_camp)
     AND EXISTS (SELECT 1 FROM storage_purge_queue q
                  WHERE q.bucket = 'products' AND q.path = c.cover_image_url);

  RETURN v_queued;
END;
$$;

REVOKE ALL ON FUNCTION public._queue_expired_campaign_images(INT) FROM PUBLIC, anon, authenticated;


-- ── 2. worker 取一批要刪的檔案 ────────────────────────────────────────────────
-- 排進佇列之後又被用回去的（例：有人把舊路徑複製到新商品）→ 撤出佇列、不刪。
CREATE OR REPLACE FUNCTION public.rpc_storage_purge_claim(p_limit INT DEFAULT 100)
RETURNS TABLE (bucket TEXT, path TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cutoff TIMESTAMPTZ := now() - interval '3 months';
BEGIN
  RETURN QUERY
  WITH batch AS (
    SELECT q.bucket, q.path
      FROM storage_purge_queue q
     WHERE q.deleted_at IS NULL AND q.attempts < 5
     ORDER BY q.queued_at, q.path
     LIMIT GREATEST(COALESCE(p_limit, 100), 1)
  ),
  revived AS (
    DELETE FROM storage_purge_queue q
     USING batch b
     WHERE q.bucket = b.bucket AND q.path = b.path
       AND (EXISTS (SELECT 1 FROM products p
                     WHERE jsonb_typeof(p.images) = 'array' AND p.images ? b.path)
         OR EXISTS (SELECT 1 FROM group_buy_campaigns c WHERE c.cover_image_url = b.path)
         OR EXISTS (SELECT 1 FROM mutual_aid_board m
                     WHERE jsonb_typeof(m.spot_images) = 'array' AND m.spot_images ? b.path
                       AND (m.status = 'active' OR m.created_at >= v_cutoff)))
    RETURNING q.bucket, q.path
  )
  SELECT b.bucket, b.path
    FROM batch b
   WHERE NOT EXISTS (SELECT 1 FROM revived r WHERE r.bucket = b.bucket AND r.path = b.path);
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_storage_purge_claim(INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_storage_purge_claim(INT) TO service_role;


-- ── 3. worker 回報結果 ────────────────────────────────────────────────────────
-- 成功：deleted_at = now()（Storage API 對不存在的路徑不報錯，一樣算刪掉）。
-- 失敗：attempts +1、記錯誤；滿 5 次就不再撿，要人看 last_error。
CREATE OR REPLACE FUNCTION public.rpc_storage_purge_done(
  p_bucket TEXT,
  p_paths  TEXT[],
  p_error  TEXT DEFAULT NULL
)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_n INT;
BEGIN
  UPDATE storage_purge_queue q
     SET deleted_at = CASE WHEN p_error IS NULL THEN now() END,
         attempts   = q.attempts + CASE WHEN p_error IS NULL THEN 0 ELSE 1 END,
         last_error = p_error
   WHERE q.bucket = p_bucket
     AND q.path = ANY (p_paths)
     AND q.deleted_at IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_storage_purge_done(TEXT, TEXT[], TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_storage_purge_done(TEXT, TEXT[], TEXT) TO service_role;


-- ── 4. 每天跑一次 ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public._storage_purge_tick()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_url TEXT;
BEGIN
  PERFORM public._queue_expired_campaign_images(3);

  IF NOT EXISTS (SELECT 1 FROM storage_purge_queue WHERE deleted_at IS NULL AND attempts < 5) THEN
    RETURN;
  END IF;

  SELECT decrypted_secret INTO v_url FROM vault.decrypted_secrets
   WHERE name = 'storage_purge_worker_url' LIMIT 1;
  IF v_url IS NULL THEN
    RAISE NOTICE 'storage-purge-tick: vault 缺 storage_purge_worker_url，只排佇列不刪檔';
    RETURN;
  END IF;

  PERFORM net.http_post(
    url     := v_url,
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body    := '{}'::jsonb,
    timeout_milliseconds := 150000
  );
END;
$$;

REVOKE ALL ON FUNCTION public._storage_purge_tick() FROM PUBLIC, anon, authenticated;

-- 台北 03:17（UTC 19:17），避開白天尖峰
SELECT cron.unschedule('storage-purge-daily')
 WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'storage-purge-daily');
SELECT cron.schedule('storage-purge-daily', '17 19 * * *', $cron$ SELECT public._storage_purge_tick(); $cron$);
