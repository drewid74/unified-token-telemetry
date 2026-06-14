# Unified Token Telemetry Architecture

The Unified Token Telemetry system provides a centralized repository for tracking token consumption across multiple AI providers and systems. It ingests high-frequency metrics from LiteLLM and integrates manual or derived estimates from other sources to provide a complete picture of model usage and costs.

## System Components

### Containers
* **rollup worker**: Runs on node:22-alpine in daemon mode. Executes every 60 minutes to poll Prometheus and update the database. Restarts unless stopped.
* **dashboard**: A standalone Next.js 15 application serving the UI and a JSON API at `/api/burn-data`.

### Database
The primary data store is the `public.token_usage` table in your PostgreSQL database.
* **Location**: Configured via `DATABASE_URL` environment variable (internal Docker alias or external host).
* **Constraint**: A unique constraint ensures data integrity across `(source_system, model_id, window_start, window_end, user_id)`, where NULLs are treated as distinct values.

### Visualization
* **Grafana Dashboard**: "Token Telemetry" (uid: `unified-token-telemetry`) — pointed at your Grafana instance.
* **Panels**: Includes cost trends, cache efficiency analysis, and a breakdown of usage by source.

## Data Flow

The telemetry pipeline follows this path:
1. **LiteLLM**: Serves raw metrics at `${LITELLM_HOST}:${LITELLM_PORT}`.
2. **Prometheus**: Scrapes LiteLLM via a configured scrape job.
3. **Rollup worker**: Queries the Prometheus API at 60-minute intervals.
4. **PostgreSQL**: Stores processed usage records in `public.token_usage`.
5. **Dashboard**: Consumes database records to serve the UI and `/api/burn-data`.
6. **Grafana**: Visualizes the aggregated data using the PostgreSQL datasource.

Additional sources feed directly into the `token_usage` table via dedicated ingestion scripts for manual or estimated metrics.

## Key Invariants
* **Upsert Logic**: New data replaces existing records for the same window rather than being added to them.
* **Cache Precision**: Unknown cache values stay NULL instead of defaulting to zero.
* **Collection Safety**: Ingestion handles counter resets to ensure accurate totals.
* **Basis Clarity**: The `measurement_basis` field distinguishes between exact, aggregate, and estimated data.

## Operational Procedures

### Management Commands
* **Restart Rollup**: `docker restart <rollup_container>`
* **View Logs**: `docker logs <rollup_container> --tail 20`
* **Manual Run**: `docker exec <rollup_container> node /app/rollup.js --once`

### Rebuilding Dashboard
To update the dashboard image and redeploy:
```bash
cd <path-to-dashboard-image>
docker build -t token-burn:latest .
docker compose up -d --force-recreate <dashboard_service>
```

## Network Configuration
The rollup container communicates using internal Docker aliases:
* Prometheus: `<prometheus_alias>:9090`
* Database: `<db_alias>:5432`

The dashboard uses the host-accessible database address defined in the `DATABASE_URL` environment variable.

## Portability
This reference describes the general architecture. Your specific instance configuration lives in `instances/<your-name>/`. See `templates/config.template.yaml` for all configurable values.
