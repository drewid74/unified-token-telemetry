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
        'day',
        '15min',
        'month'
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Idempotent enum top-up: if the type existed at an earlier version, add missing values.
-- ADD VALUE IF NOT EXISTS requires PG 9.6+; safe to re-run.
DO $$ BEGIN
    ALTER TYPE {{schema}}.telemetry_granularity ADD VALUE IF NOT EXISTS '15min';
    ALTER TYPE {{schema}}.telemetry_granularity ADD VALUE IF NOT EXISTS 'month';
EXCEPTION WHEN others THEN NULL;
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
    -- NULLS NOT DISTINCT is required: user_id IS NULL is legal (org-level rows for Copilot,
    -- subscriptions, or any source without per-user attribution). Without this clause, PG treats
    -- NULL ≠ NULL so the conflict key never matches → cron retries silently DUPLICATE every org
    -- row (invariant §1 violation). Requires PG 15+. For PG <15, use the partial-unique-index
    -- pattern below instead (commented).
    CONSTRAINT uq_token_usage_window
        UNIQUE NULLS NOT DISTINCT (source_system, model_id, window_start, window_end, user_id)
);

-- PG <15 fallback: replace the constraint above with two partial unique indexes.
-- Uncomment ONLY if your Postgres is older than 15.
--
-- CREATE UNIQUE INDEX IF NOT EXISTS uq_token_usage_window_user
--     ON {{schema}}.token_usage (source_system, model_id, window_start, window_end, user_id)
--     WHERE user_id IS NOT NULL;
-- CREATE UNIQUE INDEX IF NOT EXISTS uq_token_usage_window_org
--     ON {{schema}}.token_usage (source_system, model_id, window_start, window_end)
--     WHERE user_id IS NULL;

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

-- ─────────────────────────────────────────────
-- Watchdog Status — Phase 1 freshness detection
-- ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS {{schema}}.watchdog_status (
    source_system        TEXT        PRIMARY KEY,
    status               TEXT        NOT NULL,
    threshold_seconds    INTEGER     NOT NULL,
    stale_seconds        BIGINT,
    last_ingest_at       TIMESTAMPTZ,
    last_check_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    message              TEXT,
    checked_by           TEXT        NOT NULL,
    CONSTRAINT watchdog_status_status_chk
        CHECK (status IN ('ok','stale','never_seen','paused','unknown'))
);

CREATE INDEX IF NOT EXISTS idx_watchdog_status_stale
    ON {{schema}}.watchdog_status (status, last_check_at DESC)
    WHERE status <> 'ok';

-- Phase 2 T0.8: rollup_watermark (backfill resume pointer).
CREATE TABLE IF NOT EXISTS {{schema}}.rollup_watermark (
    source_system          TEXT        NOT NULL,
    user_id                TEXT,
    last_processed_end     TIMESTAMPTZ NOT NULL,
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    notes                  TEXT,
    CONSTRAINT uq_rollup_watermark UNIQUE NULLS NOT DISTINCT (source_system, user_id)
);

COMMIT;
