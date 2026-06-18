# Unified Token Telemetry

Single Postgres fact table for all AI token usage. Covers LiteLLM (via Prometheus), GitHub Copilot (daily API), OpenAI Organization API, Anthropic Admin API, fixed subscriptions (ChatGPT Plus/Pro, Claude Pro, Gemini Advanced, Perplexity Pro, Cursor, Windsurf), and manual imports. Direct Postgres upserts — no Redis, no per-request events.

<img width="2220" height="1197" alt="image" src="https://github.com/user-attachments/assets/d402209d-2f63-4140-8dd6-e60e626210fd" />


## Dependencies

| Dependency | Version | Required | Purpose |
|---|---|---|---|
| **PostgreSQL** | 9.5+ | Yes | Primary data store (`public.token_usage` table). Needs `ON CONFLICT` support. |
| **Node.js** | 18+ | Yes | Runs the rollup worker and all adapter scripts. |
| **Prometheus** | 2.x+ | Conditional | Required only if using the `litellm-prometheus` adapter. Scrapes LiteLLM metrics. |
| **Grafana** | 9+ | Optional | Imports the included dashboard JSON for visualization. Any Postgres-capable BI tool works as a substitute. |

| **OpenAI Admin Key** | — | Conditional | Required for `openai-usage` adapter. Org-level API key with admin scope. |
| **Anthropic Admin Key** | — | Conditional | Required for `anthropic-usage` adapter. Admin key (`sk-ant-admin-...`). |

Additional runtime dependencies (installed via `npm install`):
- `pg` — PostgreSQL client
- `js-yaml` — YAML config parser

## Quick Start

```bash
# 1. Clone and install
git clone <this-repo>
cd unified-token-telemetry
npm install

# 2. Create your instance config
cp templates/config.template.yaml instances/<your-name>/config.yaml
# Edit config.yaml — fill in your Postgres, Prometheus, and Grafana URLs

# 3. Create the schema
psql -f references/schema.sql  # replace {{schema}} with your schema name

# 4. Copy and configure adapters
cp templates/adapters/litellm-prometheus.adapter.js instances/<your-name>/
# Edit adapter config section in config.yaml

# 5. Start the worker
node templates/worker.template.js --config instances/<your-name>/config.yaml

# 6. Verify
bash templates/consumers/verification-runner.sh
```

## Project Structure

```
templates/              # Generic, config-driven templates (no hardcoded values)
├── config.template.yaml
├── migration.template.sql
├── worker.template.js                    # Multi-source worker + freshness checker + watermark backfill
├── adapters/
│   ├── adapter.template.js               # Blank adapter skeleton
│   ├── litellm-prometheus.adapter.js     # LiteLLM via Prometheus (covers Ollama/vLLM/cloud routed through LiteLLM)
│   ├── copilot-daily.adapter.js          # GitHub Copilot daily API
│   ├── openai-usage.adapter.js           # OpenAI Organization Usage API (daily)
│   ├── anthropic-usage.adapter.js        # Anthropic Admin Usage API (daily, with cache breakdown)
│   ├── subscription.adapter.js           # Fixed monthly subscriptions (any plan)
│   └── manual-import.adapter.js          # CSV/JSON manual ingest
└── consumers/
    ├── grafana-dashboard.json
    ├── nextjs-api-route.template.ts
    ├── verification-runner.sh
    └── watchdog-reader.template.sh       # External freshness watchdog (cron, exit-code-based alerting)

references/             # Specifications, contracts, and lessons
├── schema.sql                  # Canonical DDL: token_usage + watchdog_status + rollup_watermark
├── invariants.md               # 13 non-negotiable data rules
├── operational-lessons.md      # 9 real-world failures with durable fixes
├── adapter-contract.md         # Adapter interface specification
├── grafana-queries.sql         # Panel SQL queries
├── verification.sql            # Smoke test queries
└── architecture.md             # Data flow, freshness design, backfill algorithm

instances/              # Per-deployment configs (gitignored)
└── <your-name>/        # Your personal instance
    └── config.yaml

SKILL.md                # Agent-facing README (for AI coding assistants)
```

## Key Concepts

- **Config-driven**: All environment-specific values live in `config.yaml` using `${ENV_VAR}` substitution.
- **Upsert, not append**: Running the worker twice for the same window produces identical rows.
- **NULL ≠ 0**: Unknown cache values stay `NULL`, never zero.
- **Counter-reset safe**: Handles Prometheus counter resets from container restarts.

## Adapter Coverage

| Adapter | `source_system` | Source | Tokens | Cost | Cache | Granularity | `measurement_basis` |
|---|---|---|---|---|---|---|---|
| `litellm-prometheus` | `litellm` | Any model behind LiteLLM (Ollama, vLLM, cloud APIs) | ✅ exact | ✅ computed by worker | ✅ read only (write always NULL) | hour | `exact` |
| `copilot-daily` | `copilot` | GitHub Copilot org metrics | ✅ exact when API returns tokens; estimated from lines_accepted otherwise | ❌ | ❌ | day | `provider_aggregate` OR `derived_estimate` |
| `openai-usage` | `openai_api` | OpenAI Organization Usage API | ✅ exact | ✅ from Costs API | ❌ | day | `exact` |
| `anthropic-usage` | `anthropic_api` | Anthropic Admin API (Claude API usage) | ✅ exact | ✅ from Cost Report API | ✅ read + write (5m + 1h ephemeral combined) | day | `exact` |
| `subscription` | `subscription` | Any flat-fee plan (ChatGPT Plus/Pro, Claude Pro/Max, Gemini Advanced, Perplexity Pro, Cursor Pro/Ultra, Windsurf Pro/Ultra) | ❌ (NULL) | ✅ fixed from config | ❌ | month | `derived_estimate` |
| `manual-import` | `manual` | CSV/JSON file import | ✅ if provided in input | ✅ if provided in input | ❌ (always NULL, regardless of input) | uses input `granularity` field or defaults to `day` | `derived_estimate` (hardcoded) |

**Cost & cache notes:**
- `litellm-prometheus` adapter writes `cost_usd = NULL`; the worker's `calcCost()` function computes cost from the `pricing:` block in `config.yaml` after the adapter returns records. To get cost data, you must populate the pricing config.
- `manual-import` ignores any `cached_read_tokens` / `cached_write_tokens` in the input file and always writes NULL. If you need cache data from a manual import, use a custom adapter.
- `subscription` is the only adapter where tokens are NULL by design — there's no per-request telemetry for a flat-fee plan, only the monthly bill.

**Full-stack gateways** (Bifrost, Helicone, Portkey, WSO2, Kong) are intentionally excluded — they have their own observability. Use this skill for sources that don't already export to Prometheus/Grafana.

## Freshness Monitoring (Phase 1)

The worker writes per-source `watchdog_status` rows on every cycle and a `__heartbeat__` row about itself. A separate external watchdog script (`templates/consumers/watchdog-reader.template.sh`) reads those rows on its own schedule and exits non-zero on staleness. See `references/architecture.md` for the two-layer design and `references/invariants.md` §10-11 for why MAX(updated_at) and SOURCE_STATE_OVERRIDE matter.

The `SOURCE_THRESHOLDS_SECONDS` map in `worker.template.js` ships with example thresholds for common sources beyond the 6 public adapters above — names like `opencode`, `copilot_otel`, `codex_cli`, and `anthropic_desktop` are present as reference cadences for daemons you might add as instance-side extensions (your own collectors that upsert directly into `token_usage`, NOT public adapters). Add or remove entries to match the source_systems your deployment actually writes.

## Backfill After Downtime (Phase 2)

The worker is watermark-driven via `rollup_watermark` and recovers up to `max_backfill_minutes` (24h default) of missed windows in a single cycle after the daemon comes back up. Uses Prometheus `query_range` for a single HTTP round-trip per metric regardless of gap size. See `references/architecture.md` "Backfill & Resume" for the full algorithm and `references/invariants.md` §12-13 for the alignment + query_range invariants.

## Writing Custom Adapters

See `references/adapter-contract.md` for the full interface spec, or start from `templates/adapters/adapter.template.js` (blank skeleton with all required exports).

## Verification

Run `references/verification.sql` against your database or use the automated runner:

```bash
bash templates/consumers/verification-runner.sh
```

Passing means:
- Rows exist for each enabled source
- No `cached_read_tokens = 0` where provider reports no cache (must be `NULL`)
- Idempotent: re-running produces identical row count
- Grafana dashboard loads with data in all panels

## Acknowledgments

This integration was inspired by the [Token Burn All Sources](https://natesnewsletter.substack.com/) dashboard code from Nate B. Jones.

## Contributing

Contributions welcome — especially new adapters for providers not yet covered.

**How to contribute:**

1. Fork this repo
2. Create a branch: `git checkout -b adapter/your-provider`
3. Write your adapter following `references/adapter-contract.md`
4. Add a section to `config.template.yaml` and wire it in `worker.template.js`
5. Run `references/verification.sql` against a test database to confirm invariants hold
6. Submit a PR with a description of what the adapter collects

**Guidelines:**

- Adapters must use only Node.js built-in modules (no npm dependencies beyond `pg` and `js-yaml`)
- Follow the existing naming convention: `your-source.adapter.js`
- Respect invariants in `references/invariants.md` — especially `null` vs `0` for cache tokens
- Include a `detectCapabilities()` that validates credentials before first collection
- Keep adapters stateless — all config comes from `config.yaml`, all state lives in Postgres

**Questions or ideas?** Reach out at [archdrewid.substack.com](https://archdrewid.substack.com/)
