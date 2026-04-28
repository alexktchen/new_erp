-- ============================================================
-- fixture: full-demo
-- 串接所有情境：庫存 + 團購 + 訂單 + 採購 + 轉撥 + 互助
-- 適合給人 demo 或跨情境整合測試。
-- ============================================================
\set ON_ERROR_STOP on

\ir with-stock.sql
\ir with-orders.sql
\ir with-pr-po.sql
\ir with-transfers.sql
\ir with-mutual-aid.sql

\echo 'fixture full-demo seeded.'
