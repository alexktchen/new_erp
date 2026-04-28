-- ============================================================
-- Aid transfer orchestration — schema 改動
--
-- 為「customer_order ↔ transfer 串接 + B 模型多段 chain」加兩欄：
--   transfers.customer_order_id：指向最終 dest leg 對應的 customer_order
--                                 receive 時用此 FK 推 customer_order → ready
--   transfers.next_transfer_id：B 模型 chain pointer
--                                 Leg-1 → Leg-2 → Leg-3（rejection 後延伸）
--
-- 兩欄都 NULL，完全相容既有 PO transfer。
-- ============================================================

ALTER TABLE transfers
  ADD COLUMN customer_order_id BIGINT REFERENCES customer_orders(id),
  ADD COLUMN next_transfer_id  BIGINT REFERENCES transfers(id);

CREATE INDEX idx_transfers_customer_order
  ON transfers (customer_order_id)
  WHERE customer_order_id IS NOT NULL;

CREATE INDEX idx_transfers_next_transfer
  ON transfers (next_transfer_id)
  WHERE next_transfer_id IS NOT NULL;

COMMENT ON COLUMN transfers.customer_order_id IS
  'Aid transfer：此 transfer 對應的 customer_order（只有最終 dest leg 才填，receive 時推 order → ready）';

COMMENT ON COLUMN transfers.next_transfer_id IS
  'Aid transfer chain：B 模型多段 transfer 的鏈接。經總倉：Leg-1.next=Leg-2；rejection 後 Leg-2.next=Leg-3';
