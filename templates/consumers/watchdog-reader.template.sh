#!/usr/bin/env bash
# templates/consumers/watchdog-reader.template.sh
#
# External freshness watchdog — reads public.watchdog_status (populated by the
# worker on every cycle) and exits non-zero on any stale source. Designed to
# run from cron / systemd timer / GitHub Actions schedule independently of
# the worker process, providing a second layer of liveness detection.
#
# Two-layer architecture (see references/architecture.md "Backfill & Resume"):
#   1. The WORKER writes per-source status rows + __heartbeat__ on every cycle
#      (in-process check — knows if it tried).
#   2. THIS SCRIPT reads them on its own schedule (out-of-process check —
#      knows if the worker itself died and stopped writing).
#
#   If __heartbeat__ goes stale, the worker is dead and every other 'ok'
#   row is suspect (meta-failure). This script's exit code 2 distinguishes
#   that case from per-source staleness (exit code 1).
#
# Setup:
#   1. Copy this file to your ops box, e.g. /opt/telemetry/watchdog.sh
#   2. Fill in the {{...}} placeholders below (or override via env vars).
#   3. Install in cron, every 5 minutes:
#        */5 * * * * /opt/telemetry/watchdog.sh --quiet >> /var/log/telemetry_watchdog.log 2>&1
#
# Modes:
#   ./watchdog.sh                  # human-readable + syslog
#   ./watchdog.sh --quiet          # syslog only (cron-friendly)
#   ./watchdog.sh --json           # machine-readable output for downstream alerting
#
# Exit codes:
#   0 - all sources ok (paused/never_seen don't count as failures)
#   1 - at least one source is 'stale' (real failure needing attention)
#   2 - __heartbeat__ itself is stale (worker is down — meta-failure)
#   3 - script error (DB unreachable, container missing, etc.)
#
# Requires: docker (or psql native), bash 4+. No jq dependency.

set -euo pipefail

# ---------------------------------------------------------------------------
# Config — set via env or edit these defaults
# ---------------------------------------------------------------------------
# Option A: psql runs inside a docker container (typical homelab setup)
DB_CONTAINER="${DB_CONTAINER:-{{db_container_name}}}"   # e.g., "telemetry_db"
USE_DOCKER="${USE_DOCKER:-true}"

# Option B: psql is on the host PATH (set USE_DOCKER=false)
# Standard libpq env vars (PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE) are honored

DB_NAME="${DB_NAME:-{{db_name}}}"                       # e.g., "telemetry"
DB_USER="${DB_USER:-{{db_user}}}"                       # e.g., "telemetry_app"
DB_SCHEMA="${DB_SCHEMA:-public}"

SYSLOG_TAG="${SYSLOG_TAG:-telemetry_watchdog}"
SYSLOG_FACILITY="${SYSLOG_FACILITY:-local0}"
CHECKED_BY="${CHECKED_BY:-external-watchdog}"

QUIET=false
JSON_OUT=false

# ---------------------------------------------------------------------------
# Args
# ---------------------------------------------------------------------------
for arg in "$@"; do
  case "$arg" in
    --quiet) QUIET=true ;;
    --json)  JSON_OUT=true ;;
    -h|--help)
      sed -n '2,38p' "$0"
      exit 0
      ;;
    *) echo "Unknown arg: $arg" >&2; exit 3 ;;
  esac
done

# ---------------------------------------------------------------------------
# Logging helper — human + syslog
# ---------------------------------------------------------------------------
log() {
  local level="$1" msg="$2"
  local ts; ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  if [[ "$QUIET" == "false" && "$JSON_OUT" == "false" ]]; then
    echo "${ts} [${level}] ${msg}"
  fi
  local priority="${SYSLOG_FACILITY}.info"
  case "$level" in
    ERROR) priority="${SYSLOG_FACILITY}.err" ;;
    WARN)  priority="${SYSLOG_FACILITY}.warning" ;;
  esac
  logger -t "$SYSLOG_TAG" -p "$priority" -- "$msg" 2>/dev/null || true
}

# ---------------------------------------------------------------------------
# Pre-flight + run psql query
# ---------------------------------------------------------------------------
run_psql() {
  # Use -A unaligned, -t tuples-only, -F | separator for safe shell parsing.
  local sql="$1"
  if [[ "$USE_DOCKER" == "true" ]]; then
    if ! command -v docker >/dev/null 2>&1; then
      log ERROR "docker not in PATH"; exit 3
    fi
    if ! docker ps --filter "name=${DB_CONTAINER}" --filter "status=running" --format '{{.Names}}' | grep -qx "$DB_CONTAINER"; then
      log ERROR "DB container '${DB_CONTAINER}' is not running"; exit 3
    fi
    docker exec -i "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -A -t -F '|' -c "$sql" 2>/dev/null
  else
    if ! command -v psql >/dev/null 2>&1; then
      log ERROR "psql not in PATH (set USE_DOCKER=true or install postgresql-client)"; exit 3
    fi
    psql -U "${DB_USER}" -d "${DB_NAME}" -A -t -F '|' -c "$sql" 2>/dev/null
  fi
}

# ---------------------------------------------------------------------------
# Query watchdog_status
# ---------------------------------------------------------------------------
RAW=$(
  run_psql "
    SELECT
      source_system,
      status,
      threshold_seconds,
      COALESCE(stale_seconds, -1),
      COALESCE(EXTRACT(EPOCH FROM (NOW() - last_check_at))::bigint, -1),
      COALESCE(message, '')
    FROM ${DB_SCHEMA}.watchdog_status
    ORDER BY
      CASE status WHEN 'stale' THEN 0 WHEN 'never_seen' THEN 1 WHEN 'ok' THEN 2 WHEN 'paused' THEN 3 ELSE 4 END,
      source_system;
  "
) || { log ERROR "psql query failed"; exit 3; }

if [[ -z "${RAW// }" ]]; then
  log ERROR "${DB_SCHEMA}.watchdog_status table is empty — worker may have never run"
  exit 2
fi

# ---------------------------------------------------------------------------
# Parse + classify
# ---------------------------------------------------------------------------
STALE_COUNT=0
NEVER_COUNT=0
OK_COUNT=0
PAUSED_COUNT=0
HEARTBEAT_STALE=false
HEARTBEAT_SEEN=false
declare -a STALE_LINES=()
declare -a JSON_ROWS=()

while IFS='|' read -r src status threshold stale_sec since_check msg; do
  [[ -z "$src" ]] && continue

  case "$status" in
    ok)         OK_COUNT=$((OK_COUNT + 1)) ;;
    paused)     PAUSED_COUNT=$((PAUSED_COUNT + 1)) ;;
    stale)
      STALE_COUNT=$((STALE_COUNT + 1))
      STALE_LINES+=("${src}: ${msg}")
      ;;
    never_seen) NEVER_COUNT=$((NEVER_COUNT + 1)) ;;
    *)          ;;
  esac

  # Heartbeat meta-check: __heartbeat__ row's last_check_at must be younger
  # than its own threshold. The worker writes it every cycle; if
  # since_check exceeds threshold_seconds, the worker itself is dead.
  if [[ "$src" == "__heartbeat__" ]]; then
    HEARTBEAT_SEEN=true
    if [[ "$since_check" -gt "$threshold" ]]; then
      HEARTBEAT_STALE=true
      log ERROR "__heartbeat__ last wrote ${since_check}s ago — exceeds ${threshold}s threshold; worker is DOWN"
    fi
  fi

  if [[ "$JSON_OUT" == "true" ]]; then
    # Hand-rolled JSON to avoid jq dependency. Escape backslashes + double-quotes.
    esc_msg=${msg//\\/\\\\}; esc_msg=${esc_msg//\"/\\\"}
    JSON_ROWS+=("{\"source_system\":\"${src}\",\"status\":\"${status}\",\"threshold_seconds\":${threshold},\"stale_seconds\":${stale_sec},\"seconds_since_check\":${since_check},\"message\":\"${esc_msg}\"}")
  fi
done <<< "$RAW"

# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------
if [[ "$JSON_OUT" == "true" ]]; then
  printf '{"checked_at":"%s","ok":%d,"stale":%d,"never_seen":%d,"paused":%d,"heartbeat_seen":%s,"heartbeat_stale":%s,"rows":[%s]}\n' \
    "$(date -u +%FT%TZ)" "$OK_COUNT" "$STALE_COUNT" "$NEVER_COUNT" "$PAUSED_COUNT" \
    "$HEARTBEAT_SEEN" "$HEARTBEAT_STALE" \
    "$(IFS=,; echo "${JSON_ROWS[*]:-}")"
else
  log INFO "freshness summary — ok=${OK_COUNT} stale=${STALE_COUNT} never_seen=${NEVER_COUNT} paused=${PAUSED_COUNT} heartbeat_ok=$([[ $HEARTBEAT_STALE == false ]] && echo true || echo false)"
  if (( STALE_COUNT > 0 )); then
    for line in "${STALE_LINES[@]}"; do
      log WARN "STALE → ${line}"
    done
  fi
fi

# ---------------------------------------------------------------------------
# Exit
# ---------------------------------------------------------------------------
# Precedence: heartbeat-stale (meta-failure) > stale rows > all-ok/never-seen/paused.
# 'never_seen' alone is not a failure — it just means a source is configured
# but has never produced a row (legitimate state for sources you haven't
# enabled yet). 'paused' is intentional ops state (see invariants.md §11).
if [[ "$HEARTBEAT_STALE" == "true" ]]; then
  exit 2
elif (( STALE_COUNT > 0 )); then
  exit 1
fi

if ! $HEARTBEAT_SEEN; then
  log ERROR "__heartbeat__ row missing from ${DB_SCHEMA}.watchdog_status — worker has never written one"
  exit 2
fi

exit 0
