-- ============================================================
-- Add scheduled_sort_order to community_product_candidates.
-- Used to order candidates within a single scheduled day on
-- the candidate calendar (manual up/down move).
--
-- Backfill rules:
--   - PARTITION BY tenant_id, scheduled_open_at (each tenant+day independent)
--   - ORDER BY created_at ASC, id ASC (stable tiebreaker)
--   - Only rows where scheduled_open_at IS NOT NULL get a value
--
-- Rollback:
--   ALTER TABLE community_product_candidates DROP COLUMN scheduled_sort_order;
-- ============================================================

ALTER TABLE community_product_candidates
  ADD COLUMN scheduled_sort_order INTEGER;

WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY tenant_id, scheduled_open_at
      ORDER BY created_at ASC, id ASC
    ) AS rn
  FROM community_product_candidates
  WHERE scheduled_open_at IS NOT NULL
)
UPDATE community_product_candidates c
   SET scheduled_sort_order = r.rn
  FROM ranked r
 WHERE c.id = r.id;
