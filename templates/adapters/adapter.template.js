/**
 * Adapter Template — Unified Token Telemetry
 *
 * Copy this file and implement each method for your source system.
 * See references/adapter-contract.md for the full interface specification.
 */

'use strict';

class ExampleAdapter {
  constructor(config) {
    this.config      = config;
    this.sourceSystem = 'example';    // Set to: 'litellm', 'copilot', 'manual', etc.
    this.displayName = 'Example Source';
  }

  // ─────────────────────────────────────────────
  // 1. detectCapabilities()
  // Called once at startup. Confirms source is reachable.
  // Throws if source is unreachable — worker will skip this adapter.
  // ─────────────────────────────────────────────

  async detectCapabilities() {
    // TODO: Make a test request to the source system to verify connectivity
    // Example: await this._ping();

    return {
      granularity:      'hour',           // 'hour' or 'day'
      hasCacheData:     false,            // true if source reports cached token counts
      measurementBasis: 'exact',          // 'exact' | 'provider_aggregate' | 'derived_estimate'
      supportsBackfill: false,            // true if source allows historical window queries
      models:           [],               // leave empty if not discoverable at startup
    };
  }

  // ─────────────────────────────────────────────
  // 2. collectWindow(windowStart, windowEnd)
  // Fetches raw data from the source for the given time window.
  // windowStart: inclusive Date (UTC)
  // windowEnd:   exclusive Date (UTC)
  // Returns: array of raw records (source-specific shape — normalizeRecord converts them)
  // Returns: [] if no data for this window (normal — worker handles gracefully)
  // ─────────────────────────────────────────────

  async collectWindow(windowStart, windowEnd) {
    // TODO: Fetch data from your source system for this window
    // Return raw records as-is; normalizeRecord() converts them to canonical shape

    // Example skeleton:
    // const response = await fetch(`${this.config.sources.example.url}/data?start=${windowStart.toISOString()}&end=${windowEnd.toISOString()}`);
    // const data = await response.json();
    // return data.records;

    return [];
  }

  // ─────────────────────────────────────────────
  // 3. normalizeRecord(raw)
  // Converts a single raw source record to the canonical token_usage row shape.
  // Return null to skip a record (e.g., test models, irrelevant data).
  // ─────────────────────────────────────────────

  normalizeRecord(raw) {
    // TODO: Map your source record fields to the canonical shape

    return {
      source_system:       this.sourceSystem,
      provider:            'provider-name',           // 'anthropic', 'openai', 'github', etc.
      model:               raw.model_name || 'unknown',
      model_id:            raw.model_id   || 'unknown',
      window_start:        new Date(raw.period_start),
      window_end:          new Date(raw.period_end),
      granularity:         'hour',                    // match detectCapabilities().granularity
      measurement_basis:   this.mapMeasurementBasis(raw.count_type),
      input_tokens:        Number(raw.input_tokens)   || 0,
      output_tokens:       Number(raw.output_tokens)  || 0,
      cached_read_tokens:  null,   // null = source does not report; only set if source provides this
      cached_write_tokens: null,   // null = source does not report
      cost_usd:            null,   // null = not calculated; worker or pricing module adds this
      user_id:             this.config.identity?.user_id || null,
    };
  }

  // ─────────────────────────────────────────────
  // 4. mapMeasurementBasis(rawType)
  // Maps provider-specific token count descriptors to the enum.
  // ─────────────────────────────────────────────

  mapMeasurementBasis(rawType) {
    // TODO: map your source's type strings
    // Default if uncertain:
    return 'exact';

    // Examples:
    // if (rawType === 'api_response') return 'exact';
    // if (rawType === 'daily_report') return 'provider_aggregate';
    // if (rawType === 'estimated')    return 'derived_estimate';
  }

  // ─────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────

  // Add any internal helper methods below (HTTP clients, pagination, etc.)
}

module.exports = ExampleAdapter;
