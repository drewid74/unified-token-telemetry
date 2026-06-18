---
name: unified-token-telemetry
description: "Use this when: track AI token usage across providers, build unified cost dashboard, how much am I spending on AI, compare model costs, cache hit ratio monitoring, LiteLLM token tracking, GitHub Copilot usage, OpenAI usage API, Anthropic usage API, ChatGPT Plus cost tracking, Claude Pro cost tracking, Gemini Advanced cost, Perplexity Pro cost, Cursor usage, Windsurf usage, multi-provider token telemetry, subscription cost tracking, idempotent token collection, hourly token rollups"
type: "skill"
---

# Unified Token Telemetry

Single Postgres fact table for all AI token usage. Covers LiteLLM (via Prometheus, routing to Ollama/vLLM/cloud APIs), GitHub Copilot (daily API), OpenAI Organization Usage API, Anthropic Admin API (with cache breakdown), fixed subscriptions (ChatGPT Plus/Pro, Claude Pro/Max, Gemini Advanced, Perplexity Pro, Cursor Pro/Ultra, Windsurf Pro/Ultra), and manual imports. Direct Postgres upserts — no Redis, no per-request events.

## Workflow

1. **Intake** — Copy `templates/config.template.yaml` → `instances/{name}/config.yaml`. Fill in all fields for your environment.
2. **Schema** — Run `references/schema.sql` against your Postgres. Replace `{{schema}}` with your schema name (e.g. `telemetry`). Or use `templates/migration.template.sql` for a versioned migration. Schema includes `token_usage` (facts), `watchdog_status` (Phase 1 freshness), and `rollup_watermark` (Phase 2 backfill cursor).
3. **Adapters** — Copy relevant adapters from `templates/adapters/` into your project. Configure each source section in config.yaml.
4. **Worker** — Copy `templates/worker.template.js`. Point it at your config.yaml. Run on cron or as a long-running process. The worker writes `watchdog_status` rows on every cycle and supports watermark-driven backfill after downtime.
5. **External freshness watchdog** — Copy `templates/consumers/watchdog-reader.template.sh` to your ops box, fill in DB connection placeholders, install as cron `*/5 * * * *`. This is the second layer that detects when the worker itself dies.
6. **Consumers** — Import `templates/consumers/grafana-dashboard.json` into Grafana. Set the `DS_POSTGRES` datasource variable. Optionally deploy `nextjs-api-route.template.ts`.
7. **Verify** — Run `templates/consumers/verification-runner.sh` or execute `references/verification.sql` manually to confirm data is flowing and invariants hold.

## Invariants

Read `references/invariants.md` before writing any adapter code. Non-negotiable rules (13 total — only the headliners listed here):

- §1: Upserts are **replacement**, not additive — running twice must produce identical row counts.
- §2: `cached_read_tokens` / `cached_write_tokens` are `NULL` when provider reports no cache data — never `0`.
- §3: Counter resets (container restarts) detected by: if current_counter < last_recorded, treat current as delta.
- §4: `measurement_basis` must accurately reflect how tokens were counted — affects cost math downstream.
- §7: `UNIQUE NULLS NOT DISTINCT` is required on the conflict key for PG 15+ (or paired partial-unique-indexes for PG <15).
- §8: Every HTTP call has a 15-second socket deadline.
- §9: Exit code 2 on partial source failure (vs 0 for all-ok, 1 for fatal).
- §10: Freshness liveness uses `MAX(updated_at)`, NEVER `MAX(created_at)` (idempotent replay sources falsely look stale otherwise).
- §11: `SOURCE_STATE_OVERRIDE` for sources that are configured-but-not-operating ('paused' status).
- §12: Watermarks must be wall-clock aligned; snap forward on read.
- §13: Use Prometheus `query_range` for multi-window backfill (1 round-trip vs N).

## Adapter Capabilities

| Adapter | Granularity | Cache Data | measurement_basis | Cost |
|---------|-------------|------------|-------------------|------|
| litellm-prometheus | hour | read + write | exact | computed from pricing config |
| copilot-daily | day | none (NULL) | provider_aggregate | none |
| openai-usage | day | none (NULL) | exact | from API |
| anthropic-usage | day | read + write | exact | from API |
| subscription | month | none (NULL) | derived_estimate | fixed monthly |
| manual-import | any | optional | varies | if provided |

### What's NOT covered (by design)

Full-stack gateways with their own observability (Bifrost, Helicone, Portkey, WSO2, Kong) — they already export to Prometheus/Grafana natively.

Local inference backends (Ollama, vLLM) — covered implicitly when routed through LiteLLM.

## Reference Files

- `AGENT_DEPLOY.md` — **read first** — deployment walkthrough, failure modes, and decision points for agents
- `references/schema.sql` — canonical DDL (token_usage + watchdog_status + rollup_watermark)
- `references/invariants.md` — non-negotiable data rules (13 numbered invariants)
- `references/operational-lessons.md` — real-world failures and durable fixes (9 lessons covering encoding bugs, npm half-installs, schema migrations, watermark alignment, etc.)
- `references/adapter-contract.md` — adapter interface specification
- `references/grafana-queries.sql` — panel SQL queries
- `references/verification.sql` — smoke test queries
- `references/architecture.md` — data flow, freshness detection, backfill design
- `templates/consumers/watchdog-reader.template.sh` — external freshness watchdog (Phase 1 D2)
- `.env.example` — all required environment variables with placeholder values

## Done Means

- `references/verification.sql` queries return rows for each enabled source.
- No row has `cached_read_tokens = 0` where provider reports no cache (must be `NULL`).
- Running the worker twice for the same window produces identical row count (idempotent).
- Watermark advances correctly: `SELECT * FROM rollup_watermark` shows aligned timestamps and recent `updated_at`.
- Worker writes `watchdog_status` rows on every cycle (check `SELECT status, COUNT(*) FROM watchdog_status GROUP BY status`).
- External watchdog reader (cron) exits 0 — all enabled sources are `ok` or `paused`.
- Grafana dashboard loads with data in all three panels.
- `grep -r "192.168" ./ | grep -v "instances/"` returns zero matches.
