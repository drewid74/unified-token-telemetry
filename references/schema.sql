-- Unified Token Telemetry — Canonical DDL
-- Replace {{schema}} with your target schema name before running (e.g., telemetry, public)
-- Run this file once to initialize the schema, or use templates/migration.template.sql for versioned migrations.

CREATE SCHEMA IF NOT EXISTS {{schema}};

-- ─────────────────────────────────────────────
-- Enum Types
-- ─────────────────────────────────────────────

CREATE TYPE {{schema}}.token_measurement_basis AS ENUM (
    'exact',               -- Provider reported per-request tokens (most accurate; direct from API response)
    'provider_aggregate',  -- Provider pre-aggregated (e.g., Copilot daily rollup; no per-request breakdown)
    'derived_estimate'     -- Calculated from proxies (e.g., character count * ratio); not directly measured
);

CREATE TYPE {{schema}}.telemetry_granularity AS ENUM (
    'hour',  -- Hourly windows (LiteLLM via Prometheus)
    'day'    -- Daily windows (Copilot daily API)
);

-- ─────────────────────────────────────────────
-- Core Fact Table (17 columns)
-- ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS {{schema}}.token_usage (
    -- Identity
    id                  BIGSERIAL   PRIMARY KEY,

    -- Source classification
    source_system       TEXT        NOT NULL,   -- 'litellm', 'copilot', 'manual'
    provider            TEXT        NOT NULL,   -- 'anthropic', 'openai', 'github', 'google'
    model               TEXT        NOT NULL,   -- Human-readable model name: 'claude-3-5-sonnet'
    model_id            TEXT        NOT NULL,   -- Provider model identifier: 'claude-3-5-sonnet-20241022'

    -- Time window
    window_start        TIMESTAMPTZ NOT NULL,
    window_end          TIMESTAMPTZ NOT NULL,
    granularity         {{schema}}.telemetry_granularity    NOT NULL,
    measurement_basis   {{schema}}.token_measurement_basis  NOT NULL,

    -- Token counts
    input_tokens        BIGINT      NOT NULL DEFAULT 0,
    output_tokens       BIGINT      NOT NULL DEFAULT 0,
    cached_read_tokens  BIGINT,                 -- NULL = provider does not report cache reads (e.g., Copilot)
    cached_write_tokens BIGINT,                 -- NULL = provider does not report cache writes

    -- Cost
    cost_usd            NUMERIC(12,6),          -- NULL if pricing not available or not configured

    -- Attribution
    user_id             TEXT,                   -- NULL = org-level aggregate (e.g., Copilot org rollup)

    -- Audit
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Conflict key: one row per (source, model, window, user)
    -- ON CONFLICT on this key = replacement upsert, not additive
    CONSTRAINT uq_token_usage_window
        UNIQUE NULLS NOT DISTINCT (source_system, model_id, window_start, window_end, user_id)
);

COMMENT ON TABLE {{schema}}.token_usage IS
    'Unified AI token usage fact table. One row per source/model/window/user. Upserts are replacement, not additive.';

COMMENT ON COLUMN {{schema}}.token_usage.cached_read_tokens IS
    'NULL means provider does not report this metric. 0 means provider reported zero cache reads.';

COMMENT ON COLUMN {{schema}}.token_usage.cached_write_tokens IS
    'NULL means provider does not report this metric. 0 means provider reported zero cache writes.';

COMMENT ON COLUMN {{schema}}.token_usage.measurement_basis IS
    'exact=per-request API counts; provider_aggregate=pre-summed by provider; derived_estimate=calculated proxy.';

-- ─────────────────────────────────────────────
-- updated_at Trigger
-- ─────────────────────────────────────────────

CREATE OR REPLACE FUNCTION {{schema}}.set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS token_usage_updated_at ON {{schema}}.token_usage;
CREATE TRIGGER token_usage_updated_at
    BEFORE UPDATE ON {{schema}}.token_usage
    FOR EACH ROW EXECUTE FUNCTION {{schema}}.set_updated_at();

-- ─────────────────────────────────────────────
-- Indexes
-- ─────────────────────────────────────────────

-- Primary time-range queries
CREATE INDEX IF NOT EXISTS idx_token_usage_window_start
    ON {{schema}}.token_usage (window_start DESC);

-- Source-filtered time queries (e.g., "all LiteLLM rows this week")
CREATE INDEX IF NOT EXISTS idx_token_usage_source_window
    ON {{schema}}.token_usage (source_system, window_start DESC);

-- Model-filtered time queries (e.g., "claude-3-5-sonnet cost trend")
CREATE INDEX IF NOT EXISTS idx_token_usage_provider_model_window
    ON {{schema}}.token_usage (provider, model_id, window_start DESC);

-- User-scoped queries (partial index; skips org-level rows)
CREATE INDEX IF NOT EXISTS idx_token_usage_user_window
    ON {{schema}}.token_usage (user_id, window_start DESC)
    WHERE user_id IS NOT NULL;
