-- Unified Token Telemetry — Versioned Migration Template
-- Use this file for production migrations. Wraps schema creation in a transaction.
-- Replace {{schema}} with your schema name before running.

BEGIN;

-- Record migration version (optional — use if you have a migrations table)
-- INSERT INTO public.schema_migrations (version, name, applied_at)
-- VALUES ('001', 'unified_token_telemetry_initial', NOW())
-- ON CONFLICT (version) DO NOTHING;

-- ─────────────────────────────────────────────
-- Schema
-- ─────────────────────────────────────────────

CREATE SCHEMA IF NOT EXISTS {{schema}};

-- ─────────────────────────────────────────────
-- Enum Types (idempotent)
-- ─────────────────────────────────────────────

DO $$ BEGIN
    CREATE TYPE {{schema}}.token_measurement_basis AS ENUM (
        'exact',
        'provider_aggregate',
        'derived_estimate'
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE TYPE {{schema}}.telemetry_granularity AS ENUM (
        'hour',
        'day'
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ─────────────────────────────────────────────
-- Core Table
-- ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS {{schema}}.token_usage (
    id                  BIGSERIAL   PRIMARY KEY,
    source_system       TEXT        NOT NULL,
    provider            TEXT        NOT NULL,
    model               TEXT        NOT NULL,
    model_id            TEXT        NOT NULL,
    window_start        TIMESTAMPTZ NOT NULL,
    window_end          TIMESTAMPTZ NOT NULL,
    granularity         {{schema}}.telemetry_granularity   NOT NULL,
    measurement_basis   {{schema}}.token_measurement_basis NOT NULL,
    input_tokens        BIGINT      NOT NULL DEFAULT 0,
    output_tokens       BIGINT      NOT NULL DEFAULT 0,
    cached_read_tokens  BIGINT,
    cached_write_tokens BIGINT,
    cost_usd            NUMERIC(12,6),
    user_id             TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_token_usage_window
        UNIQUE (source_system, model_id, window_start, window_end, user_id)
);

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

CREATE INDEX IF NOT EXISTS idx_token_usage_window_start
    ON {{schema}}.token_usage (window_start DESC);

CREATE INDEX IF NOT EXISTS idx_token_usage_source_window
    ON {{schema}}.token_usage (source_system, window_start DESC);

CREATE INDEX IF NOT EXISTS idx_token_usage_provider_model_window
    ON {{schema}}.token_usage (provider, model_id, window_start DESC);

CREATE INDEX IF NOT EXISTS idx_token_usage_user_window
    ON {{schema}}.token_usage (user_id, window_start DESC)
    WHERE user_id IS NOT NULL;

COMMIT;
