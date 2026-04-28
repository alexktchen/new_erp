#!/usr/bin/env bash
# ============================================================
# E2E reset · driver
# Usage:
#   ./scripts/e2e/reset.sh <fixture>          # interactive confirm
#   ./scripts/e2e/reset.sh <fixture> --yes    # CI / 不問
#
# fixture ∈ clean | with-stock | with-orders | with-pr-po
#         | with-transfers | with-campaign | with-mutual-aid | full-demo
#
# 需要環境變數（從 scripts/e2e/.env.e2e 載入）：
#   E2E_DB_URL          Supabase pooler connection string（service role）
#   E2E_EXPECTED_HOST   防呆用的 host substring（預設讀 .env.e2e）
# ============================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIXTURES_DIR="$SCRIPT_DIR/fixtures"

usage() {
  cat <<EOF
Usage: $0 <fixture> [--yes]

Fixtures:
  clean             僅 master + base
  with-stock        各倉初始庫存
  with-orders       4 筆顧客訂單（含 campaigns）
  with-pr-po        PR / PO / GR 各階段
  with-transfers    調撥單 draft / shipped / received
  with-campaign     10 個團購（不含訂單）
  with-mutual-aid   互助板貼文
  full-demo         全部串起來
EOF
  exit 1
}

[[ $# -ge 1 ]] || usage

FIXTURE="$1"
shift || true
ASSUME_YES="false"
[[ "${1:-}" == "--yes" ]] && ASSUME_YES="true"

# 驗證 fixture
case "$FIXTURE" in
  clean|with-stock|with-orders|with-pr-po|with-transfers|with-campaign|with-mutual-aid|full-demo) ;;
  *) echo "❌ unknown fixture: $FIXTURE"; usage ;;
esac

FIXTURE_FILE="$FIXTURES_DIR/$FIXTURE.sql"
[[ -f "$FIXTURE_FILE" ]] || { echo "❌ fixture file not found: $FIXTURE_FILE"; exit 1; }

# 載入 .env.e2e
ENV_FILE="$SCRIPT_DIR/.env.e2e"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "❌ 缺 $ENV_FILE — 從 .env.e2e.example 複製、填上 service-role pooler URL"
  exit 1
fi
# shellcheck disable=SC1090
set -a; source "$ENV_FILE"; set +a

: "${E2E_DB_HOST:?E2E_DB_HOST 未設}"
: "${E2E_DB_PORT:?E2E_DB_PORT 未設}"
: "${E2E_DB_USER:?E2E_DB_USER 未設}"
: "${E2E_DB_NAME:?E2E_DB_NAME 未設}"
: "${E2E_DB_PASSWORD:?E2E_DB_PASSWORD 未設}"
: "${E2E_EXPECTED_HOST:?E2E_EXPECTED_HOST 未設（host substring 防呆）}"

# 防呆：host / user 至少一邊必須包含預期字串
if [[ "$E2E_DB_HOST" != *"$E2E_EXPECTED_HOST"* && "$E2E_DB_USER" != *"$E2E_EXPECTED_HOST"* ]]; then
  echo "❌ DB host/user 都不含 '$E2E_EXPECTED_HOST'，拒絕執行"
  exit 1
fi

# 把密碼放到 PGPASSWORD env，URL 只放其他欄位 → 不必 URL-encode
export PGPASSWORD="$E2E_DB_PASSWORD"
PSQL_CONN=( -h "$E2E_DB_HOST" -p "$E2E_DB_PORT" -U "$E2E_DB_USER" -d "$E2E_DB_NAME" )

# 互動確認
if [[ "$ASSUME_YES" != "true" ]]; then
  echo "⚠️  即將清空 [$E2E_DB_HOST / $E2E_DB_USER] 並重灌 fixture [$FIXTURE]"
  read -r -p "輸入 RESET 繼續：" CONFIRM
  [[ "$CONFIRM" == "RESET" ]] || { echo "abort."; exit 1; }
fi

# 取 tenant_id（從 auth.users.app_metadata）
echo "→ resolving tenant_id from auth.users..."
TENANT_ID="$(
  psql "${PSQL_CONN[@]}" -tAX -c \
    "SELECT raw_app_meta_data->>'tenant_id' FROM auth.users WHERE raw_app_meta_data ? 'tenant_id' LIMIT 1;"
)"
TENANT_ID="${TENANT_ID//[$'\t\r\n ']/}"
[[ -n "$TENANT_ID" ]] || { echo "❌ 取不到 tenant_id：請確認至少一個 auth.user 的 raw_app_meta_data.tenant_id 已設"; exit 1; }
echo "  tenant_id = $TENANT_ID"

run_sql() {
  local label="$1" file="$2"
  local t0; t0=$(date +%s)
  printf "→ %-22s" "$label"
  PGOPTIONS="--client-min-messages=warning" \
    psql "${PSQL_CONN[@]}" -v ON_ERROR_STOP=1 -v "tenant_id=$TENANT_ID" -X -q -f "$file"
  printf "  done (%ss)\n" "$(( $(date +%s) - t0 ))"
}

run_sql "00-truncate"        "$SCRIPT_DIR/00-truncate.sql"
run_sql "01-master"          "$SCRIPT_DIR/01-master.sql"
run_sql "02-base-fixtures"   "$SCRIPT_DIR/02-base-fixtures.sql"
run_sql "fixture: $FIXTURE"  "$FIXTURE_FILE"

# 簡報：列幾張關鍵表筆數
echo
echo "── summary ─────────────────────────────"
psql "${PSQL_CONN[@]}" -X -A -F $'\t' -c "$(cat <<'SQL'
SELECT 'locations'             AS table, COUNT(*) FROM locations            UNION ALL
SELECT 'stores',                  COUNT(*) FROM stores                      UNION ALL
SELECT 'products',                COUNT(*) FROM products                    UNION ALL
SELECT 'skus',                    COUNT(*) FROM skus                        UNION ALL
SELECT 'prices',                  COUNT(*) FROM prices                      UNION ALL
SELECT 'members',                 COUNT(*) FROM members                     UNION ALL
SELECT 'group_buy_campaigns',     COUNT(*) FROM group_buy_campaigns         UNION ALL
SELECT 'customer_orders',         COUNT(*) FROM customer_orders             UNION ALL
SELECT 'purchase_orders',         COUNT(*) FROM purchase_orders             UNION ALL
SELECT 'goods_receipts',          COUNT(*) FROM goods_receipts              UNION ALL
SELECT 'transfers',               COUNT(*) FROM transfers                   UNION ALL
SELECT 'mutual_aid_board',        COUNT(*) FROM mutual_aid_board            UNION ALL
SELECT 'stock_balances',          COUNT(*) FROM stock_balances
ORDER BY 1;
SQL
)"
echo "────────────────────────────────────────"
echo "✅ fixture [$FIXTURE] ready."
