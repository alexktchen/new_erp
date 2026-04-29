-- ============================================================
-- Fix RLS policies for store_monthly_settlements
--
-- 之前用 current_setting('app.tenant_id') pattern，但這個專案 RLS 是用
-- auth.jwt() ->> 'tenant_id' 走（見 transfer_settlements 等既有 policy）。
-- 重建 policies。
-- ============================================================

DROP POLICY IF EXISTS sms_hq_all       ON store_monthly_settlements;
DROP POLICY IF EXISTS sms_store_read   ON store_monthly_settlements;
DROP POLICY IF EXISTS smsi_hq_all      ON store_monthly_settlement_items;

CREATE POLICY sms_hq_all ON store_monthly_settlements
  FOR ALL USING (
    tenant_id = (auth.jwt() ->> 'tenant_id')::uuid
    AND (auth.jwt() ->> 'role') IN ('owner','admin','hq_manager','hq_accountant')
  );

CREATE POLICY sms_store_read ON store_monthly_settlements
  FOR SELECT USING (
    tenant_id = (auth.jwt() ->> 'tenant_id')::uuid
    AND (auth.jwt() ->> 'store_id')::bigint = store_id
  );

CREATE POLICY smsi_hq_all ON store_monthly_settlement_items
  FOR ALL USING (
    tenant_id = (auth.jwt() ->> 'tenant_id')::uuid
    AND (auth.jwt() ->> 'role') IN ('owner','admin','hq_manager','hq_accountant')
  );

-- ------------------------------------------------------------
-- 簡化讀取 policy（讓 authenticated user 都能讀同 tenant 資料）
-- 比照 customer_orders / suppliers / members 等表的 auth_read_* pattern
-- ------------------------------------------------------------
DROP POLICY IF EXISTS auth_read_sms ON store_monthly_settlements;
CREATE POLICY auth_read_sms ON store_monthly_settlements
  FOR SELECT USING (tenant_id = (auth.jwt() ->> 'tenant_id')::uuid);

DROP POLICY IF EXISTS auth_read_smsi ON store_monthly_settlement_items;
CREATE POLICY auth_read_smsi ON store_monthly_settlement_items
  FOR SELECT USING (tenant_id = (auth.jwt() ->> 'tenant_id')::uuid);
