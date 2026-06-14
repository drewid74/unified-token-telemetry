# Adapter Contract

Every source adapter must implement this interface. The worker calls these methods in order.

---

## Interface

```typescript
interface TokenAdapter {
  readonly sourceSystem: string;    // Matches source_system column: 'litellm', 'copilot', 'manual'
  readonly displayName: string;     // Human-readable name for logs

  /**
   * Confirms the source is reachable and reports what data it can provide.
   * Called once at startup. Throws if source is unreachable.
   */
  detectCapabilities(): Promise<AdapterCapabilities>;

  /**
   * Fetches raw token data for the given time window.
   * @param windowStart - Inclusive start of collection window (UTC)
   * @param windowEnd   - Exclusive end of collection window (UTC)
   */
  collectWindow(windowStart: Date, windowEnd: Date): Promise<RawRecord[]>;

  /**
   * Converts a raw source record into a canonical token_usage row shape.
   * Must return null for records that should be skipped (e.g., test models).
   */
  normalizeRecord(raw: RawRecord): CanonicalRecord | null;

  /**
   * Maps provider-specific token count type to the measurement_basis enum.
   * Called per-record during normalization.
   */
  mapMeasurementBasis(rawType: string): 'exact' | 'provider_aggregate' | 'derived_estimate';
}
```

---

## Type Definitions

```typescript
interface AdapterCapabilities {
  granularity: 'hour' | 'day';
  hasCacheData: boolean;           // false for Copilot; true for Anthropic via LiteLLM
  measurementBasis: 'exact' | 'provider_aggregate' | 'derived_estimate';
  supportsBackfill: boolean;       // Whether adapter can fetch historical windows
  models?: string[];               // Known models if discoverable at startup
}

interface CanonicalRecord {
  source_system:       string;
  provider:            string;
  model:               string;
  model_id:            string;
  window_start:        Date;
  window_end:          Date;
  granularity:         'hour' | 'day';
  measurement_basis:   'exact' | 'provider_aggregate' | 'derived_estimate';
  input_tokens:        number;
  output_tokens:       number;
  cached_read_tokens:  number | null;   // null = not reported by provider
  cached_write_tokens: number | null;   // null = not reported by provider
  cost_usd:            number | null;
  user_id:             string | null;   // null = org-level aggregate
}
```

---

## Window Resolution Contract

The worker resolves collection windows by querying the database:

```sql
SELECT MAX(window_end) AS last_collected
FROM {{schema}}.token_usage
WHERE source_system = $1
  AND model_id = $2
  AND user_id IS NOT DISTINCT FROM $3;
```

- If no rows exist: start from `config.backfill.default_start` or adapter-defined default.
- If rows exist: start from `last_collected` (exclusive; next window begins there).
- Worker truncates `windowEnd` to the current time minus `config.scheduler.lag_minutes` to avoid collecting incomplete windows.

---

## Upsert Contract

The worker performs the upsert. Adapters do not write to the database directly.

```sql
INSERT INTO {{schema}}.token_usage (
    source_system, provider, model, model_id,
    window_start, window_end, granularity, measurement_basis,
    input_tokens, output_tokens, cached_read_tokens, cached_write_tokens,
    cost_usd, user_id
) VALUES (...)
ON CONFLICT (source_system, model_id, window_start, window_end, user_id)
DO UPDATE SET
    provider            = EXCLUDED.provider,
    model               = EXCLUDED.model,
    granularity         = EXCLUDED.granularity,
    measurement_basis   = EXCLUDED.measurement_basis,
    input_tokens        = EXCLUDED.input_tokens,
    output_tokens       = EXCLUDED.output_tokens,
    cached_read_tokens  = EXCLUDED.cached_read_tokens,
    cached_write_tokens = EXCLUDED.cached_write_tokens,
    cost_usd            = EXCLUDED.cost_usd,
    updated_at          = NOW();
```

---

## Error Handling Contract

| Scenario | Required behavior |
|----------|-------------------|
| Source unreachable at startup | `detectCapabilities()` throws; worker skips this adapter and logs error |
| Source unreachable during collection | `collectWindow()` throws; worker skips this window and logs; retries next run |
| Partial data returned | Adapter must upsert what it has; log what was skipped |
| Empty window (no activity) | Return empty array `[]`; worker logs "0 records" and continues |
| Normalization error on one record | Log the raw record and error; skip that record; continue with remaining |

---

## Invariant Responsibilities

| Invariant | Enforced by |
|-----------|-------------|
| NULL for unknown cache | Adapter — set `cached_*_tokens = null` when provider doesn't report |
| Counter reset detection | Adapter (LiteLLM only) — compare current vs last Prometheus counter value |
| Correct measurement_basis | Adapter — call `mapMeasurementBasis()` per record |
| Replacement upserts | Worker — uses ON CONFLICT DO UPDATE; adapters must not pre-aggregate |
