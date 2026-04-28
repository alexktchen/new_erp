-- ============================================================
-- customer_orders：加狀態變更時間戳 5 欄
--
-- 為 Aid order timeline UI 服務，每個 status 變化點記時間。
-- 既有資料一律 NULL；新狀態變化發生時由對應 RPC 寫入。
--
-- 涵蓋：
--   confirmed_at：pending → confirmed
--   shipping_at：confirmed → shipping（rpc_ship_aid_order）
--   ready_at：   shipping → ready（rpc_receive_transfer 連動）
--   cancelled_at：任意 → cancelled（rpc_cancel_aid_order / rpc_reject_transfer）
--   completed_at：ready → completed
-- ============================================================

ALTER TABLE customer_orders
  ADD COLUMN confirmed_at TIMESTAMPTZ,
  ADD COLUMN shipping_at  TIMESTAMPTZ,
  ADD COLUMN ready_at     TIMESTAMPTZ,
  ADD COLUMN cancelled_at TIMESTAMPTZ,
  ADD COLUMN completed_at TIMESTAMPTZ;

COMMENT ON COLUMN customer_orders.confirmed_at IS '訂單確認時點（pending → confirmed）';
COMMENT ON COLUMN customer_orders.shipping_at  IS '訂單派貨時點（confirmed → shipping，rpc_ship_aid_order）';
COMMENT ON COLUMN customer_orders.ready_at     IS '訂單可取貨時點（shipping → ready，dest 店收貨自動連動）';
COMMENT ON COLUMN customer_orders.cancelled_at IS '訂單取消時點（任意 → cancelled，撤回派貨 / 拒收 / 早期取消）';
COMMENT ON COLUMN customer_orders.completed_at IS '訂單完成時點（ready → completed）';
