-- ============================================================
-- store_monthly_settlements / items：補上 authenticated read policy
--
-- 之前的 hq_all policy 要求 role IN ('owner','admin','hq_manager','hq_accountant')
-- 但目前 admin user 的 JWT role = 'authenticated'、被擋。
-- 比照既有 customer_orders / members 等表的 auth_read_* pattern、
-- 加 SELECT-only 政策讓 authenticated user 都能讀同 tenant 資料。
-- ============================================================

DROP POLICY IF EXISTS auth_read_sms ON store_monthly_settlements;
CREATE POLICY auth_read_sms ON store_monthly_settlements
  FOR SELECT USING (tenant_id = (auth.jwt() ->> 'tenant_id')::uuid);

DROP POLICY IF EXISTS auth_read_smsi ON store_monthly_settlement_items;
CREATE POLICY auth_read_smsi ON store_monthly_settlement_items
  FOR SELECT USING (tenant_id = (auth.jwt() ->> 'tenant_id')::uuid);
