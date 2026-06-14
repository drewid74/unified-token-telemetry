/**
 * Manual Import Adapter — Unified Token Telemetry
 *
 * Portable adapter for manual estimate ingestion from CSV or JSON.
 *
 * Accepted input fields:
 *   source_system, provider, model, model_id, date, window_start, window_end,
 *   input_tokens, output_tokens, notes, user_id, granularity
 *
 * Manual entries are always normalized to:
 *   measurement_basis = 'derived_estimate'
 *   cached_read_tokens = NULL
 *   cached_write_tokens = NULL
 *
 * Config:
 *   sources.manual.source_path   - path to file
 *   sources.manual.source_format - 'csv' or 'json'
 */

'use strict';

const fs   = require('fs');
const path = require('path');

class ManualImportAdapter {
  constructor(config) {
    this.config = config;
    this.sourceSystem = 'manual';
    this.displayName = 'Manual Import';
    this._sourcePath = config.sources?.manual?.source_path || null;
    this._sourceFormat = (config.sources?.manual?.source_format || 'csv').toLowerCase();
  }

  async detectCapabilities() {
    if (this._sourcePath && !fs.existsSync(this._sourcePath)) {
      throw new Error(`Manual import file not found: ${this._sourcePath}`);
    }

    return {
      granularity: 'day',
      hasCacheData: false,
      measurementBasis: 'derived_estimate',
      supportsBackfill: true,
      models: [],
    };
  }

  async collectWindow(windowStart, windowEnd) {
    const records = this.loadRecords();

    return records.filter(r => {
      const date = this._recordDate(r);
      return date >= windowStart && date < windowEnd;
    });
  }

  normalizeRecord(raw) {
    const date = this._recordDate(raw);
    const granularity = (raw.granularity || 'day').toLowerCase();

    let windowStart, windowEnd;
    if (granularity === 'hour' && raw.window_start) {
      windowStart = new Date(raw.window_start);
      windowEnd = raw.window_end ? new Date(raw.window_end) : new Date(windowStart.getTime() + 3600 * 1000);
    } else {
      windowStart = this._startOfDay(date);
      windowEnd = raw.window_end ? new Date(raw.window_end) : new Date(windowStart.getTime() + 86400 * 1000);
    }

    const modelId = raw.model_id || raw.model || 'unknown';
    const measurementBasis = this.mapMeasurementBasis(raw.measurement_basis);

    return {
      source_system: this.sourceSystem,
      provider: raw.provider || 'unknown',
      model: raw.model || modelId,
      model_id: modelId,
      window_start: windowStart,
      window_end: windowEnd,
      granularity,
      measurement_basis: measurementBasis,
      input_tokens: Number(raw.input_tokens) || 0,
      output_tokens: Number(raw.output_tokens) || 0,
      cached_read_tokens: null,
      cached_write_tokens: null,
      cost_usd: raw.cost_usd != null ? Number(raw.cost_usd) : null,
      user_id: raw.user_id || this.config.identity?.user_id || null,
      notes: raw.notes || null,
    };
  }

  mapMeasurementBasis(rawType) {
    return 'derived_estimate';
  }

  loadRecords() {
    if (!this._sourcePath) return [];
    const content = fs.readFileSync(this._sourcePath, 'utf8');
    if (this._sourceFormat === 'json') return this._parseJson(content);
    return this._parseCsv(content);
  }

  _recordDate(raw) {
    const value = raw.date || raw.window_start;
    if (!value) throw new Error('Manual record requires date or window_start');
    return new Date(value.length <= 10 ? `${value.slice(0, 10)}T00:00:00Z` : value);
  }

  _startOfDay(date) {
    const d = new Date(date);
    d.setUTCHours(0, 0, 0, 0);
    return d;
  }

  _parseJson(content) {
    const parsed = JSON.parse(content);
    if (!Array.isArray(parsed)) throw new Error('Manual import JSON must be an array');
    return parsed;
  }

  _parseCsv(content) {
    const lines = content.trim().split(/\r?\n/).filter(Boolean);
    if (!lines.length) return [];
    const headers = this._splitCsvLine(lines[0]).map(h => h.trim().replace(/^"|"$/g, ''));
    return lines.slice(1).map(line => {
      const values = this._splitCsvLine(line).map(v => v.trim().replace(/^"|"$/g, ''));
      return Object.fromEntries(headers.map((h, i) => [h, values[i] ?? null]));
    });
  }

  _splitCsvLine(line) {
    const out = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
        continue;
      }
      if (ch === ',' && !inQuotes) {
        out.push(cur);
        cur = '';
        continue;
      }
      cur += ch;
    }
    out.push(cur);
    return out;
  }
}

module.exports = ManualImportAdapter;
