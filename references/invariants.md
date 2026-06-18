# Invariants

Non-negotiable rules for the unified-token-telemetry system. Violating any of these causes silent data corruption or double-counting.

---

## 1. Upserts Are Replacement, Not Additive

**Rule:** Every write uses `INSERT ... ON CONFLICT DO UPDATE SET ... = EXCLUDED.*`. Running the same window collection twice must produce identical totals.

**Why it matters:** Workers run on cron. If the last run succeeded but the process crashed before logging, the next run re-collects the same window. Additive writes would double-count every retry.

**Implementation:** The conflict key `(source_system, model_id, window_start, window_end, user_id)` identifies a unique fact. All token columns are overwritten on conflict — not incremented.

**Check:** Run the worker twice for the same window. Row count must not increase. Token totals must not change.

---

## 2. NULL for Unknown Cache, Not Zero

**Rule:** `cached_read_tokens` and `cached_write_tokens` are `NULL` when the provider does not report cache data — never `0`.

**Why it matters:**
- `0` means "provider confirmed zero cache activity this window"
- `NULL` means "provider does not expose this metric"
- Cache efficiency queries (`cached_read / input * 100`) must exclude `NULL` rows or they produce misleading 0% results

**Provider-specific rules:**

| Provider | cached_read_tokens | cached_write_tokens |
|----------|--------------------|---------------------|
| Anthropic (via LiteLLM) | value or 0 | value or 0 |
| OpenAI (via LiteLLM) | value or 0 | NULL (not reported) |
| GitHub Copilot | **NULL** | **NULL** |
| Manual import | set per source | set per source |

**Check:** `SELECT COUNT(*) FROM token_usage WHERE source_system = 'copilot' AND cached_read_tokens IS NOT NULL` must return 0.

---

## 3. Counter Reset Handling (LiteLLM Prometheus)

**Rule:** Prometheus counters reset to 0 on container restart. If the current scraped counter value is less than the last recorded value, treat the current value as the delta for that window — not `current - last`.

**Why it matters:** A counter reset looks like a massive negative delta if you subtract naively. The adapter must detect this and fall back to treating the current counter as the full window delta.

**Detection logic:**
```
if current_counter < last_recorded_counter:
    delta = current_counter          # container restarted; counter started fresh
else:
    delta = current_counter - last_recorded_counter
```

**Limitation:** If a restart happens within a window and tokens accumulate beyond the pre-restart value, the reset is undetectable. This is a known accuracy limitation — document it, don't paper over it.

---

## 4. measurement_basis Meanings

**Rule:** The `measurement_basis` column must accurately reflect how tokens were counted. Do not upgrade or downgrade without changing the source logic.

| Value | When to use |
|-------|-------------|
| `exact` | Tokens came directly from per-request API responses (e.g., LiteLLM passes through provider token counts) |
| `provider_aggregate` | Provider pre-summed before you received it (e.g., Copilot `/metrics/reports` daily total) |
| `derived_estimate` | You calculated the number from a proxy (e.g., character count, pricing back-calculation, model heuristic) |

**Cost math rule:** Only `exact` and `provider_aggregate` rows should feed cost dashboards without a confidence caveat. `derived_estimate` rows should be visually distinguished in consumers.

---

## 5. Cache Efficiency Query Exclusion Rule

**Rule:** Any query computing cache efficiency (hit rate, cache savings) MUST filter to rows where `cached_read_tokens IS NOT NULL`.

**Correct:**
```sql
SELECT
    provider,
    SUM(cached_read_tokens)::float / NULLIF(SUM(input_tokens), 0) * 100 AS cache_hit_pct
FROM token_usage
WHERE cached_read_tokens IS NOT NULL   -- exclude providers with no cache telemetry
  AND window_start >= NOW() - INTERVAL '7 days'
GROUP BY provider;
```

**Incorrect (silent zero for Copilot rows):**
```sql
-- Missing WHERE clause — Copilot NULL rows pull cache_hit_pct toward 0 incorrectly
SELECT SUM(cached_read_tokens) / SUM(input_tokens) * 100 FROM token_usage;
```

---

## 6. Window Boundaries Are Inclusive/Exclusive

**Rule:** `window_start` is inclusive, `window_end` is exclusive. A one-hour window from 14:00 to 15:00 UTC is stored as `window_start = '2024-01-15 14:00:00+00'`, `window_end = '2024-01-15 15:00:00+00'`.

**Why it matters:** Adjacent windows must not overlap. `window_end` of window N equals `window_start` of window N+1.

---

## 7. NULLS NOT DISTINCT on the Conflict Key

**Rule:** The `token_usage` unique constraint must use `UNIQUE NULLS NOT DISTINCT (...)` (PostgreSQL 15+). For PG <15, use a paired partial-unique-index pattern (one WHERE `user_id IS NOT NULL`, one WHERE `user_id IS NULL`). Never use a plain `UNIQUE (...)` because Postgres treats `NULL ≠ NULL`.

**Why it matters:** `user_id IS NULL` is legal — it identifies org-level rows (Copilot org totals, monthly subscriptions, anything without per-user attribution). A plain `UNIQUE` constraint silently fails to fire ON CONFLICT for NULL-user rows, so every cron retry inserts a duplicate org row. The bug compounds invisibly until the dashboard shows a doubling or tripling of one source.

**Check:**
```sql
SELECT source_system, user_id, COUNT(*)
FROM token_usage
WHERE user_id IS NULL
GROUP BY source_system, user_id, model_id, window_start, window_end
HAVING COUNT(*) > 1;
```
Must return zero rows.

---

## 8. HTTP Calls Have Socket Deadlines

**Rule:** Every `http.get` / `fetch` in adapters and collectors MUST register a 15-second socket deadline. Plain `http.get` has no default timeout — a hung TCP connection blocks forever.

**Why it matters:** Cron-scheduled adapters that hang silently look identical to "the cron task never ran." The next cron tick spawns a second process, stacking until OOM. A 15s deadline forces a clean failure and exit 1, which cron monitoring can detect.

**Pattern (Node.js native):**
```js
const req = lib.get(url, res => { ... });
req.on('error', reject);
req.setTimeout(15_000, () => req.destroy(new Error(`HTTP timeout (15s) for ${url}`)));
```

**Pattern (`fetch` API):**
```js
const resp = await fetch(url, { signal: AbortSignal.timeout(15_000) });
```

---

## 9. Exit Code 2 on Partial Source Failure

**Rule:** When the multi-source worker runs and one or more (but not all) enabled sources fail, it MUST exit with code 2. Reserve code 1 for fatal/startup errors and code 0 for "all enabled sources succeeded."

**Why it matters:** Without a distinct partial-failure code, a cron monitoring rule like "alert on non-zero exit" either (a) over-fires on routine retries or (b) under-fires because one source silently dies and the run still exits 0. The exit code matrix lets cron differentiate "config broken" (1) from "OpenAI Org API returned 401, others fine" (2).

**Implementation:** Track per-source errors in `sourceErrors[]`. Return `{ totalUpserted, sourcesTried, sourceErrors }` from the cycle. Main calls `process.exit(2)` when `sourceErrors.length > 0`.

---

## 10. Freshness Liveness Uses MAX(updated_at), Never MAX(created_at)

**Rule:** The watchdog / freshness check MUST compute "last ingest" as `MAX(updated_at)`, not `MAX(created_at)`. This is invariant-critical for any source whose daemon does idempotent replays.

**Why it matters:** `created_at` only changes on INSERT. A daemon that polls existing session files (e.g., `~/.claude/projects/*.jsonl`) for new tokens and finds no new sessions correctly does ON CONFLICT UPDATE — the row is touched but not inserted. `MAX(created_at)` stays frozen at the original insert timestamp. The freshness check then falsely reports the daemon as stale, when it's actually alive and just running idempotent upserts.

**`updated_at` refreshes on every UPSERT** via the trigger or explicit `updated_at = NOW()` clause, so it's the true "daemon proof of life" timestamp.

**Correct:**
```sql
SELECT source_system, MAX(updated_at) AS last_ingest_at
FROM token_usage
WHERE source_system = ANY($1)
GROUP BY source_system;
```

**Incorrect (silent false-positive staleness for replay sources):**
```sql
SELECT source_system, MAX(created_at) AS last_ingest_at FROM token_usage GROUP BY source_system;
```

---

## 11. SOURCE_STATE_OVERRIDE for "Intentionally Offline" Sources

**Rule:** The freshness checker must support a per-source `paused` override. Sources that are configured-but-not-operating-here (e.g., daemon installed but no credential / no source data on this machine) should be tagged `paused` with an actionable message, not `never_seen` or `stale`.

**Why it matters:** Without this override, three legitimate states all look like "broken":
- `never_seen` — daemon configured but never wrote a row (e.g., needs API key)
- `stale` — daemon wrote rows once then died
- `paused` — daemon working correctly but has nothing to do here

`paused` rows do not trigger the NAS-side watchdog exit-code-1 (they count as ok). The `message` field carries the actionable next step ("set OPENAI_ADMIN_KEY env var", "rotate GitHub PAT with read:org scope", etc.) so an operator restoring the source knows what to fix.

**Schema:** `watchdog_status_status_chk` includes `'paused'`.

---

## 12. Watermark Must Be Wall-Clock Aligned

**Rule:** The `rollup_watermark.last_processed_end` value must always be a 15-minute (or whatever your window cadence is) wall-clock boundary: `:00`, `:15`, `:30`, `:45`. Code that advances the watermark must use exact `window_ms` arithmetic from an already-aligned base.

**Why it matters:** If the watermark is ever off-grid (operator SQL, restore from backup with a freshly-NOW()'d cursor), the backfill loop iterates `+ window_ms` from that misaligned base, producing windows with `window_start` values like `14:42:26` instead of `14:45:00`. These rows are technically valid but break the schema convention every consumer expects.

**Safety belt:** On read, if `(last_processed_end % window_ms) !== 0`, snap FORWARD to `Math.ceil(last_processed_end / window_ms) * window_ms` and log a WARN. Never snap backward (would re-process already-covered windows).

---

## 13. Prometheus query_range vs Per-Window Queries

**Rule:** For multi-window backfill, use `/api/v1/query_range?step=<window_ms>` with `step == range == window_ms`. Do NOT iterate per-window instant queries (`/api/v1/query`) for >1 window. Both produce identical numerical results (instant evaluations tile exactly), but query_range collapses N queries into ONE HTTP round-trip.

**Why it matters:** A multi-day backfill via instant queries = thousands of sequential HTTP calls. The same backfill via `query_range` = 1 call per metric. The first variant routinely fails with timeouts or rate-limit responses on slow networks; the second is a single ~50ms call.

**Boundary safety:** `query_range` with `step == range == window_ms` partitions the range into non-overlapping windows. Each evaluation point T computes `(T-window_ms, T]`, so the boundary sample lands in exactly one window. Adjacent windows never double-count.

**Out-of-retention guard:** Before issuing query_range, probe `prometheus_tsdb_lowest_timestamp_seconds` (self-metric) and clamp the start to that value. Backfilling beyond retention returns 0 series but burns network round-trips.

---
