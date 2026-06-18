/**
 * GitHub Copilot Daily Adapter — Unified Token Telemetry
 *
 * Collects GitHub Copilot token usage via the organization metrics API.
 * Granularity: day (API only reports per-calendar-day aggregates).
 * Cache data: NONE — Copilot reports no cache telemetry. cached_* columns ALWAYS NULL.
 *
 * API: GET /orgs/{org}/copilot/metrics/reports/organization-1-day?day=YYYY-MM-DD
 * Auth: GitHub PAT or OAuth app token with read:org scope
 *       (classic PATs: read:org; fine-grained PATs: organization_copilot_usage:read)
 *
 * IMPORTANT: The old /copilot/usage endpoint was retired 2026-04-02. Do not use it.
 *
 * Response format:
 *   The API returns a JSON envelope with a signed download_url:
 *     { "download_url": "https://objects.githubusercontent.com/..." }
 *   Fetching download_url yields NDJSON (one JSON object per line, per model).
 *   Some API versions may return inline arrays — both shapes are handled.
 *
 * Token field resolution (inspected at runtime per record):
 *   Priority 1: total_tokens_prompted + total_tokens_generated → provider_aggregate
 *   Priority 2: lines_accepted (or lines_suggested) * 15 estimate → derived_estimate
 *   Fallback: skip record (return null from normalizeRecord)
 *
 * Invariants enforced (references/invariants.md):
 *   §1: Upsert with replacement semantics — running twice yields identical results
 *   §2: cached_read_tokens = NULL, cached_write_tokens = NULL — always for Copilot
 *   §4: measurement_basis = 'provider_aggregate' when tokens reported directly;
 *        'derived_estimate' when estimated from line counts
 *
 * user_id is always NULL — Copilot API is org-level aggregate, no per-user breakdown.
 */

'use strict';

const https = require('https');
const http  = require('http');
const { URL } = require('url');

// ─────────────────────────────────────────────
// HTTP Helper
// ─────────────────────────────────────────────

/**
 * Performs an HTTPS/HTTP GET with custom headers.
 * Follows one level of redirect (for CDN signed URLs).
 * Returns: { status: number, ok: boolean, text: string }
 */
function httpGet(rawUrl, headers = {}, _redirectDepth = 0) {
  return new Promise((resolve, reject) => {
    if (_redirectDepth > 5) {
      return reject(new Error(`Too many redirects for: ${rawUrl}`));
    }

    let parsed;
    try {
      parsed = new URL(rawUrl);
    } catch (e) {
      return reject(new Error(`Invalid URL: ${rawUrl}`));
    }

    const lib = parsed.protocol === 'https:' ? https : http;
    const options = {
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path:     parsed.pathname + parsed.search,
      headers,
    };

    const req = lib.get(options, res => {
      // Follow redirects (signed CDN URLs may redirect once)
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return httpGet(res.headers.location, {}, _redirectDepth + 1)
          .then(resolve)
          .catch(reject);
      }

      const chunks = [];
      res.on('data',  c   => chunks.push(c));
      res.on('end',   ()  => resolve({
        status: res.statusCode,
        ok:     res.statusCode >= 200 && res.statusCode < 300,
        text:   Buffer.concat(chunks).toString('utf8'),
      }));
      res.on('error', reject);
    });

    req.on('error', reject);
    // 15s socket-deadline — GitHub CDN signed URLs occasionally stall mid-stream.
    req.setTimeout(15_000, () => req.destroy(new Error(`HTTP timeout (15s) for ${rawUrl}`)));
  });
}

// ─────────────────────────────────────────────
// Adapter Class
// ─────────────────────────────────────────────

class CopilotDailyAdapter {
  /**
   * @param {object} config  Full instance config (resolved before instantiation)
   *   config.sources.copilot.github.token  — GitHub PAT (env var must be resolved by caller)
   *   config.sources.copilot.github.org    — GitHub org slug (env var must be resolved by caller)
   */
  constructor(config) {
    this.config       = config;
    this.sourceSystem = 'copilot';
    this.displayName  = 'GitHub Copilot (Daily API)';

    this._token   = config.sources?.copilot?.github?.token;
    this._org     = config.sources?.copilot?.github?.org;
    this._baseUrl = 'https://api.github.com';
  }

  // ─────────────────────────────────────────────
  // 1. detectCapabilities
  // Called once at startup. Throws if source is unreachable.
  // Worker will skip this adapter and log the error.
  // ─────────────────────────────────────────────

  async detectCapabilities() {
    if (!this._token) {
      throw new Error('GITHUB_TOKEN is not set. Cannot collect Copilot metrics.');
    }
    if (!this._org) {
      throw new Error('GITHUB_ORG is not set. Cannot collect Copilot metrics.');
    }

    // Probe org access — verifies token scope and org membership
    const resp = await this._apiGet(`/orgs/${this._org}`);

    if (resp.status === 401) {
      throw new Error(
        `GitHub auth failed (401) for org="${this._org}". ` +
        `Token is invalid or expired.`
      );
    }
    if (resp.status === 403) {
      throw new Error(
        `GitHub auth forbidden (403) for org="${this._org}". ` +
        `Token lacks read:org scope.`
      );
    }
    if (!resp.ok) {
      throw new Error(
        `GitHub API error ${resp.status} probing org="${this._org}".`
      );
    }

    return {
      granularity:      'day',
      hasCacheData:     false,            // Copilot does not expose cache metrics — invariant §2
      measurementBasis: 'provider_aggregate',
      supportsBackfill: true,             // Historical days can be requested
      models:           [],               // Discovered per-day from NDJSON
    };
  }

  // ─────────────────────────────────────────────
  // 2. collectWindow
  // Enumerates complete calendar days in [windowStart, windowEnd).
  // Auth failures propagate (caller skips window + retries next run).
  // Network errors per-day are logged and skipped (partial data returned).
  // ─────────────────────────────────────────────

  async collectWindow(windowStart, windowEnd) {
    const days = this._enumerateDays(windowStart, windowEnd);
    const rawRecords = [];

    console.log(`[copilot] collecting ${days.length} day(s): ${days[0] || 'none'} → ${days[days.length - 1] || ''}`);

    for (const day of days) {
      try {
        const records = await this._fetchDay(day);
        rawRecords.push(...records);
        console.log(`[copilot] ${day}: ${records.length} record(s)`);
      } catch (err) {
        if (err.authFailure) {
          // Auth failures propagate immediately — no partial writes
          throw err;
        }
        // Non-auth errors: log and continue with remaining days
        console.error(`[copilot] ${day}: fetch failed — ${err.message}`);
      }
    }

    return rawRecords;
  }

  // ─────────────────────────────────────────────
  // 3. normalizeRecord
  // Converts a single raw NDJSON record to the canonical token_usage row shape.
  // Returns null for records that should be skipped (zero activity, missing fields).
  // ─────────────────────────────────────────────

  normalizeRecord(raw) {
    const day      = raw._day;  // injected by _fetchDay
    const dayStart = new Date(`${day}T00:00:00Z`);
    const dayEnd   = new Date(dayStart);
    dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);  // exclusive end = next day midnight (invariant §6)

    let inputTokens, outputTokens, measurementBasis;

    // Priority 1: Direct token fields (provider_aggregate)
    if (raw.total_tokens_prompted != null && raw.total_tokens_generated != null) {
      inputTokens      = Math.round(Number(raw.total_tokens_prompted));
      outputTokens     = Math.round(Number(raw.total_tokens_generated));
      measurementBasis = 'provider_aggregate';
    }
    // Priority 1b: Alternate field names from some API versions
    else if (raw.total_prompt_tokens != null && raw.total_completion_tokens != null) {
      inputTokens      = Math.round(Number(raw.total_prompt_tokens));
      outputTokens     = Math.round(Number(raw.total_completion_tokens));
      measurementBasis = 'provider_aggregate';
    }
    // Priority 2: Line counts only — estimate tokens (derived_estimate)
    else if (raw.lines_accepted != null || raw.lines_suggested != null) {
      const lines  = Number(raw.lines_accepted ?? raw.lines_suggested ?? 0);
      // Conservative estimate: 15 tokens/line for output; 1.2x for prompt overhead
      outputTokens     = Math.round(lines * 15);
      inputTokens      = Math.round(lines * 15 * 1.2);
      measurementBasis = 'derived_estimate';
      console.warn(
        `[copilot] ${day} model=${raw.model || 'unknown'}: ` +
        `no token fields — estimating from ${lines} accepted lines (derived_estimate)`
      );
    }
    // No usable data
    else {
      console.warn(
        `[copilot] ${day} model=${raw.model || 'unknown'}: ` +
        `no token or line fields found — skipping record`
      );
      return null;
    }

    // Skip zero-activity records
    if (inputTokens === 0 && outputTokens === 0) {
      return null;
    }

    // Model identity — use per-model fields if present; fall back to org aggregate key
    const model    = raw.model    || raw.model_name    || 'copilot-completions';
    const model_id = raw.model_id || raw.model_version || 'github-copilot-org-daily';

    return {
      source_system:       this.sourceSystem,
      provider:            'github',
      model,
      model_id,
      window_start:        dayStart,
      window_end:          dayEnd,
      granularity:         'day',
      measurement_basis:   measurementBasis,
      input_tokens:        inputTokens,
      output_tokens:       outputTokens,
      cached_read_tokens:  null,   // Copilot does NOT report cache data — invariant §2
      cached_write_tokens: null,   // Copilot does NOT report cache data — invariant §2
      cost_usd:            null,   // No published per-token pricing for Copilot Business
      user_id:             null,   // Org-level aggregate — no per-user breakdown
    };
  }

  // ─────────────────────────────────────────────
  // 4. mapMeasurementBasis
  // ─────────────────────────────────────────────

  mapMeasurementBasis(rawType) {
    if (rawType === 'line_estimate')  return 'derived_estimate';
    return 'provider_aggregate';
  }

  // ─────────────────────────────────────────────
  // Private
  // ─────────────────────────────────────────────

  /**
   * Fetches one calendar day from the Copilot metrics API.
   * Returns an array of raw records with _day injected.
   *
   * Throws with err.authFailure=true on 401/403 — caller must propagate.
   * Returns [] on 404 (no Copilot activity logged for that day).
   */
  async _fetchDay(day) {
    const endpoint = `/orgs/${this._org}/copilot/metrics/reports/organization-1-day?day=${day}`;
    const resp = await this._apiGet(endpoint);

    if (resp.status === 401 || resp.status === 403) {
      const err = new Error(
        `GitHub auth failed (${resp.status}) for org="${this._org}" day=${day}. ` +
        `Ensure GITHUB_TOKEN has read:org scope and org has Copilot Business or Enterprise enabled. ` +
        `Manual fallback: insert estimates directly into token_usage with measurement_basis='derived_estimate'.`
      );
      err.authFailure = true;
      throw err;
    }

    if (resp.status === 404) {
      return [];  // No Copilot activity for this day — not an error
    }

    if (!resp.ok) {
      throw new Error(`Copilot API ${resp.status} for day=${day}`);
    }

    let envelope;
    try {
      envelope = JSON.parse(resp.text);
    } catch (e) {
      throw new Error(`Failed to parse Copilot API JSON for day=${day}: ${e.message}`);
    }

    // Shape A: { download_url: "https://..." } — fetch and parse NDJSON
    if (envelope.download_url) {
      return this._downloadNdjson(envelope.download_url, day);
    }

    // Shape B: array of model records returned inline
    if (Array.isArray(envelope)) {
      return envelope.map(r => ({ ...r, _day: day }));
    }

    // Shape C: { models: [...] } inline
    if (Array.isArray(envelope.models)) {
      return envelope.models.map(r => ({ ...r, _day: day }));
    }

    // Shape D: { data: [...] } inline
    if (Array.isArray(envelope.data)) {
      return envelope.data.map(r => ({ ...r, _day: day }));
    }

    console.warn(`[copilot] ${day}: unrecognized response shape — keys: ${Object.keys(envelope).join(', ')}`);
    return [];
  }

  /**
   * Downloads NDJSON from a signed URL and parses each line.
   * No auth header — signed URLs are self-authenticating.
   */
  async _downloadNdjson(signedUrl, day) {
    const resp = await httpGet(signedUrl);

    if (!resp.ok) {
      throw new Error(`Failed to download Copilot NDJSON for day=${day}: ${resp.status}`);
    }

    const records = [];
    for (const line of resp.text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        records.push({ ...parsed, _day: day });
      } catch (e) {
        console.warn(`[copilot] ${day}: malformed NDJSON line (skipped):`, trimmed.slice(0, 120));
      }
    }

    return records;
  }

  /**
   * GitHub API GET with required headers.
   */
  async _apiGet(path) {
    return httpGet(`${this._baseUrl}${path}`, {
      Authorization:          `Bearer ${this._token}`,
      Accept:                 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent':           'unified-token-telemetry/1.0',
    });
  }

  /**
   * Returns YYYY-MM-DD strings for each fully-completed calendar day
   * within [windowStart, windowEnd) (exclusive of windowEnd).
   * Only includes days where the entire day has passed (dayEnd <= windowEnd).
   */
  _enumerateDays(windowStart, windowEnd) {
    const days = [];
    const cursor = new Date(windowStart);
    cursor.setUTCHours(0, 0, 0, 0);

    while (cursor < windowEnd) {
      const dayEnd = new Date(cursor);
      dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);
      if (dayEnd <= windowEnd) {
        days.push(cursor.toISOString().slice(0, 10));
      }
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }

    return days;
  }
}

module.exports = CopilotDailyAdapter;
