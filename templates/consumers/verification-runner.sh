#!/usr/bin/env bash
# Verification Runner — Unified Token Telemetry
#
# Runs smoke test queries from references/verification.sql against your Postgres.
# Prints results and exits 1 if critical checks fail (duplicates found, invariant violations).
#
# Usage:
#   TELEMETRY_PG_HOST=<host> TELEMETRY_PG_PORT=<port> TELEMETRY_PG_DB=<db> \
#   TELEMETRY_PG_USER=<user> TELEMETRY_PG_PASSWORD=<pass> TELEMETRY_PG_SCHEMA=<schema> \
#   ./verification-runner.sh
#
# Or source a .env file first:
#   source instances/<your-name>/.env && ./verification-runner.sh

set -euo pipefail

# ─────────────────────────────────────────────
# Config from environment
# ─────────────────────────────────────────────

PG_HOST="${TELEMETRY_PG_HOST:?Missing TELEMETRY_PG_HOST}"
PG_PORT="${TELEMETRY_PG_PORT:?Missing TELEMETRY_PG_PORT}"
PG_DB="${TELEMETRY_PG_DB:?Missing TELEMETRY_PG_DB}"
PG_USER="${TELEMETRY_PG_USER:?Missing TELEMETRY_PG_USER}"
SCHEMA="${TELEMETRY_PG_SCHEMA:-telemetry}"

export PGPASSWORD="${TELEMETRY_PG_PASSWORD:?Missing TELEMETRY_PG_PASSWORD}"

PSQL="psql -h $PG_HOST -p $PG_PORT -U $PG_USER -d $PG_DB --no-password"

echo "=== Unified Token Telemetry — Verification ==="
echo "  Host:   $PG_HOST:$PG_PORT"
echo "  DB:     $PG_DB"
echo "  Schema: $SCHEMA"
echo ""

FAIL=0

# ─────────────────────────────────────────────
# Check 1: Table exists and has rows
# ─────────────────────────────────────────────

echo "--- Check 1: Table exists and has rows ---"
$PSQL -c "
SELECT
    COUNT(*)          AS row_count,
    MIN(window_start) AS earliest_window,
    MAX(window_end)   AS latest_window
FROM ${SCHEMA}.token_usage;
"

# ─────────────────────────────────────────────
# Check 2: Each source has recent ingested data
# ─────────────────────────────────────────────

echo ""
echo "--- Check 2: Source ingest freshness ---"
$PSQL -c "
SELECT
    source_system,
    COUNT(*) AS total_rows,
    MAX(window_end) AS last_window_end,
    MAX(created_at) AS last_ingested_at,
    ROUND(EXTRACT(EPOCH FROM (NOW() - MAX(created_at))) / 3600, 1) AS hours_since_last_ingest
FROM ${SCHEMA}.token_usage
GROUP BY source_system
ORDER BY hours_since_last_ingest ASC;
"

# ─────────────────────────────────────────────
# Check 3: Copilot cache invariant
# MUST return 0 rows
# ─────────────────────────────────────────────

echo ""
echo "--- Check 3: Copilot cache NULL invariant (MUST return 0 rows) ---"
COPILOT_VIOLATIONS=$($PSQL -t -A -c "
SELECT COUNT(*)
FROM ${SCHEMA}.token_usage
WHERE source_system = 'copilot'
  AND (cached_read_tokens IS NOT NULL OR cached_write_tokens IS NOT NULL);
")

echo "  Copilot cache violations: $COPILOT_VIOLATIONS"
if [ "$COPILOT_VIOLATIONS" -gt "0" ]; then
    echo "  FAIL: Copilot rows have non-NULL cache columns — invariant violation!"
    FAIL=1
else
    echo "  OK"
fi

# ─────────────────────────────────────────────
# Check 4: Duplicate conflict key (idempotency)
# MUST return 0 rows
# ─────────────────────────────────────────────

echo ""
echo "--- Check 4: Duplicate conflict key (MUST return 0 rows) ---"
DUPLICATES=$($PSQL -t -A -c "
SELECT COUNT(*) FROM (
    SELECT source_system, model_id, window_start, window_end, user_id
    FROM ${SCHEMA}.token_usage
    GROUP BY source_system, model_id, window_start, window_end, user_id
    HAVING COUNT(*) > 1
) AS dups;
")

echo "  Duplicate conflict keys: $DUPLICATES"
if [ "$DUPLICATES" -gt "0" ]; then
    echo "  FAIL: Duplicate conflict keys found — upsert not working correctly!"
    FAIL=1
else
    echo "  OK"
fi

# ─────────────────────────────────────────────
# Check 5: Recent 24h summary
# ─────────────────────────────────────────────

echo ""
echo "--- Check 5: Last 24h token summary ---"
$PSQL -c "
SELECT
    source_system,
    provider,
    SUM(input_tokens)  AS input_24h,
    SUM(output_tokens) AS output_24h,
    ROUND(SUM(COALESCE(cost_usd, 0)), 4) AS cost_usd_24h
FROM ${SCHEMA}.token_usage
WHERE window_start >= NOW() - INTERVAL '24 hours'
GROUP BY source_system, provider
ORDER BY cost_usd_24h DESC;
"

# ─────────────────────────────────────────────
# Result
# ─────────────────────────────────────────────

echo ""
if [ "$FAIL" -eq "0" ]; then
    echo "=== VERIFICATION PASSED ==="
    exit 0
else
    echo "=== VERIFICATION FAILED — see errors above ==="
    exit 1
fi
