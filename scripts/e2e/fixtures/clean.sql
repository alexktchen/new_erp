-- ============================================================
-- fixture: clean
-- 不灌任何交易資料；只留 master + base fixtures。
-- 適合 CRUD 類測試（TEST-core-modules / TEST-B3-products-ext / TEST-deploy-admin）。
-- ============================================================
\set ON_ERROR_STOP on
\echo 'fixture clean: noop.'
