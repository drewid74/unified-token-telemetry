/**
 * LiteLLM Prometheus Adapter — Unified Token Telemetry
 *
 * Queries Prometheus for LiteLLM token counters and aggregates hourly windows.
 * Handles counter resets (Prometheus counters reset on container restart).
 *
 * Prometheus metrics consumed:
 *   litellm_input_tokens_metric_total   {model, user}
 *   litellm_output_tokens_metric_total  {model, user}
 *   litellm_cached_tokens_metric_total  {model, user}  (cache reads only; no write metric)
 *
 * Job label: litellm_panopticon
 */

'use strict';

class LiteLLMPrometheusAdapter {
  constructor(config) {
    this.config       = config;
    this.sourceSystem = 'litellm';
    this.displayName  = 'LiteLLM (Prometheus)';
    this._prometheusUrl = config.sources.litellm.prometheus.url;
    this._jobName       = config.sources.litellm.prometheus.job_name || 'litellm_panopticon';
    this._lastCounters  = new Map(); // model_id -> { input, output, cached }
  }

  async detectCapabilities() {
    // Verify Prometheus is reachable
    const resp = await this._query('up{job="' + this._jobName + '"}');
    if (!resp.data?.result?.length) {
      throw new Error(`LiteLLM job "${this._jobName}" not found in Prometheus`);
    }

    return {
      granularity:      'hour',
      hasCacheData:     true,             // Anthropic: yes; OpenAI: read only; Gemini: no
      measurementBasis: 'exact',
      supportsBackfill: false,            // Prometheus counters can't reconstruct past windows
      models:           [],
    };
  }

  async collectWindow(windowStart, windowEnd) {
    // Prometheus instant query at windowEnd gives cumulative counters since container start.
    // We compute delta = current - last_recorded, handling resets.
    const timestamp = Math.floor(windowEnd.getTime() / 1000);

    const [inputResults, outputResults, cachedResults] = await Promise.all([
      this._query(`litellm_input_tokens_metric_total{job="${this._jobName}"}`, timestamp),
      this._query(`litellm_output_tokens_metric_total{job="${this._jobName}"}`, timestamp),
      this._query(`litellm_cached_tokens_metric_total{job="${this._jobName}"}`, timestamp),
    ]);

    // Merge results by model label
    const byModel = new Map();

    for (const series of (inputResults.data?.result || [])) {
      const modelId = series.metric.model || 'unknown';
      if (!byModel.has(modelId)) byModel.set(modelId, {});
      byModel.get(modelId).input_raw = parseFloat(series.value[1]);
      byModel.get(modelId).model_label = series.metric.model;
    }
    for (const series of (outputResults.data?.result || [])) {
      const modelId = series.metric.model || 'unknown';
      if (!byModel.has(modelId)) byModel.set(modelId, {});
      byModel.get(modelId).output_raw = parseFloat(series.value[1]);
    }
    for (const series of (cachedResults.data?.result || [])) {
      const modelId = series.metric.model || 'unknown';
      if (!byModel.has(modelId)) byModel.set(modelId, {});
      byModel.get(modelId).cached_raw = parseFloat(series.value[1]);
    }

    // Convert to raw records with delta computation
    const rawRecords = [];
    for (const [modelId, counters] of byModel) {
      const prev = this._lastCounters.get(modelId) || { input: 0, output: 0, cached: 0 };
      const curr = {
        input:  counters.input_raw  || 0,
        output: counters.output_raw || 0,
        cached: counters.cached_raw || 0,
      };

      // Counter reset detection (invariant rule #3)
      const inputDelta  = curr.input  < prev.input  ? curr.input  : curr.input  - prev.input;
      const outputDelta = curr.output < prev.output  ? curr.output : curr.output - prev.output;
      const cachedDelta = curr.cached < prev.cached  ? curr.cached : curr.cached - prev.cached;

      this._lastCounters.set(modelId, curr);

      if (inputDelta === 0 && outputDelta === 0) continue; // no activity this window

      rawRecords.push({
        model_id:     modelId,
        window_start: windowStart.toISOString(),
        window_end:   windowEnd.toISOString(),
        input_tokens: inputDelta,
        output_tokens: outputDelta,
        cached_tokens: cachedDelta,
        had_reset:    curr.input < prev.input,
      });
    }

    return rawRecords;
  }

  normalizeRecord(raw) {
    const provider = this._inferProvider(raw.model_id);

    // Determine whether this provider reports cache data
    // Anthropic: yes; OpenAI: read only (write = null); others: null
    let cached_read_tokens  = null;
    let cached_write_tokens = null;

    if (provider === 'anthropic' || provider === 'openai') {
      cached_read_tokens = raw.cached_tokens > 0 ? raw.cached_tokens : null;
      // Anthropic has write tokens but LiteLLM aggregates both into cached_tokens — treat as read
      cached_write_tokens = null; // NULL = unknown; only non-null if provider explicitly reports writes
    }

    return {
      source_system:       this.sourceSystem,
      provider,
      model:               this._friendlyModelName(raw.model_id),
      model_id:            raw.model_id,
      window_start:        new Date(raw.window_start),
      window_end:          new Date(raw.window_end),
      granularity:         'hour',
      measurement_basis:   'exact',
      input_tokens:        raw.input_tokens,
      output_tokens:       raw.output_tokens,
      cached_read_tokens,
      cached_write_tokens,
      cost_usd:            null,  // pricing module calculates separately
      user_id:             this.config.identity?.user_id || null,
    };
  }

  mapMeasurementBasis() {
    return 'exact';
  }

  // ─────────────────────────────────────────────
  // Private
  // ─────────────────────────────────────────────

  async _query(promql, time) {
    const params = new URLSearchParams({ query: promql });
    if (time) params.set('time', String(time));
    const url = `${this._prometheusUrl}/api/v1/query?${params}`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Prometheus query failed: ${resp.status} ${url}`);
    return resp.json();
  }

  _inferProvider(modelId) {
    if (!modelId) return 'unknown';
    if (modelId.includes('claude'))  return 'anthropic';
    if (modelId.includes('gpt') || modelId.includes('o1') || modelId.includes('o3')) return 'openai';
    if (modelId.includes('gemini'))  return 'google';
    if (modelId.includes('mistral')) return 'mistral';
    return 'unknown';
  }

  _friendlyModelName(modelId) {
    // Strip date suffixes if desired: 'claude-3-5-sonnet-20241022' -> 'claude-3-5-sonnet'
    return modelId.replace(/-\d{8}$/, '');
  }
}

module.exports = LiteLLMPrometheusAdapter;
