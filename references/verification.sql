-- Verification Smoke Tests — Unified Token Telemetry
-- Run after initial deployment and after each schema migration
-- Replace {{schema}} with your schema name
-- All checks should return rows; empty result = problem

-- ─────────────────────────────────────────────
-- Check 1: Table exists and has rows
-- ─────────────────────────────────────────────

SELECT
    'table_exists'          AS check_name,
    COUNT(*)                AS row_count,
    MIN(window_start)       AS earliest_window,
    MAX(window_end)         AS latest_window
FROM {{schema}}.token_usage;

-- ─────────────────────────────────────────────
-- Check 2: Each enabled source has recent ingested data
-- Expected: one row per source_system with recent_hours < 26
-- Freshness MUST be based on created_at (ingestion/write time), not window_start/window_end,
-- because hourly bucketing can make a healthy pipeline look >2h stale near the top of the hour.
-- ─────────────────────────────────────────────

SELECT
    source_system,
    COUNT(*)                                                AS total_rows,
    MAX(window_end)                                         AS last_window_end,
    MAX(created_at)                                         AS last_ingested_at,
    ROUND(EXTRACT(EPOCH FROM (NOW() - MAX(created_at))) / 3600, 1) AS hours_since_last_ingest
FROM {{schema}}.token_usage
GROUP BY source_system
ORDER BY hours_since_last_ingest ASC;

-- ─────────────────────────────────────────────
-- Check 3: Copilot rows must have NULL cache columns
-- Expected: 0 rows (any rows = invariant violation)
-- ─────────────────────────────────────────────

SELECT
    'copilot_cache_null_violation' AS check_name,
    id,
    window_start,
    cached_read_tokens,
    cached_write_tokens
FROM {{schema}}.token_usage
WHERE source_system = 'copilot'
  AND (cached_read_tokens IS NOT NULL OR cached_write_tokens IS NOT NULL);
-- EXPECTED: 0 rows

-- ─────────────────────────────────────────────
-- Check 4: Idempotency — duplicate conflict key check
-- Expected: 0 rows (any rows = upsert conflict key is not working)
-- ─────────────────────────────────────────────

SELECT
    source_system,
    model_id,
    window_start,
    window_end,
    user_id,
    COUNT(*) AS duplicate_count
FROM {{schema}}.token_usage
GROUP BY source_system, model_id, window_start, window_end, user_id
HAVING COUNT(*) > 1;
-- EXPECTED: 0 rows

-- ─────────────────────────────────────────────
-- Check 5: measurement_basis distribution
-- Expected: 'exact' for litellm, 'provider_aggregate' for copilot
-- 'derived_estimate' should be rare or absent
-- ─────────────────────────────────────────────

SELECT
    source_system,
    measurement_basis,
    COUNT(*) AS row_count
FROM {{schema}}.token_usage
GROUP BY source_system, measurement_basis
ORDER BY source_system, measurement_basis;

-- ─────────────────────────────────────────────
-- Check 6: Recent 24h summary
-- Quick sanity check on token volumes
-- ─────────────────────────────────────────────

SELECT
    source_system,
    provider,
    SUM(input_tokens)           AS input_tokens_24h,
    SUM(output_tokens)          AS output_tokens_24h,
    SUM(COALESCE(cached_read_tokens, 0)) AS cached_read_24h,
    ROUND(SUM(COALESCE(cost_usd, 0)), 4) AS cost_usd_24h
FROM {{schema}}.token_usage
WHERE window_start >= NOW() - INTERVAL '24 hours'
GROUP BY source_system, provider
ORDER BY cost_usd_24h DESC;
