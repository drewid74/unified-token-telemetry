# Unified Token Telemetry Architecture

The Unified Token Telemetry system provides a centralized repository for tracking token consumption across multiple AI providers and systems. It ingests high-frequency metrics from LiteLLM and integrates manual or derived estimates from other sources to provide a complete picture of model usage and costs.

## System Components

### Containers
* **rollup worker**: Runs on node:22-alpine in daemon mode. Executes every 60 minutes to poll Prometheus and update the database. Restarts unless stopped.
* **dashboard**: A standalone Next.js 15 application serving the UI and a JSON API at `/api/burn-data`.

### Database
The primary data store is the `public.token_usage` table in your PostgreSQL database.
* **Location**: Configured via `DATABASE_URL` environment variable (internal Docker alias or external host).
* **Constraint**: A unique constraint ensures data integrity across `(source_system, model_id, window_start, window_end, user_id)`, where NULLs are treated as distinct values.

### Visualization
* **Grafana Dashboard**: "Token Telemetry" (uid: `unified-token-telemetry`) — pointed at your Grafana instance.
* **Panels**: Includes cost trends, cache efficiency analysis, and a breakdown of usage by source.

## Data Flow

The telemetry pipeline follows this path:
1. **LiteLLM**: Serves raw metrics at `${LITELLM_HOST}:${LITELLM_PORT}`.
2. **Prometheus**: Scrapes LiteLLM via a configured scrape job.
3. **Rollup worker**: Queries the Prometheus API at 60-minute intervals.
4. **PostgreSQL**: Stores processed usage records in `public.token_usage`.
5. **Dashboard**: Consumes database records to serve the UI and `/api/burn-data`.
6. **Grafana**: Visualizes the aggregated data using the PostgreSQL datasource.

Additional sources feed directly into the `token_usage` table via dedicated ingestion scripts for manual or estimated metrics.

## Key Invariants
* **Upsert Logic**: New data replaces existing records for the same window rather than being added to them.
* **Cache Precision**: Unknown cache values stay NULL instead of defaulting to zero.
* **Collection Safety**: Ingestion handles counter resets to ensure accurate totals.
* **Basis Clarity**: The `measurement_basis` field distinguishes between exact, aggregate, and estimated data.

See **`references/invariants.md`** for the full numbered list (13 invariants as of this writing). See **`references/operational-lessons.md`** for the real-world failures that produced each invariant.

## Freshness Detection (Phase 1)

Two-layer architecture so that "the worker itself died" is detectable independently of any source:

### Layer 1 — In-process freshness (runFreshnessCheck)

After every cycle, the worker writes one row per known source into `public.watchdog_status`, plus a synthetic `__heartbeat__` row about itself:

* Each source row stores its `status` (`ok` / `stale` / `never_seen` / `paused`), a per-source `threshold_seconds` (tuned to that source's cadence — see `SOURCE_THRESHOLDS_SECONDS` in the worker template), and a human-readable `message`.
* The `__heartbeat__` row is updated to NOW() on every cycle; if it stops being touched, the worker is dead and any other 'ok' rows in the table are stale-by-default.
* Liveness uses `MAX(updated_at)` (not `MAX(created_at)`) — see **invariants §10** for why this matters for replay-style daemons.
* The `SOURCE_STATE_OVERRIDE` map lets you mark sources as `paused` (e.g., daemon installed but no credentials on this machine) so they don't perma-alert as `never_seen` or `stale`. See **invariants §11**.

### Layer 2 — External freshness reader (watchdog-reader.template.sh)

An out-of-process script that reads `watchdog_status` on its own schedule (cron / systemd timer / GitHub Actions schedule). Exit codes:

* **0** — all sources `ok` or `paused` (paused doesn't count as failure)
* **1** — at least one source is `stale` (real failure needing attention)
* **2** — `__heartbeat__` is itself stale (worker is down — meta-failure)
* **3** — script error (DB unreachable, container missing)

Without Layer 2, "worker died and stopped writing" is invisible because all the in-DB rows remain at their last-good `last_check_at` value. Layer 2 catches this because the `__heartbeat__` row's age exceeds its threshold.

The reference reader implementation is `templates/consumers/watchdog-reader.template.sh`. Cron line:
```
*/5 * * * * /opt/telemetry/watchdog.sh --quiet >> /var/log/telemetry_watchdog.log 2>&1
```

## Backfill & Resume (Phase 2 T0.8)

The rollup is **watermark-driven**, not "one window per cycle." On each tick it:

1. Reads `public.rollup_watermark.last_processed_end` for `(source_system, user_id)`.
2. Computes the time range from `watermark + 15min` (resume point) to `floor(now − lag) / 15min` (newest closed window).
3. Issues ONE Prometheus `query_range` per metric covering the entire range with `step=900s` (each evaluation point computes its own `increase(metric[15m] @ T)` window — tiles exactly, no overlap, no double-count). See **invariants §13**.
4. Iterates windows chronologically, upserts non-zero-token rows, advances the watermark after each successful upsert.
5. Runs the freshness check (`runFreshnessCheck`) so `__heartbeat__` and per-source `watchdog_status` rows stay current.

**Properties:**
* **Steady state (no gap)**: 1 DB read + 1 Prom round-trip per metric, 0 window-loop iterations.
* **Post-outage**: backfills up to `min(Prometheus retention, max_backfill_minutes)` worth of windows in one cycle.
* **Idempotent**: re-running over already-covered windows produces zero new rows (UPDATE-only via `ON CONFLICT DO UPDATE`). Row counts never change; only `updated_at` advances.
* **Safety belt**: if the watermark is ever off-grid (manual SQL, restore from backup), the loop snaps it FORWARD to the next 15-min boundary and logs a WARN — never produces misaligned `window_start` values. See **invariants §12**.
* **Hard cap**: `CONFIG.scheduler.max_backfill_minutes` (default 1440 = 24h) limits any single cycle's work even if Prometheus retention is longer. A multi-day outage will recover up to the cap per cycle and finish on subsequent cycles.
* **Retention floor**: probed via `prometheus_tsdb_lowest_timestamp_seconds` self-metric, falling back to the `storage.tsdb.retention.time` flag, then to 15 days. Any watermark older than the floor logs a WARN naming the unrecoverable span and the loop caps at the floor.
* **In-flight mutex**: daemon mode uses an `isRunning` flag so `setInterval` cannot stack overlapping cycles when an initial seed exceeds `interval_minutes`.

**Operational notes:**
* The `rollup_watermark` table is small (one row per `(source_system, user_id)`), trivial to inspect / reset.
* The watermark advances independently of whether a window produced rows, so a long quiet stretch does NOT cause every subsequent cycle to re-scan empty windows.
* To force a one-time backfill: `UPDATE public.rollup_watermark SET last_processed_end = <aligned timestamp> WHERE source_system='litellm'` (must be on a 15-min boundary; the snap-guard will round forward if not).

## Operational Procedures

### Management Commands
* **Restart Rollup**: `docker restart <rollup_container>`
* **View Logs**: `docker logs <rollup_container> --tail 20`
* **Manual Run**: `docker exec <rollup_container> node /app/rollup.js --once`

### Rebuilding Dashboard
To update the dashboard image and redeploy:
```bash
cd <path-to-dashboard-image>
docker build -t token-burn:latest .
docker compose up -d --force-recreate <dashboard_service>
```

## Network Configuration
The rollup container communicates using internal Docker aliases:
* Prometheus: `<prometheus_alias>:9090`
* Database: `<db_alias>:5432`

The dashboard uses the host-accessible database address defined in the `DATABASE_URL` environment variable.

## Portability
This reference describes the general architecture. Your specific instance configuration lives in `instances/<your-name>/`. See `templates/config.template.yaml` for all configurable values.
