import { NextRequest, NextResponse } from 'next/server';
import { Pool } from 'pg';

/**
 * Token Usage API Route — Unified Token Telemetry
 *
 * GET /api/token-usage
 * Query params:
 *   - from:    ISO 8601 start (default: 7d ago)
 *   - to:      ISO 8601 end   (default: now)
 *   - source:  filter by source_system (optional)
 *   - provider: filter by provider     (optional)
 *   - group:   'provider' | 'source' | 'model' | 'day' (default: 'provider')
 *
 * Returns:
 *   { rows: CanonicalRow[], summary: { total_input, total_output, total_cost_usd } }
 */

// Initialize pool once (module-level singleton)
const pool = new Pool({
  host:     process.env.TELEMETRY_PG_HOST,
  port:     Number(process.env.TELEMETRY_PG_PORT),
  database: process.env.TELEMETRY_PG_DB,
  user:     process.env.TELEMETRY_PG_USER,
  password: process.env.TELEMETRY_PG_PASSWORD,
  ssl:      process.env.TELEMETRY_PG_SSL === 'true',
  max:      5,
});

const SCHEMA = process.env.TELEMETRY_PG_SCHEMA || 'telemetry';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);

  const from     = searchParams.get('from')     || new Date(Date.now() - 7 * 86400 * 1000).toISOString();
  const to       = searchParams.get('to')       || new Date().toISOString();
  const source   = searchParams.get('source');
  const provider = searchParams.get('provider');
  const group    = searchParams.get('group') || 'provider';

  // Validate group param
  const allowedGroups = ['provider', 'source', 'model', 'day'] as const;
  type GroupBy = typeof allowedGroups[number];
  if (!allowedGroups.includes(group as GroupBy)) {
    return NextResponse.json({ error: 'Invalid group param' }, { status: 400 });
  }

  try {
    const groupColumn = {
      provider: 'provider',
      source:   'source_system',
      model:    'model_id',
      day:      "date_trunc('day', window_start)",
    }[group as GroupBy];

    // Build parameterized WHERE clause
    const conditions: string[] = [
      `window_start >= $1`,
      `window_start < $2`,
    ];
    const params: unknown[] = [from, to];

    if (source) {
      params.push(source);
      conditions.push(`source_system = $${params.length}`);
    }
    if (provider) {
      params.push(provider);
      conditions.push(`provider = $${params.length}`);
    }

    const whereClause = conditions.join(' AND ');

    const { rows } = await pool.query(
      `SELECT
          ${groupColumn}                              AS group_key,
          SUM(input_tokens)                           AS input_tokens,
          SUM(output_tokens)                          AS output_tokens,
          SUM(COALESCE(cached_read_tokens, 0))        AS cached_read_tokens,
          SUM(COALESCE(cost_usd, 0))                  AS cost_usd,
          COUNT(DISTINCT model_id)                    AS models_count,
          MIN(window_start)                           AS earliest_window,
          MAX(window_end)                             AS latest_window
       FROM ${SCHEMA}.token_usage
       WHERE ${whereClause}
       GROUP BY ${groupColumn}
       ORDER BY cost_usd DESC NULLS LAST`,
      params
    );

    const summary = rows.reduce(
      (acc, row) => ({
        total_input:    acc.total_input    + Number(row.input_tokens),
        total_output:   acc.total_output   + Number(row.output_tokens),
        total_cost_usd: acc.total_cost_usd + Number(row.cost_usd),
      }),
      { total_input: 0, total_output: 0, total_cost_usd: 0 }
    );

    return NextResponse.json({ rows, summary });
  } catch (err) {
    console.error('[token-usage api]', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
