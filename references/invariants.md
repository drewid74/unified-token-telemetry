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
