/**
 * Anthropic Organization Usage Adapter — Unified Token Telemetry
 *
 * Queries the Anthropic Admin API for token consumption and cost data,
 * aggregated into daily buckets per model.
 *
 * API endpoints:
 *   GET https://api.anthropic.com/v1/organizations/usage_report/messages
 *   GET https://api.anthropic.com/v1/organizations/cost_report
 *
 * Authentication: Admin API key (x-api-key: sk-ant-admin-...)
 * Granularity: day (bucket_width=1d)
 *
 * Cache token reporting:
 *   - cached_read_tokens: YES (cache_read_input_tokens)
 *   - cached_write_tokens: YES (cache_creation ephemeral tokens, combined 5m+1h)
 *   - Billed separately at different rates (read=0.1X, write_5m=1.25X, write_1h=2X)
 */

'use strict';

class AnthropicUsageAdapter {
  constructor(config) {
    this.config       = config;
    this.sourceSystem = 'anthropic_api';
    this.displayName  = 'Anthropic Organization Usage';
    this._apiKey      = config.sources.anthropic.admin_api_key;
    this._baseUrl     = 'https://api.anthropic.com/v1/organizations';
    this._apiVersion  = '2023-06-01';
  }

  async detectCapabilities() {
    // Verify admin key access with a short usage query
    const now = new Date();
    const dayAgo = new Date(now.getTime() - 86_400_000);
    const url = `${this._baseUrl}/usage_report/messages?starting_at=${dayAgo.toISOString()}&ending_at=${now.toISOString()}&bucket_width=1d&limit=1`;

    const resp = await this._fetch(url);
    if (!resp.data || !Array.isArray(resp.data)) {
      throw new Error('Anthropic Admin API returned no data — check admin key scope (sk-ant-admin-...)');
    }

    return {
      granularity:      'day',
      hasCacheData:     true,     // Anthropic reports cache read + write tokens
      measurementBasis: 'exact',
      supportsBackfill: true,     // Can query historical windows
      models:           [],
    };
  }

  async collectWindow(windowStart, windowEnd) {
    const startIso = windowStart.toISOString();
    const endIso   = windowEnd.toISOString();

    // Fetch usage and costs in parallel
    const [usageData, costData] = await Promise.all([
      this._fetchUsage(startIso, endIso),
      this._fetchCosts(startIso, endIso),
    ]);

    // Build cost lookup: model -> cost_usd
    const costByModel = new Map();
    for (const bucket of (costData.data || [])) {
      for (const result of (bucket.results || [])) {
        const model = result.model || 'unknown';
        const prev  = costByModel.get(model) || 0;
        // Cost API returns cents or dollars depending on version — normalize
        costByModel.set(model, prev + (result.cost || 0));
      }
    }

    // Parse usage buckets into raw records
    const rawRecords = [];
    for (const bucket of (usageData.data || [])) {
      const bucketStart = bucket.start_time || bucket.starting_at;
      const bucketEnd   = bucket.end_time || bucket.ending_at;

      for (const result of (bucket.results || [])) {
        const model = result.model || 'unknown';

        // Anthropic separates cache creation into ephemeral_5m and ephemeral_1h
        const cacheCreation = result.cache_creation || {};
        const cacheWrite5m  = cacheCreation.ephemeral_5m_input_tokens || 0;
        const cacheWrite1h  = cacheCreation.ephemeral_1h_input_tokens || 0;
        const cacheWriteTotal = cacheWrite5m + cacheWrite1h;

        rawRecords.push({
          model,
          bucket_start:         bucketStart,
          bucket_end:           bucketEnd,
          uncached_input_tokens: result.uncached_input_tokens || 0,
          cache_read_tokens:    result.cache_read_input_tokens || 0,
          cache_write_tokens:   cacheWriteTotal,
          output_tokens:        result.output_tokens || 0,
          cost_usd:             costByModel.get(model) || null,
        });
      }
    }

    return rawRecords;
  }

  normalizeRecord(raw) {
    // Total input = uncached + cache_read + cache_write (all count as "input" for billing)
    const totalInput = raw.uncached_input_tokens + raw.cache_read_tokens + raw.cache_write_tokens;

    // Skip zero-activity records
    if (totalInput === 0 && raw.output_tokens === 0) return null;

    return {
      source_system:       this.sourceSystem,
      provider:            'anthropic',
      model:               raw.model,
      model_id:            raw.model,
      window_start:        new Date(raw.bucket_start),
      window_end:          new Date(raw.bucket_end),
      granularity:         'day',
      measurement_basis:   'exact',
      input_tokens:        totalInput,
      output_tokens:       raw.output_tokens,
      cached_read_tokens:  raw.cache_read_tokens != null ? raw.cache_read_tokens : null,
      cached_write_tokens: raw.cache_write_tokens != null ? raw.cache_write_tokens : null,
      cost_usd:            raw.cost_usd,
      user_id:             this.config.identity?.user_id || null,
    };
  }

  mapMeasurementBasis(_rawType) {
    return 'exact';
  }

  // ─────────────────────────────────────────────
  // Private
  // ─────────────────────────────────────────────

  async _fetchUsage(startIso, endIso) {
    const url = `${this._baseUrl}/usage_report/messages?starting_at=${startIso}&ending_at=${endIso}&bucket_width=1d&group_by[]=model`;
    return this._fetch(url);
  }

  async _fetchCosts(startIso, endIso) {
    const url = `${this._baseUrl}/cost_report?starting_at=${startIso}&ending_at=${endIso}&bucket_width=1d&group_by[]=model`;
    return this._fetch(url);
  }

  async _fetch(rawUrl) {
    const headers = {
      'x-api-key':         this._apiKey,
      'anthropic-version': this._apiVersion,
      'Content-Type':      'application/json',
    };

    return new Promise((resolve, reject) => {
      const parsed = new (require('url').URL)(rawUrl);
      const lib    = parsed.protocol === 'https:' ? require('https') : require('http');

      const opts = {
        hostname: parsed.hostname,
        port:     parsed.port || 443,
        path:     parsed.pathname + parsed.search,
        method:   'GET',
        headers,
      };

      const req = lib.request(opts, res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString();
          if (res.statusCode === 429) {
            reject(new Error('Anthropic rate limited (429) — retry after backoff'));
            return;
          }
          if (res.statusCode === 401 || res.statusCode === 403) {
            reject(new Error(`Anthropic auth failed (${res.statusCode}) — requires sk-ant-admin-... key`));
            return;
          }
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`Anthropic API ${res.statusCode}: ${body.slice(0, 200)}`));
            return;
          }
          try { resolve(JSON.parse(body)); }
          catch (e) { reject(new Error(`Anthropic response parse error: ${e.message}`)); }
        });
        res.on('error', reject);
      });
      req.on('error', reject);
      // 15s socket-deadline — Anthropic Admin API can hang on auth probe.
      req.setTimeout(15_000, () => req.destroy(new Error(`Anthropic HTTP timeout (15s) for ${rawUrl}`)));
      req.end();
    });
  }
}

module.exports = AnthropicUsageAdapter;
