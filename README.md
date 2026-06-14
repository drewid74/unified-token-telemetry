# Unified Token Telemetry

Single Postgres fact table for all AI token usage. Covers LiteLLM (via Prometheus), GitHub Copilot (daily API), OpenAI Organization API, Anthropic Admin API, fixed subscriptions (ChatGPT Plus/Pro, Claude Pro, Gemini Advanced, Perplexity Pro, Cursor, Windsurf), and manual imports. Direct Postgres upserts — no Redis, no per-request events.

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
├── worker.template.js
├── adapters/           # Source-specific collectors
│   ├── adapter.template.js              # Blank adapter skeleton
│   ├── litellm-prometheus.adapter.js    # LiteLLM via Prometheus (covers Ollama/vLLM backends)
│   ├── copilot-daily.adapter.js         # GitHub Copilot daily API
│   ├── openai-usage.adapter.js          # OpenAI Organization Usage API (daily)
│   ├── anthropic-usage.adapter.js       # Anthropic Admin Usage API (daily, with cache breakdown)
│   ├── subscription.adapter.js          # Fixed monthly subscriptions (any plan)
│   └── manual-import.adapter.js         # CSV/JSON manual ingest
└── consumers/          # Output/visualization
    ├── grafana-dashboard.json
    ├── nextjs-api-route.template.ts
    └── verification-runner.sh

references/             # Specifications and contracts
├── schema.sql          # Canonical DDL (17 columns, 2 enums)
├── invariants.md       # Non-negotiable data rules
├── adapter-contract.md # Adapter interface specification
├── grafana-queries.sql # Panel SQL queries
├── verification.sql    # Smoke test queries
└── architecture.md     # System design overview

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

| Adapter | Source | Tokens | Cost | Cache | Granularity |
|---|---|---|---|---|---|
| `litellm-prometheus` | Any model behind LiteLLM (Ollama, vLLM, cloud APIs) | ✅ exact | ✅ computed | ✅ read | hour |
| `copilot-daily` | GitHub Copilot org metrics | ✅ exact | ❌ | ❌ | day |
| `openai-usage` | OpenAI Organization API (ChatGPT API, GPT-4, etc.) | ✅ exact | ✅ from API | ❌ | day |
| `anthropic-usage` | Anthropic Admin API (Claude API usage) | ✅ exact | ✅ from API | ✅ read+write | day |
| `subscription` | Any flat-fee plan (ChatGPT Plus/Pro, Claude Pro, Gemini, Perplexity, Cursor, Windsurf) | ❌ | ✅ fixed | ❌ | month |
| `manual-import` | CSV/JSON file import | ✅ varies | ✅ if provided | varies | varies |

**Full-stack gateways** (Bifrost, Helicone, Portkey, WSO2, Kong) are intentionally excluded — they have their own observability. Use this skill for sources that don't already export to Prometheus/Grafana.

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
