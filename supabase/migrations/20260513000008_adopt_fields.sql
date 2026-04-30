-- ============================================================
-- Add boss-fill fields to community_product_candidates.
-- These are filled when the boss marks a candidate as adopted.
-- Building the actual product/sku is a later employee step.
--
-- Rollback:
--   ALTER TABLE community_product_candidates
--     DROP COLUMN adopted_supplier_name,
--     DROP COLUMN adopted_cost,
--     DROP COLUMN adopted_sale_price;
-- ============================================================

ALTER TABLE community_product_candidates
  ADD COLUMN adopted_supplier_name TEXT,
  ADD COLUMN adopted_cost           NUMERIC
    CONSTRAINT adopted_cost_nonneg CHECK (adopted_cost IS NULL OR adopted_cost >= 0),
  ADD COLUMN adopted_sale_price     NUMERIC
    CONSTRAINT adopted_sale_price_nonneg CHECK (adopted_sale_price IS NULL OR adopted_sale_price >= 0);
