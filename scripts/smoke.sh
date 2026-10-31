#!/usr/bin/env bash
# npm run smoke: end-to-end smoke on the THROWAWAY test stack (127.0.0.1:3320, tmpfs, report_host=sp-test-db). Never touches the
# dev DB (3310) or any other container. Steps:
#   1. test DB up (bash scripts/test-db.sh up)
#   2. unit + integration tests (npm test; integration tests drive the MCP server in CRAWL_MODE=fixture, full prediction flow)
#   3. migration idempotence: npm run db:migrate twice on the test DB, row counts unchanged
#   4. MCP server tool list (26 tools, read-only set) + stats
#   5. clean fixture (scripts/smoke-seed.mjs: reset + 16 AAPL / 2 SPCX verified closes), baseline for 2026-10 must produce an AAPL
#      call and a SPCX null (short history), and `npm run audit` must report 0 violations on that clean state (gated)
set -euo pipefail
cd "$(dirname "$0")/.."
step() { printf '\n[smoke] === %s\n' "$*"; }

step "1/5 test DB up (127.0.0.1:3320)"
bash scripts/test-db.sh up

step "2/5 unit + integration tests"
npm test --silent 2>&1 | tail -n 9

# Test-DB credentials come from test/db/test.env (test-only values); the dev .env is never sourced here.
export SP_DB_HOST=127.0.0.1 SP_DB_PORT=3320 SP_ENV_FILE="$PWD/test/db/test.env"
MYSQL_ROOT_PASSWORD="$(sed -n 's/^MYSQL_ROOT_PASSWORD=//p' test/db/test.env)"
export MYSQL_ROOT_PASSWORD

step "3/5 migration idempotence (twice on the test DB)"
node scripts/migrate.mjs --seed
node scripts/migrate.mjs
unset MYSQL_ROOT_PASSWORD

step "4/5 MCP server tool list"
node scripts/smoke-mcp.mjs

step "5/5 clean fixture, baseline, audit (gated)"
node scripts/smoke-seed.mjs
out="$(node scripts/baseline.mjs --target 2026-10)"
echo "$out"
echo "$out" | grep -Eq '^AAPL +close=[0-9.]+ +dir=(up|down|flat) ' || { echo "[smoke] baseline produced no AAPL call"; exit 1; }
echo "$out" | grep -Eq '^SPCX .*baseline=null \(short_history' || { echo "[smoke] SPCX baseline is not null/short_history"; exit 1; }
node scripts/audit.mjs || { echo "[smoke] audit reported violations on the clean fixture"; exit 1; }

printf '\n[smoke] OK\n'
