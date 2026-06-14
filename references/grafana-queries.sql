-- Grafana Panel Queries — Unified Token Telemetry
-- Datasource: Postgres datasource configured as ${DS_POSTGRES} variable in Grafana dashboard
-- All queries use $__timeFilter() macro for Grafana time range integration
-- Replace {{schema}} with your schema name in each query before importing

-- ─────────────────────────────────────────────
-- Panel 1: Token Cost by Provider (Bar Chart / Table)
-- Shows total cost_usd grouped by provider over the selected time range
-- ─────────────────────────────────────────────

SELECT
    provider,
    SUM(cost_usd)                               AS total_cost_usd,
    SUM(input_tokens + output_tokens)           AS total_tokens,
    COUNT(DISTINCT model_id)                    AS models_used
FROM {{schema}}.token_usage
WHERE $__timeFilter(window_start)
  AND cost_usd IS NOT NULL
GROUP BY provider
ORDER BY total_cost_usd DESC;

-- ─────────────────────────────────────────────
-- Panel 2: Token Usage Over Time (Time Series)
-- Plots input + output tokens per hour/day bucketed to Grafana interval
-- ─────────────────────────────────────────────

SELECT
    $__timeGroupAlias(window_start, $__interval),
    source_system,
    SUM(input_tokens)   AS input_tokens,
    SUM(output_tokens)  AS output_tokens
FROM {{schema}}.token_usage
WHERE $__timeFilter(window_start)
GROUP BY 1, source_system
ORDER BY 1 ASC;

-- ─────────────────────────────────────────────
-- Panel 3: Cache Hit Rate by Provider (Stat / Gauge)
-- Excludes providers that do not report cache data (cached_read_tokens IS NOT NULL)
-- IMPORTANT: Must keep the WHERE clause — see references/invariants.md rule #5
-- ─────────────────────────────────────────────

SELECT
    provider,
    ROUND(
        SUM(cached_read_tokens)::numeric
        / NULLIF(SUM(input_tokens), 0) * 100,
        2
    )                   AS cache_hit_pct,
    SUM(cached_read_tokens)     AS cached_tokens,
    SUM(input_tokens)           AS total_input_tokens
FROM {{schema}}.token_usage
WHERE $__timeFilter(window_start)
  AND cached_read_tokens IS NOT NULL  -- exclude providers without cache telemetry
GROUP BY provider
ORDER BY cache_hit_pct DESC NULLS LAST;
