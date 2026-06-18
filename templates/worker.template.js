/**
 * Unified Token Telemetry — Worker Template
 *
 * Generic orchestrator. Configure adapters, point at your config.yaml.
 * Runs on cron or as a long-running process with setInterval.
 *
 * Flow: load config → build adapter → resolve window → query Prometheus
 *       → normalize → upsert → log
 *
 * Environment variables required:
 *   TELEMETRY_PG_USER, TELEMETRY_PG_PASSWORD
 *   (Any other secrets referenced in config.yaml as ${ENV_VAR})
 *
 * Usage:
 *   node worker.template.js <path/to/config.yaml>
 *   node worker.template.js <path/to/config.yaml> --once     (default behavior)
 *   node worker.template.js <path/to/config.yaml> --daemon   (run on interval)
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { Pool } = require('pg');
const https = require('https');
const http  = require('http');
const url   = require('url');

// ─────────────────────────────────────────────
// Config Loading
// ─────────────────────────────────────────────

function loadConfig(configPath) {
  const raw = fs.readFileSync(configPath, 'utf8');
  const cfg = yaml.load(raw);
  return resolveEnvRefs(cfg);
}

function resolveEnvRefs(obj) {
  if (typeof obj === 'string') {
    return obj.replace(/\$\{([^}]+)\}/g, (_, key) => {
      const val = process.env[key];
      if (val === undefined) throw new Error(`Missing env var: ${key}`);
      return val;
    });
  }
  if (Array.isArray(obj)) return obj.map(resolveEnvRefs);
  if (obj && typeof obj === 'object') {
    return Object.fromEntries(
      Object.entries(obj).map(([k, v]) => [k, resolveEnvRefs(v)])
    );
  }
  return obj;
}

// ─────────────────────────────────────────────
// HTTP Helper
// ─────────────────────────────────────────────

function httpGet(rawUrl) {
  return new Promise((resolve, reject) => {
    const parsed = new url.URL(rawUrl);
    const lib    = parsed.protocol === 'https:' ? https : http;
    const req = lib.get(rawUrl, res => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        reject(new Error(`HTTP ${res.statusCode} for ${rawUrl}`));
        res.resume();
        return;
      }
      const chunks = [];
      res.on('data',  c  => chunks.push(c));
      res.on('end',   () => {
        // Guard JSON.parse — a non-JSON 2xx body (text health endpoint, HTML 502
        // page from a transparent proxy) otherwise throws synchronously inside
        // this event handler, becoming an uncaughtException that kills the
        // daemon. Reject the promise instead.
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
        catch (e) { reject(new Error(`HTTP parse error for ${rawUrl}: ${e.message}`)); }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    // Socket-level deadline. Without this a TCP-established-but-silent server
    // (Prometheus restart/compaction, half-open NAT) hangs the cycle forever.
    req.setTimeout(15_000, () => req.destroy(new Error(`HTTP timeout (15s) for ${rawUrl}`)));
  });
}

// ─────────────────────────────────────────────
// Postgres Client
// ─────────────────────────────────────────────

function createPool(cfg) {
  return new Pool({
    host:     cfg.postgres.host,
    port:     Number(cfg.postgres.port),
    database: cfg.postgres.database,
    user:     cfg.postgres.user,
    password: cfg.postgres.password,
    ssl:      cfg.postgres.ssl || false,
    max:      5,
  });
}

// ─────────────────────────────────────────────
// Window Resolution
// ─────────────────────────────────────────────

/**
 * Returns the last completed hourly window, adjusted by lag_minutes.
 *
 * window_end   = floor(now - lag, hour)   [exclusive upper bound]
 * window_start = window_end - 1h          [inclusive lower bound]
 *
 * Querying increase(metric[1h]) at time=window_end in Prometheus gives exactly
 * the increase over [window_start, window_end).
 */
function resolveWindow(cfg) {
  const lagMs   = ((cfg.scheduler?.lag_minutes) || 0) * 60_000;
  const nowMs   = Date.now() - lagMs;
  const floorMs = Math.floor(nowMs / 3_600_000) * 3_600_000;

  return {
    windowStart:  new Date(floorMs - 3_600_000),
    windowEnd:    new Date(floorMs),
    windowEndTs:  floorMs / 1000,   // Unix seconds for Prometheus ?time= param
  };
}

// ─────────────────────────────────────────────
// Prometheus Query
// ─────────────────────────────────────────────

/**
 * Execute a Prometheus instant query at a specific Unix timestamp.
 * Returns a map: `${model}::${model_id}` → { value: number, labels: object }
 *
 * Negatives are clamped to 0 — increase() can return negative on very short
 * windows; counter-reset safety is already baked into increase() per Prometheus
 * spec (it detects drops and adjusts), but we add a floor as defence-in-depth.
 */
async function queryPrometheus(promUrl, metricExpr, atTimestamp) {
  const u = `${promUrl}/api/v1/query?query=${encodeURIComponent(metricExpr)}&time=${atTimestamp}`;
  const json = await httpGet(u);

  if (json.status !== 'success') {
    throw new Error(`Prometheus returned status=${json.status} for: ${metricExpr}`);
  }

  const result = {};
  for (const series of (json.data?.result || [])) {
    const raw = series.value?.[1];
    if (raw == null || raw === 'NaN' || raw === '+Inf' || raw === '-Inf') continue;
    const val = parseFloat(raw);
    if (!isFinite(val)) continue;

    const model    = series.metric.model    || '';
    const model_id = series.metric.model_id || '';
    const key = `${model}::${model_id}`;
    result[key] = {
      value:  Math.max(0, val),   // floor at 0 — counter-reset guard
      labels: series.metric,
    };
  }
  return result;
}

// ─────────────────────────────────────────────
// Provider Derivation
// ─────────────────────────────────────────────

/**
 * Derive provider from model name and model_id labels.
 * Cloud models (claude, gpt, gemini) have recognizable names.
 * Local vLLM/Ollama models use the host prefix of model_id.
 */
function deriveProvider(model, modelId) {
  const m   = (model   || '').toLowerCase();
  const mid = (modelId || '').toLowerCase();

  if (m.includes('claude') || mid.includes('anthropic')) return 'anthropic';
  if (m.includes('gpt') || m.match(/^o[13]-/) || mid.includes('openai')) return 'openai';
  if (m.includes('gemini')) return 'google';

  // Local inference — first segment of model_id (e.g. "host1", "gpu-box", "local-server")
  const hostPrefix = (modelId || '').split('-')[0];
  return hostPrefix || 'local';
}

// ─────────────────────────────────────────────
// Cost Calculation
// ─────────────────────────────────────────────

/**
 * Calculate cost_usd from the pricing map in config.
 * Returns 0 for models not in the map (local models).
 * All pricing values are per-million tokens.
 */
function calcCost(pricingCfg, model, inputTokens, outputTokens, cachedReadTokens) {
  const models = pricingCfg?.models || {};
  const p = models[model];
  if (!p) return 0.0;

  let cost = (inputTokens  / 1_000_000) * (p.input_per_million  || 0);
  cost    += (outputTokens / 1_000_000) * (p.output_per_million || 0);
  if (cachedReadTokens != null && p.cache_read_per_million != null) {
    cost += (cachedReadTokens / 1_000_000) * p.cache_read_per_million;
  }
  return Math.round(cost * 1_000_000) / 1_000_000;  // μUSD precision
}

// ─────────────────────────────────────────────
// Upsert  (replacement semantics — invariant §1)
// ─────────────────────────────────────────────

const UPSERT_SQL = `
INSERT INTO {{schema}}.token_usage (
    source_system, provider, model, model_id,
    window_start, window_end, granularity, measurement_basis,
    input_tokens, output_tokens, cached_read_tokens, cached_write_tokens,
    cost_usd, user_id
) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
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
    updated_at          = NOW()
`;

async function upsertRecords(pool, schema, records) {
  if (!records.length) return 0;
  const sql = UPSERT_SQL.replace(/\{\{schema\}\}/g, schema);
  let count = 0;
  for (const r of records) {
    await pool.query(sql, [
      r.source_system,      r.provider,           r.model,              r.model_id,
      r.window_start,       r.window_end,          r.granularity,        r.measurement_basis,
      r.input_tokens,       r.output_tokens,       r.cached_read_tokens, r.cached_write_tokens,
      r.cost_usd,           r.user_id,
    ]);
    count++;
  }
  return count;
}

// ─────────────────────────────────────────────
// Freshness Check (Phase 1: T0.1 + D7)
// ─────────────────────────────────────────────
//
// After every cycle, write one row per known source into watchdog_status.
// A separate process (NAS-side bash script, k8s sidecar, whatever) reads
// that table and alerts when status <> 'ok' for too long.
//
// Architecture decisions:
//   - Thresholds are tuned to each source's actual cadence. A flat 30-min
//     threshold would perma-stale anything that polls daily.
//   - SOURCE_STATE_OVERRIDE lets you mark sources 'paused' (e.g., daemon
//     installed but no credentials on this machine) so they don't perma-alert
//     as 'never_seen' or 'stale'. See invariants.md §11.
//   - __heartbeat__ is a synthetic row this function writes about itself —
//     if it goes stale, the freshness checker itself is dead and every other
//     'ok' row is suspect. See invariants.md §10 for the MAX(updated_at) bug
//     that this layer surfaces.
//
// Tune SOURCE_THRESHOLDS_SECONDS to match your collection cadence. Defaults
// below cover the 6 PUBLIC adapters shipped in templates/adapters/ plus FOUR
// example extension-pattern names (opencode / copilot_otel / codex_cli /
// anthropic_desktop) that you can wire up as instance-side daemons writing
// directly into token_usage. Those four are NOT shipped as public adapters —
// they're listed here as reference cadences for common collector patterns.
// Add or remove entries to match the source_systems YOUR deployment writes.

const SOURCE_THRESHOLDS_SECONDS = {
  // ── Public adapters (templates/adapters/) ─────────────────────────────
  litellm:           30 * 60,        // litellm-prometheus  (2x 15-min cycle)
  copilot:           30 * 3600,      // copilot-daily       (daily + 6h buffer)
  openai_api:        30 * 3600,      // openai-usage        (daily + 6h buffer)
  anthropic_api:     30 * 3600,      // anthropic-usage     (daily + 6h buffer)
  subscription:      35 * 86400,     // subscription        (monthly + 5d buffer)
  // (manual-import is event-driven, no freshness threshold by default)

  // ── Extension-pattern examples (NOT public adapters — wire your own) ──
  // These names are common instance-side daemons. Remove the entries you
  // don't use; otherwise the freshness checker will perma-tag them
  // 'never_seen' (which is informational only, not a failure).
  opencode:          45 * 60,        // opencode session SQLite tailer    (3x 15-min)
  copilot_otel:      24 * 3600,      // VS Code Copilot Chat OTel SQLite  (bursty)
  codex_cli:         24 * 3600,      // Codex CLI session JSONL tailer    (bursty)
  anthropic_desktop: 30 * 3600,      // Claude Desktop session JSONL      (daily + 6h)

  // ── Dead-man's-switch (must match the worker cycle interval × 2) ──────
  __heartbeat__:     30 * 60,
};

// Per-source explicit state overrides. Use 'paused' for sources that are
// CONFIGURED-BUT-NOT-OPERATING here (daemon installed but no credentials,
// or no source data on this machine). See invariants.md §11.
//
// Each entry: { status: 'paused', message: 'actionable next step' }
// Example values (uncomment + tune for YOUR deployment):
//
//   codex_cli:  { status: 'paused', message: 'no ~/.codex/sessions on this host; daemon has nothing to read' },
//   openai_api: { status: 'paused', message: 'daemon requires OPENAI_ADMIN_KEY env var (not set)' },
//   copilot:    { status: 'paused', message: 'daemon getting HTTP 403 from GitHub API — fix PAT scope/expiry/org' },
//
// Remove an entry once the source is genuinely operational; the regular
// stale-detection logic will take over.
const SOURCE_STATE_OVERRIDE = {
  // Populate per-deployment.
};

const WATCHDOG_UPSERT_SQL = `
INSERT INTO {{schema}}.watchdog_status (
  source_system, status, threshold_seconds, stale_seconds,
  last_ingest_at, last_check_at, message, checked_by
) VALUES ($1,$2,$3,$4,$5,NOW(),$6,$7)
ON CONFLICT (source_system) DO UPDATE SET
  status            = EXCLUDED.status,
  threshold_seconds = EXCLUDED.threshold_seconds,
  stale_seconds     = EXCLUDED.stale_seconds,
  last_ingest_at    = EXCLUDED.last_ingest_at,
  last_check_at     = EXCLUDED.last_check_at,
  message           = EXCLUDED.message,
  checked_by        = EXCLUDED.checked_by
`;

/**
 * Write one watchdog_status row per known source plus the synthetic
 * __heartbeat__ row (proves the checker itself is alive).
 *
 * Failures here are non-fatal — they're logged and swallowed so a transient
 * DB hiccup never crashes the worker (which would itself silently kill the
 * freshness signal it's supposed to be reporting on).
 *
 * @param {Pool}   pool       pg.Pool against the brain DB
 * @param {string} schema     schema name (typically 'public' or 'telemetry')
 * @param {string} checkedBy  identifier for who ran this check (e.g., 'worker-15min')
 */
async function runFreshnessCheck(pool, schema, checkedBy = 'worker') {
  const sources = Object.keys(SOURCE_THRESHOLDS_SECONDS).filter(s => s !== '__heartbeat__');
  const upsertSql = WATCHDOG_UPSERT_SQL.replace(/\{\{schema\}\}/g, schema);

  try {
    // CRITICAL: MAX(updated_at), NOT MAX(created_at). Idempotent UPSERTs touch
    // updated_at but never change created_at — using created_at would falsely
    // report any replay-style daemon (e.g., one polling old session files for
    // new tokens) as stale. See invariants.md §10.
    const { rows } = await pool.query(
      `SELECT source_system, MAX(updated_at) AS last_ingest_at
         FROM ${schema}.token_usage
        WHERE source_system = ANY($1)
        GROUP BY source_system`,
      [sources]
    );
    const lastIngestBySource = new Map(rows.map(r => [r.source_system, r.last_ingest_at]));

    let okCount = 0, staleCount = 0, neverCount = 0, pausedCount = 0;

    for (const src of sources) {
      const threshold  = SOURCE_THRESHOLDS_SECONDS[src];
      const lastIngest = lastIngestBySource.get(src);
      const override   = SOURCE_STATE_OVERRIDE[src];

      let status, staleSeconds, message;
      if (override) {
        // Explicit operator override — source intentionally not running here.
        status = override.status;
        staleSeconds = lastIngest
          ? Math.floor((Date.now() - new Date(lastIngest).getTime()) / 1000)
          : null;
        message = override.message;
        pausedCount++;
      } else if (!lastIngest) {
        status = 'never_seen';
        staleSeconds = null;
        message = `no rows for source_system='${src}' in ${schema}.token_usage`;
        neverCount++;
      } else {
        staleSeconds = Math.floor((Date.now() - new Date(lastIngest).getTime()) / 1000);
        if (staleSeconds > threshold) {
          status = 'stale';
          message = `${staleSeconds}s since last ingest exceeds threshold ${threshold}s`;
          staleCount++;
        } else {
          status = 'ok';
          message = `last ingest ${staleSeconds}s ago (threshold ${threshold}s)`;
          okCount++;
        }
      }

      await pool.query(upsertSql, [
        src, status, threshold, staleSeconds, lastIngest, message, checkedBy,
      ]);
    }

    // D7 — dead-man's-switch row. If this row's last_check_at exceeds its
    // own threshold, the checker itself is dead and any 'ok' rows are
    // stale-by-default.
    await pool.query(upsertSql, [
      '__heartbeat__', 'ok', SOURCE_THRESHOLDS_SECONDS.__heartbeat__,
      0, new Date(), `checker alive; ran at ${new Date().toISOString()}`, checkedBy,
    ]);

    console.log(
      `[watchdog] freshness check — ok=${okCount} stale=${staleCount} never_seen=${neverCount} paused=${pausedCount} + heartbeat`
    );
  } catch (err) {
    console.error(`[watchdog] freshness check FAILED (non-fatal): ${err.message}`);
  }
}

// ─────────────────────────────────────────────
// LiteLLM Adapter
// ─────────────────────────────────────────────

/**
 * Collects one hourly window of LiteLLM token data from Prometheus.
 *
 * Metrics queried:
 *   increase(litellm_input_tokens_metric_total[1h])
 *   increase(litellm_output_tokens_metric_total[1h])
 *   increase(litellm_cached_tokens_metric_total[1h])  — optional; NULL when no series
 *
 * Counter-reset handling:
 *   increase() already adjusts for counter resets (Prometheus detects drops).
 *   We additionally clamp to 0 inside queryPrometheus() as defence-in-depth.
 *
 * Cached tokens (invariant §2):
 *   NULL when the metric has no series (provider doesn't report cache data).
 *   0+ when series exists (provider confirms zero cache activity is valid).
 *
 * measurement_basis = 'exact' — LiteLLM passes through per-request provider counts.
 */
async function collectLiteLLM(cfg, windowStart, windowEnd, windowEndTs) {
  const promUrl = cfg.sources.litellm.prometheus.url;
  const userId  = cfg.identity?.user_id || null;

  const [inputMap, outputMap, cachedMap] = await Promise.all([
    queryPrometheus(promUrl, 'increase(litellm_input_tokens_metric_total[1h])',  windowEndTs),
    queryPrometheus(promUrl, 'increase(litellm_output_tokens_metric_total[1h])', windowEndTs),
    queryPrometheus(promUrl, 'increase(litellm_cached_tokens_metric_total[1h])', windowEndTs),
  ]);

  const allKeys = new Set([...Object.keys(inputMap), ...Object.keys(outputMap)]);
  const records = [];

  for (const key of allKeys) {
    const inputEntry  = inputMap[key]  || { value: 0, labels: {} };
    const outputEntry = outputMap[key] || { value: 0, labels: {} };
    const cachedEntry = cachedMap[key];                          // undefined if no series

    const labels   = inputEntry.labels || outputEntry.labels;
    const model    = labels.model    || key.split('::')[0];
    const model_id = labels.model_id || key.split('::')[1];

    const inputTokens  = Math.round(inputEntry.value);
    const outputTokens = Math.round(outputEntry.value);

    // Skip embed models and any series with zero activity this window
    if (inputTokens === 0 && outputTokens === 0) continue;

    // NULL when no cached series; numeric (possibly 0) when series exists — invariant §2
    const cachedReadTokens = cachedEntry != null ? Math.round(cachedEntry.value) : null;

    const provider = deriveProvider(model, model_id);
    const cost_usd = calcCost(cfg.pricing, model, inputTokens, outputTokens, cachedReadTokens);

    records.push({
      source_system:       'litellm',
      provider,
      model,
      model_id,
      window_start:        windowStart,
      window_end:          windowEnd,
      granularity:         'hour',             // telemetry_granularity enum
      measurement_basis:   'exact',            // token_measurement_basis enum
      input_tokens:        inputTokens,
      output_tokens:       outputTokens,
      cached_read_tokens:  cachedReadTokens,
      cached_write_tokens: null,               // LiteLLM does not expose cache write tokens
      cost_usd:            cost_usd || null,
      user_id:             userId,
    });
  }

  return records;
}

// ─────────────────────────────────────────────
// Collection Cycle
// ─────────────────────────────────────────────

async function runCollectionCycle(pool, cfg) {
  const { windowStart, windowEnd, windowEndTs } = resolveWindow(cfg);
  const schema = cfg.postgres.schema;

  console.log(`[worker] cycle start — window: ${windowStart.toISOString()} → ${windowEnd.toISOString()}`);

  let totalUpserted = 0;
  // Track per-source outcomes so main() can return a non-zero exit code on
  // partial failure (invariant: cron monitoring must be able to detect that
  // ONE source died while others succeeded — silent exit 0 hides bugs like
  // the subscription enum violation or the OpenAI 'unknown' model collapse).
  const sourceErrors = [];   // list of { source, error } from sources the cycle TRIED
  const sourcesTried = [];   // list of source names that were enabled and attempted

  // LiteLLM source
  if (cfg.sources?.litellm?.enabled) {
    sourcesTried.push('litellm');
    try {
      const records = await collectLiteLLM(cfg, windowStart, windowEnd, windowEndTs);
      console.log(`[litellm] collected ${records.length} records`);

      const count = await upsertRecords(pool, schema, records);
      console.log(`[litellm] upserted ${count} rows`);
      totalUpserted += count;
    } catch (err) {
      console.error(`[litellm] collection failed:`, err.message);
      sourceErrors.push({ source: 'litellm', error: err.message });
    }
  }

  // Copilot source — stub; implement when GitHub token is configured
  if (cfg.sources?.copilot?.enabled) {
    sourcesTried.push('copilot');
    console.warn('[copilot] adapter not yet implemented — skipping');
    sourceErrors.push({ source: 'copilot', error: 'adapter not wired into worker' });
  }

  // OpenAI Organization Usage API source
  if (cfg.sources?.openai?.enabled) {
    sourcesTried.push('openai');
    try {
      const OpenAIAdapter = require('./adapters/openai-usage.adapter.js');
      const adapter = new OpenAIAdapter(cfg);
      // OpenAI uses daily windows, so expand window to cover today
      const dayStart = new Date(windowStart);
      dayStart.setUTCHours(0, 0, 0, 0);
      const dayEnd = new Date(dayStart);
      dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);

      const rawRecords = await adapter.collectWindow(dayStart, dayEnd);
      const records = rawRecords
        .map(r => adapter.normalizeRecord(r))
        .filter(r => r !== null);

      console.log(`[openai] collected ${records.length} records`);
      const count = await upsertRecords(pool, schema, records);
      console.log(`[openai] upserted ${count} rows`);
      totalUpserted += count;
    } catch (err) {
      console.error(`[openai] collection failed:`, err.message);
      sourceErrors.push({ source: 'openai', error: err.message });
    }
  }

  // Anthropic Organization Usage API source
  if (cfg.sources?.anthropic?.enabled) {
    sourcesTried.push('anthropic');
    try {
      const AnthropicAdapter = require('./adapters/anthropic-usage.adapter.js');
      const adapter = new AnthropicAdapter(cfg);
      // Anthropic uses daily windows
      const dayStart = new Date(windowStart);
      dayStart.setUTCHours(0, 0, 0, 0);
      const dayEnd = new Date(dayStart);
      dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);

      const rawRecords = await adapter.collectWindow(dayStart, dayEnd);
      const records = rawRecords
        .map(r => adapter.normalizeRecord(r))
        .filter(r => r !== null);

      console.log(`[anthropic] collected ${records.length} records`);
      const count = await upsertRecords(pool, schema, records);
      console.log(`[anthropic] upserted ${count} rows`);
      totalUpserted += count;
    } catch (err) {
      console.error(`[anthropic] collection failed:`, err.message);
      sourceErrors.push({ source: 'anthropic', error: err.message });
    }
  }

  // Subscription flat-cost source (monthly billing records)
  if (cfg.sources?.subscriptions?.enabled) {
    sourcesTried.push('subscriptions');
    try {
      const SubscriptionAdapter = require('./adapters/subscription.adapter.js');
      const adapter = new SubscriptionAdapter(cfg);

      const rawRecords = await adapter.collectWindow(windowStart, windowEnd);
      const records = rawRecords
        .map(r => adapter.normalizeRecord(r))
        .filter(r => r !== null);

      console.log(`[subscriptions] collected ${records.length} records`);
      const count = await upsertRecords(pool, schema, records);
      console.log(`[subscriptions] upserted ${count} rows`);
      totalUpserted += count;
    } catch (err) {
      console.error(`[subscriptions] collection failed:`, err.message);
      sourceErrors.push({ source: 'subscriptions', error: err.message });
    }
  }

  // Manual import — stub
  if (cfg.sources?.manual?.enabled) {
    sourcesTried.push('manual');
    console.warn('[manual] adapter not yet implemented — skipping');
    sourceErrors.push({ source: 'manual', error: 'adapter not wired into worker' });
  }

  if (sourceErrors.length > 0) {
    console.error(
      `[worker] cycle complete with ERRORS — upserted=${totalUpserted} ` +
      `failed=${sourceErrors.length}/${sourcesTried.length} ` +
      `sources_failed=[${sourceErrors.map(e => e.source).join(',')}]`
    );
  } else {
    console.log(`[worker] cycle complete — ${totalUpserted} total rows upserted across ${sourcesTried.length} sources`);
  }

  // Phase 1 T0.1+D7: write per-source freshness rows + dead-man's-switch heartbeat.
  // Always runs, even when 0 rows were upserted, so the __heartbeat__ row stays
  // current and a zero-row cycle (legit empty Prometheus window) doesn't look
  // like a stall. Failure here is non-fatal — see runFreshnessCheck() for why.
  await runFreshnessCheck(pool, schema, 'worker');

  return { totalUpserted, sourcesTried, sourceErrors };
}

// ─────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────

async function main() {
  const args       = process.argv.slice(2).filter(a => !a.startsWith('--'));
  const flags      = process.argv.slice(2).filter(a => a.startsWith('--'));
  const daemon     = flags.includes('--daemon');
  const configPath = args[0] || path.join(__dirname, 'config.yaml');

  console.log(`[worker] config: ${configPath}`);
  const cfg  = loadConfig(configPath);
  const pool = createPool(cfg);
  pool.on('error', err => console.error('[pg] idle client error:', err.message));

  // Verify Prometheus
  const promUrl = cfg.sources?.litellm?.prometheus?.url;
  if (promUrl) {
    try {
      await httpGet(`${promUrl}/-/healthy`);
      console.log(`[worker] Prometheus OK at ${promUrl}`);
    } catch (err) {
      console.error(`[worker] Prometheus unreachable: ${err.message} — continuing`);
    }
  }

  const cycleResult = await runCollectionCycle(pool, cfg);

  if (daemon) {
    const intervalMs = (cfg.scheduler?.interval_minutes || 60) * 60_000;
    console.log(`[worker] daemon — next run in ${cfg.scheduler?.interval_minutes || 60}m`);

    // In-flight mutex: setInterval with an async callback does NOT await —
    // if a cycle outruns the interval (initial seed, multi-day backfill, slow
    // Prometheus), Node would otherwise start the next cycle concurrently.
    // Both runs would read the same watermark and re-process the same windows
    // (idempotent, but wasted work + doubled load on Prom). Skip overlapping
    // ticks. See invariants.md §13 (the same insight applies to query_range
    // backfill loops that can exceed cycle interval during initial seeds).
    let cycleInFlight = false;
    setInterval(async () => {
      if (cycleInFlight) {
        console.warn('[worker] previous cycle still running — skipping this tick');
        return;
      }
      cycleInFlight = true;
      try { await runCollectionCycle(pool, cfg); }
      catch (err) { console.error('[worker] cycle error:', err.message); }
      finally   { cycleInFlight = false; }
    }, intervalMs);
  } else {
    await pool.end();
    // Exit code matrix (for cron monitoring):
    //   0 — all enabled sources succeeded (or no sources enabled)
    //   1 — fatal/config error (reserved for the main().catch handler below)
    //   2 — partial failure: cycle ran but at least one enabled source errored
    // Without this, cron-based deployments silently see exit 0 even when
    // every subscription upsert is throwing an enum error.
    if (cycleResult.sourceErrors.length > 0) {
      console.error(`[worker] EXIT 2 — partial failure (${cycleResult.sourceErrors.length}/${cycleResult.sourcesTried.length} sources failed)`);
      process.exit(2);
    }
    console.log('[worker] done');
    process.exit(0);
  }
}

main().catch(err => {
  console.error('[worker] fatal:', err.message);
  process.exit(1);
});
