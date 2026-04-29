-- ============================================================
-- 修正 store_monthly_settlement_items trigger
--
-- 問題：之前用 forbid_append_only_mutation() 通用 trigger、所有 UPDATE/DELETE
-- 都擋。但 rpc_generate_hq_to_store_settlement 內部需要在 settlement 是 draft
-- 時 DELETE 舊 items 重建。
--
-- 解法：換成 status-aware trigger
--   - draft 狀態：允許 UPDATE/DELETE items (重算用)
--   - confirmed / settled 狀態：禁止（保護已結帳資料）
-- ============================================================

DROP TRIGGER IF EXISTS trg_no_mut_smsi ON store_monthly_settlement_items;

CREATE OR REPLACE FUNCTION forbid_smsi_mutation_when_locked()
RETURNS TRIGGER AS $$
DECLARE
  v_status TEXT;
  v_settlement_id BIGINT;
BEGIN
  -- 取 settlement_id
  IF TG_OP = 'DELETE' THEN
    v_settlement_id := OLD.settlement_id;
  ELSE
    v_settlement_id := NEW.settlement_id;
  END IF;

  SELECT status INTO v_status
    FROM store_monthly_settlements
   WHERE id = v_settlement_id;

  IF v_status IN ('confirmed', 'settled') THEN
    RAISE EXCEPTION 'store_monthly_settlement_items: settlement % is %, cannot modify/delete (locked)',
      v_settlement_id, v_status;
  END IF;

  -- draft / cancelled / disputed: 允許
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  ELSE
    RETURN NEW;
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_smsi_immutable_when_locked
  BEFORE UPDATE OR DELETE ON store_monthly_settlement_items
  FOR EACH ROW EXECUTE FUNCTION forbid_smsi_mutation_when_locked();

COMMENT ON FUNCTION forbid_smsi_mutation_when_locked IS
  'store_monthly_settlement_items 鎖定機制：confirmed/settled 的 settlement 不能改 items；draft 可重算';
