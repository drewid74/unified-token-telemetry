/**
 * OpenAI Organization Usage Adapter — Unified Token Telemetry
 *
 * Queries the OpenAI Organization Usage API for token consumption
 * and cost data, aggregated into daily buckets per model.
 *
 * API endpoints:
 *   GET https://api.openai.com/v1/organization/usage/completions
 *   GET https://api.openai.com/v1/organization/costs
 *
 * Authentication: Organization-level API key (Bearer token)
 * Granularity: day (bucket_width=1d)
 *
 * Note: OpenAI does NOT separately report cached tokens in the usage API.
 * Cached input tokens are included in input_tokens but billed at reduced rate.
 * cached_read_tokens will always be null for this adapter.
 */

'use strict';

class OpenAIUsageAdapter {
  constructor(config) {
    this.config       = config;
    this.sourceSystem = 'openai_api';
    this.displayName  = 'OpenAI Organization Usage';
    this._apiKey      = config.sources.openai.api_key;
    this._orgId       = config.sources.openai.org_id || null;
    this._baseUrl     = 'https://api.openai.com/v1/organization';
  }

  async detectCapabilities() {
    // Verify API key has org-level access by requesting a 1-day window
    const now = Math.floor(Date.now() / 1000);
    const url = `${this._baseUrl}/usage/completions?start_time=${now - 86400}&end_time=${now}&limit=1`;
    const resp = await this._fetch(url);

    if (!resp.data) {
      throw new Error('OpenAI Usage API returned no data — check API key has org admin scope');
    }

    return {
      granularity:      'day',
      hasCacheData:     false,    // OpenAI does not break out cached tokens
      measurementBasis: 'exact',
      supportsBackfill: true,     // Can query historical windows
      models:           [],
    };
  }

  async collectWindow(windowStart, windowEnd) {
    const startTs = Math.floor(windowStart.getTime() / 1000);
    const endTs   = Math.floor(windowEnd.getTime() / 1000);

    // Fetch both usage and costs in parallel
    const [usageData, costData] = await Promise.all([
      this._fetchUsage(startTs, endTs),
      this._fetchCosts(startTs, endTs),
    ]);

    // Build cost lookup: model -> cost_usd
    const costByModel = new Map();
    for (const bucket of (costData.data || [])) {
      for (const result of (bucket.results || [])) {
        const model = result.model || 'unknown';
        const prev  = costByModel.get(model) || 0;
        costByModel.set(model, prev + (result.cost || 0));
      }
    }

    // Merge usage buckets into flat records
    const rawRecords = [];
    for (const bucket of (usageData.data || [])) {
      for (const result of (bucket.results || [])) {
        rawRecords.push({
          model:              result.model || 'unknown',
          bucket_start:       bucket.start_time,
          bucket_end:         bucket.end_time,
          input_tokens:       result.input_tokens || 0,
          output_tokens:      result.output_tokens || 0,
          num_requests:       result.num_model_requests || 0,
          cost_usd:           costByModel.get(result.model) || null,
        });
      }
    }

    return rawRecords;
  }

  normalizeRecord(raw) {
    // Skip zero-activity records
    if (raw.input_tokens === 0 && raw.output_tokens === 0) return null;

    return {
      source_system:       this.sourceSystem,
      provider:            'openai',
      model:               raw.model,
      model_id:            raw.model,
      window_start:        new Date(raw.bucket_start * 1000),
      window_end:          new Date(raw.bucket_end * 1000),
      granularity:         'day',
      measurement_basis:   'exact',
      input_tokens:        raw.input_tokens,
      output_tokens:       raw.output_tokens,
      cached_read_tokens:  null,   // OpenAI doesn't separate cached tokens
      cached_write_tokens: null,
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

  async _fetchUsage(startTs, endTs) {
    // group_by[]=model is REQUIRED — without it the API returns a single bucket per
    // day with no `model` field, so every row collapses to model='unknown'.
    // Mirror the Anthropic adapter (which has group_by[]=model) so per-model
    // breakdown actually works.
    const url = `${this._baseUrl}/usage/completions?start_time=${startTs}&end_time=${endTs}&bucket_width=1d&group_by[]=model&limit=31`;
    return this._fetch(url);
  }

  async _fetchCosts(startTs, endTs) {
    const url = `${this._baseUrl}/costs?start_time=${startTs}&end_time=${endTs}&bucket_width=1d&group_by[]=model&limit=31`;
    return this._fetch(url);
  }

  async _fetch(rawUrl) {
    const headers = {
      'Authorization': `Bearer ${this._apiKey}`,
      'Content-Type':  'application/json',
    };
    if (this._orgId) {
      headers['OpenAI-Organization'] = this._orgId;
    }

    return new Promise((resolve, reject) => {
      const parsed = new (require('url').URL)(rawUrl);
      const lib    = parsed.protocol === 'https:' ? require('https') : require('http');

      const opts = {
        hostname: parsed.hostname,
        port:     parsed.port,
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
            reject(new Error('OpenAI rate limited (429) — retry after backoff'));
            return;
          }
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`OpenAI API ${res.statusCode}: ${body.slice(0, 200)}`));
            return;
          }
          try { resolve(JSON.parse(body)); }
          catch (e) { reject(new Error(`OpenAI response parse error: ${e.message}`)); }
        });
        res.on('error', reject);
      });
      req.on('error', reject);
      // 15s socket-deadline — OpenAI Org Usage API occasionally hangs on auth.
      req.setTimeout(15_000, () => req.destroy(new Error(`OpenAI HTTP timeout (15s) for ${rawUrl}`)));
      req.end();
    });
  }
}

module.exports = OpenAIUsageAdapter;
