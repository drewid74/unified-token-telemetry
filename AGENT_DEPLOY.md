# Agent Deployment Notes — Unified Token Telemetry

> These notes are for AI coding agents deploying this system on behalf of a user.
> Read this file BEFORE starting deployment. It contains gotchas, decision points,
> and verification steps that prevent the most common failure modes.

---

## Pre-Flight Checklist

Before writing any config or running any commands, confirm these with the user:

| Question | Why | Default if not answered |
|---|---|---|
| PostgreSQL host/port/credentials | Required for all operations | No default — must ask |
| Schema name | Used in DDL and all queries | `telemetry` |
| Which sources to enable? | Determines which adapters to configure | `litellm` only |
| Prometheus URL (if LiteLLM) | Adapter queries Prometheus, not LiteLLM directly | Must ask |
| Prometheus job label for LiteLLM | Filters metrics to the correct scrape target | `litellm` |
| OpenAI org admin key (if OpenAI) | Organization Usage API requires org-level key | Must ask |
| Anthropic admin key (if Anthropic) | Admin API requires `sk-ant-admin-...` key | Must ask |
| Which subscriptions are active? | For subscription adapter cost tracking | Ask — see plans list in config |
| Run mode: cron or daemon? | Affects how you deploy the worker | `--once` via cron |
| Grafana URL + API key (optional) | Only needed for automated dashboard import | Skip if not using |

---

## Deployment Sequence (Exact Order)

```
1. npm install              ← installs pg + js-yaml only
2. Create instance dir      ← instances/<name>/
3. Copy + fill config.yaml  ← from templates/config.template.yaml
4. Create .env file         ← copy .env.example, fill secrets
5. Run schema.sql           ← creates table + enums in Postgres
6. Test worker --once       ← single collection cycle to verify
7. Set up scheduling        ← cron or --daemon flag
8. Import Grafana dashboard ← optional, last step
9. Run verification         ← proves everything works end-to-end
```

### Step-by-Step with Commands

```bash
# 1. Install
cd unified-token-telemetry && npm install

# 2. Instance directory
mkdir -p instances/<name>

# 3. Config
cp templates/config.template.yaml instances/<name>/config.yaml
# EDIT: fill in all ${ENV_VAR} placeholders or set them in .env

# 4. Environment
cp .env.example instances/<name>/.env
# EDIT: fill in actual credentials

# 5. Schema (replace {{schema}} with value from config, e.g., "telemetry")
sed 's/{{schema}}/telemetry/g' references/schema.sql | psql -h <host> -U <user> -d <db>

# 6. Test run
source instances/<name>/.env
node templates/worker.template.js instances/<name>/config.yaml --once

# 7a. Cron (recommended: hourly)
# crontab -e → add:
# 0 * * * * cd /path/to/unified-token-telemetry && source instances/<name>/.env && node templates/worker.template.js instances/<name>/config.yaml --once

# 7b. OR daemon mode
node templates/worker.template.js instances/<name>/config.yaml --daemon

# 8. Grafana (optional)
# Import templates/consumers/grafana-dashboard.json via Grafana UI or API
# Set the DS_POSTGRES datasource variable to your Postgres connection

# 9. Verify
source instances/<name>/.env
bash templates/consumers/verification-runner.sh
```

---

## Common Failure Modes

| Symptom | Cause | Fix |
|---|---|---|
| `Missing env var: TELEMETRY_PG_HOST` | .env not sourced before running | `source instances/<name>/.env` first |
| `relation "telemetry.token_usage" does not exist` | Schema not created yet | Run step 5 (schema.sql) |
| `type "telemetry.token_measurement_basis" does not exist` | Schema SQL run out of order or partially | Drop schema and re-run full schema.sql |
| `HTTP 401 for Prometheus URL` | Prometheus requires auth but none configured | Add auth headers or use unauthenticated endpoint |
| `0 records collected` (LiteLLM) | Prometheus job label mismatch | Check `sources.litellm.prometheus.job_name` matches your Prometheus config |
| `0 records collected` (LiteLLM) | LiteLLM metrics not being scraped | Verify Prometheus targets page shows LiteLLM target as UP |
| `OpenAI API 401` | Key lacks org admin scope | Generate org-level key at platform.openai.com/settings/organization/api-keys |
| `Anthropic auth failed (401)` | Using regular API key instead of admin key | Requires `sk-ant-admin-...` from console.anthropic.com/settings/admin-keys |
| `0 records collected` (subscriptions) | All plans disabled or billing_day hasn't passed | Check `sources.subscriptions.plans[].enabled` and `billing_day` |
| `duplicate key value violates unique constraint` | Should never happen — upsert handles this | Check worker version; older copies may use INSERT instead of upsert |
| Worker runs but Grafana shows no data | DS_POSTGRES datasource not set or wrong schema | Check Grafana datasource config and schema variable |
| `cached_read_tokens = 0` in verification | Adapter incorrectly defaulting to 0 | Must be `null` when provider doesn't report cache — fix adapter |

---

## Architecture Decisions (Context for the Agent)

- **No ORM** — raw SQL via `pg` library. The schema is simple (one table) and upserts need ON CONFLICT control.
- **No queue/Redis** — direct Prometheus HTTP queries → Postgres upserts. Simplicity over scalability.
- **Config is YAML** — `js-yaml` parses it. `${ENV_VAR}` substitution happens at load time in the worker.
- **Templates, not a framework** — users copy files into their instance. No CLI, no scaffolding command.
- **Adapters are plain .js files** — each exports the interface from `references/adapter-contract.md`. No class hierarchy, no DI.

---

## Key Invariants (Non-Negotiable)

These MUST hold after deployment. Verification script checks 3 of 4:

1. **Replacement upserts** — running worker twice for the same window = identical row count (not doubled).
2. **NULL for unknown cache** — `cached_read_tokens` / `cached_write_tokens` must be `NULL` (not `0`) when the provider doesn't report cache data. Copilot = always NULL. OpenAI = always NULL. Subscription = always NULL.
3. **Counter-reset safe** — if Prometheus counter resets (container restart), adapter detects and uses current value as delta instead of computing negative.
4. **measurement_basis accuracy** — `exact` for LiteLLM/OpenAI/Anthropic (per-request API counts), `provider_aggregate` for Copilot (daily rollup), `derived_estimate` for subscriptions and manual calculations.

---

## Adapter Selection Guide

| User has... | Enable | Adapter file |
|---|---|---|
| LiteLLM proxying AI calls + Prometheus scraping it | `sources.litellm` | `litellm-prometheus.adapter.js` |
| GitHub Copilot org license | `sources.copilot` | `copilot-daily.adapter.js` |
| OpenAI API usage (org-level key) | `sources.openai` | `openai-usage.adapter.js` |
| Anthropic API usage (admin key) | `sources.anthropic` | `anthropic-usage.adapter.js` |
| Fixed subscriptions (ChatGPT Plus/Pro, Claude Pro, Gemini, Perplexity, Cursor, Windsurf) | `sources.subscriptions` | `subscription.adapter.js` |
| Manual CSV/JSON exports from other providers | `sources.manual` | `manual-import.adapter.js` |
| Custom source not listed | Write new adapter | Start from `adapter.template.js` |

### What NOT to add adapters for

Full-stack gateways (Bifrost, Helicone, Portkey, WSO2, Kong) — they ship their own Prometheus/Grafana observability. Don't duplicate.

Direct Ollama/vLLM — covered by LiteLLM adapter when routed through LiteLLM. If running bare Ollama/vLLM without LiteLLM, use manual-import or write a custom adapter.

---

## Docker Deployment Pattern

If deploying as a container (common for homelab / server):

```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --production
COPY templates/ templates/
COPY references/ references/
COPY instances/<name>/ instances/<name>/
CMD ["node", "templates/worker.template.js", "instances/<name>/config.yaml", "--daemon"]
```

Or use `docker run` with volume mount:

```bash
docker run -d \
  --name token-telemetry \
  --restart unless-stopped \
  --env-file instances/<name>/.env \
  -v $(pwd)/instances/<name>:/app/instances/<name> \
  node:18-alpine \
  sh -c "cd /app && node templates/worker.template.js instances/<name>/config.yaml --daemon"
```

---

## Verification Checklist (Post-Deploy)

Run these to confirm deployment is healthy:

```sql
-- Row count by source (should have rows for each enabled source)
SELECT source_system, COUNT(*), MAX(window_start) AS latest
FROM telemetry.token_usage GROUP BY 1;

-- Invariant: no duplicates on conflict key
SELECT source_system, model_id, window_start, window_end, user_id, COUNT(*)
FROM telemetry.token_usage
GROUP BY 1,2,3,4,5 HAVING COUNT(*) > 1;
-- Expected: 0 rows

-- Invariant: Copilot cache columns are NULL
SELECT COUNT(*) FROM telemetry.token_usage
WHERE source_system = 'copilot'
  AND (cached_read_tokens IS NOT NULL OR cached_write_tokens IS NOT NULL);
-- Expected: 0
```

Or just run: `bash templates/consumers/verification-runner.sh`

---

## Extending: Writing a New Adapter

1. Copy `templates/adapters/adapter.template.js`
2. Implement all methods from `references/adapter-contract.md`
3. Add a new `sources.<name>` section to config.yaml
4. Add a collection block in the worker's `runCollectionCycle()` function
5. Run verification after first collection to confirm invariants hold

---

## Files the Agent Should Never Modify

- `references/schema.sql` — canonical DDL, modify only via migrations
- `references/invariants.md` — data contract, not implementation
- `references/adapter-contract.md` — interface spec, not code

## Files the Agent Freely Modifies

- `instances/<name>/*` — all per-deployment config
- `templates/worker.template.js` — to add new source collection blocks
- `templates/adapters/*.adapter.js` — adapter implementations
