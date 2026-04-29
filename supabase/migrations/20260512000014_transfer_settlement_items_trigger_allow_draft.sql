-- ============================================================
-- 修正 transfer_settlement_items trigger（同 sms 修法）
--
-- 問題：trg_no_mut_settle_items 用通用 forbid_append_only_mutation()
-- 擋掉所有 UPDATE/DELETE。但 rpc_generate_transfer_settlement 內部需要
-- 在 settlement 是 draft 時 DELETE 舊 items 重建。
--
-- 解法：status-aware trigger
--   - draft / cancelled / disputed: 允許重算
--   - confirmed / settled: 禁止改動
-- ============================================================

DROP TRIGGER IF EXISTS trg_no_mut_settle_items ON transfer_settlement_items;

CREATE OR REPLACE FUNCTION forbid_tsi_mutation_when_locked()
RETURNS TRIGGER AS $$
DECLARE
  v_status TEXT;
  v_settlement_id BIGINT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_settlement_id := OLD.settlement_id;
  ELSE
    v_settlement_id := NEW.settlement_id;
  END IF;

  SELECT status INTO v_status
    FROM transfer_settlements
   WHERE id = v_settlement_id;

  IF v_status IN ('confirmed', 'settled') THEN
    RAISE EXCEPTION 'transfer_settlement_items: settlement % is %, cannot modify/delete (locked)',
      v_settlement_id, v_status;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  ELSE
    RETURN NEW;
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_tsi_immutable_when_locked
  BEFORE UPDATE OR DELETE ON transfer_settlement_items
  FOR EACH ROW EXECUTE FUNCTION forbid_tsi_mutation_when_locked();

COMMENT ON FUNCTION forbid_tsi_mutation_when_locked IS
  'transfer_settlement_items 鎖定機制：confirmed/settled 不能改 items；draft 可重算';
