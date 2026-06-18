# Operational Lessons Learned

Real-world deployment failures and their root causes, recorded so future operators (and future-you) don't rediscover them. Each section names the failure mode, the root cause, and the durable fix.

---

## 1. The Two-Layer Freshness Architecture

**Why the worker can't be the only thing checking freshness:**

If only the worker writes freshness rows, then when the worker dies, freshness stops being reported — but the existing `last_check_at` values stay frozen as "the last good check." A downstream dashboard reading those rows shows everything green right up until the moment someone notices the dashboard hasn't moved in days.

**Layer 1 (in-process):** The worker writes per-source rows AND a synthetic `__heartbeat__` row on every cycle. This is cheap and proves "the worker ran this cycle and tried each source."

**Layer 2 (out-of-process):** A separate process (cron-fired bash, k8s sidecar, GitHub Actions schedule) reads `watchdog_status` and exits non-zero based on:
- `status='stale'` in any non-paused row → exit 1
- `__heartbeat__` row itself is older than its threshold → exit 2 (the worker is dead)

The out-of-process layer is what makes "worker died and stopped writing" detectable. See `templates/consumers/watchdog-reader.template.sh` for the reference implementation.

---

## 2. The MAX(updated_at) vs MAX(created_at) Bug

**Symptom:** Watchdog reports a source as stale even though its daemon is clearly running and recently logged successful upserts.

**Root cause:** The freshness check was using `MAX(created_at)` to determine "last ingest time." `created_at` is set on INSERT and never changes. A daemon that polls existing session files for new tokens and finds no new sessions correctly does ON CONFLICT UPDATE — the row's `updated_at` advances, but `created_at` stays frozen at the original insert time. The freshness check then sees "row hasn't been touched in 10 days" when really the daemon has been running and upserting every 5 minutes.

**Fix:** Use `MAX(updated_at)`. The `updated_at` column is refreshed on every UPSERT (via trigger or explicit `updated_at = NOW()` in the conflict clause), making it the true "daemon proof of life" timestamp.

See **invariants.md §10** for the formal invariant.

---

## 3. Half-Failed npm install of Native Modules

**Symptom:** A Node script that depends on `better-sqlite3` (or any other native module) silently fails with `Cannot find module 'better-sqlite3'`. The daemon's scheduled task exits 0 (because the WSH wrapper exits 0 even when node crashes). The watchdog sees no new rows being written.

**Root cause:** The previous `npm install` aborted mid-install (Node version mismatch, no MSVC build chain, network drop during prebuild download). npm left a half-installed artifact directory like `node_modules/.better-sqlite3-0msxO664` instead of the final `node_modules/better-sqlite3`. The directory exists with the artifact name, so a casual `ls node_modules/` looks fine, but `require('better-sqlite3')` fails.

**Fix:** Clean the artifact directory and re-install:
```sh
rm -rf node_modules/.better-sqlite3-*
npm install better-sqlite3
```

**Prevention:** List native-only dependencies under `optionalDependencies` in `package.json` with a load-bearing comment explaining why:
```json
"//optionalDependencies": "better-sqlite3 is required ONLY by instances/*/foo-daemon.js. Optional because the core worker does not need it; a failed install does not break npm install. The daemon will print 'No SQLite module found' at startup if missing.",
"optionalDependencies": {
  "better-sqlite3": "^12.0.0"
}
```
This way a build failure on `better-sqlite3` doesn't break `npm install` for users who don't need it.

---

## 4. VS Code SQLite Schema Migration (workspaceStorage → globalStorage)

**Symptom:** A daemon that reads VS Code Copilot Chat OTel traces from `agent-traces.db` reports zero traces even though Copilot Chat is being used heavily.

**Root cause #1 (path):** Earlier VS Code versions stored Copilot Chat OTel traces in `workspaceStorage/<workspace-id>/github.copilot-chat/agent-traces.db` (one DB per workspace). Later versions (late 2025+) moved to `globalStorage/github.copilot-chat/agent-traces.db` (one global DB). A daemon searching only `workspaceStorage/` finds nothing on a current VS Code install.

**Root cause #2 (schema):** The current `agent-traces.db` schema has multiple tables matching `LIKE '%span%'`: `spans`, `span_attributes`, `span_events`. A naive `SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%span%' LIMIT 1` returns `span_attributes` (alphabetically first), not `spans`. The daemon then tries to query `trace_id` from `span_attributes`, which doesn't exist (that table has `span_id, key, value`), and silently fails over to the fallback query path which also doesn't match.

**Root cause #3 (column shape):** The current schema has `input_tokens`, `output_tokens`, `cached_tokens`, `reasoning_tokens` as first-class columns on the `spans` table. The older schema had a JSON `attributes` column with keys like `gen_ai.usage.prompt_tokens`. A daemon written for the old shape can't extract token counts from the new shape.

**Fix:** Search BOTH locations (globalStorage as primary, workspaceStorage as fallback). Match table names EXACTLY: `name IN ('spans', 'otel_spans')`. Support BOTH schema shapes — try direct-column extraction first, fall back to JSON-attributes parsing.

```js
function findOtelDbs() {
  const dbs = [];
  const globalDb = path.join(GLOBAL_STORAGE, 'github.copilot-chat', DB_NAME);
  if (fs.existsSync(globalDb)) dbs.push(globalDb);
  if (fs.existsSync(WS_STORAGE)) {
    for (const wsId of fs.readdirSync(WS_STORAGE)) {
      const dbPath = path.join(WS_STORAGE, wsId, 'github.copilot-chat', DB_NAME);
      if (fs.existsSync(dbPath)) dbs.push(dbPath);
    }
  }
  return dbs;
}
```

---

## 5. Windows PowerShell 5.1 + UTF-8 Without BOM

**Symptom:** A `.ps1` script that runs fine when edited fails on next execution with `Unexpected token '}'` parse errors that point to syntactically valid lines.

**Root cause:** Windows PowerShell 5.1 (the default on Windows 10/11 without explicit `pwsh` install) defaults to Windows-1252 encoding for files without a BOM. Editors like VS Code default to writing UTF-8 without BOM. If your script contains any non-ASCII characters (em-dashes `—`, smart quotes `'`, arrows `→`), PowerShell parses the multi-byte UTF-8 sequences as garbage Windows-1252 chars, corrupting the script.

**Fix:** Either (a) save the script as UTF-8 WITH BOM, or (b) keep the script ASCII-only. Option (b) is more portable.

**Sentinel comment for the next person:**
```powershell
# IMPORTANT: This file is ASCII-only (no em-dashes, smart quotes, etc.) because
# Windows PowerShell 5.1 default file encoding is Windows-1252 and will mis-
# parse UTF-8 multi-byte sequences without a BOM. Don't reintroduce Unicode
# punctuation here without also writing the file as UTF-8 with BOM.
```

**Bonus lesson:** Add a `TICK` heartbeat log even when nothing needs doing:
```powershell
Write-Log "TICK - watchdog running"
```
Otherwise an empty log file is indistinguishable from "the watchdog is not running at all" — exactly when you most need to know which one it is.

---

## 6. Backfill Watermarks Must Be Wall-Clock Aligned

**Symptom:** After a backfill operation, the database contains rows with `window_start` values like `14:42:26.173` instead of `14:45:00` — every consumer query that filters by `window_start IN (...)` or groups by `EXTRACT(MINUTE FROM window_start)` produces wrong results.

**Root cause:** Backfill iteration computes `next_window_end = current + WINDOW_MS`. If `current` is misaligned (operator manually set it via `UPDATE rollup_watermark SET last_processed_end = NOW() - INTERVAL '2 hours'`), every subsequent window inherits the offset.

**Fix:** On read, snap forward to the next window boundary if misaligned:
```js
if (snappedMarkMs % WINDOW_MS !== 0) {
  const aligned = Math.ceil(snappedMarkMs / WINDOW_MS) * WINDOW_MS;
  console.warn(`[backfill] watermark off-grid; snapping forward to ${new Date(aligned).toISOString()}`);
  snappedMarkMs = aligned;
}
```

Snap FORWARD only, never backward. Snapping backward would re-process already-covered windows, which is idempotent (safe) but pointless work.

See **invariants.md §12** for the formal invariant.

---

## 7. Cleanup of Test-Pollution Rows

**Symptom:** After running a test that intentionally produces malformed rows (misaligned timestamps, dummy data, etc.), production queries return unexpected results.

**Cleanup pattern:** Use the schema convention as the cleanup filter. If window_start should be on a 15-min boundary:
```sql
DELETE FROM token_usage
WHERE source_system = '<test source>'
  AND created_at >= NOW() - INTERVAL '5 minutes'
  AND EXTRACT(MINUTE FROM window_start)::int NOT IN (0, 15, 30, 45)
RETURNING window_start, model_id;
```
Always include a `RETURNING` clause on cleanup DELETEs — it's the only way to verify "I deleted exactly the rows I meant to" in a transactional manner.

---

## 8. SOURCE_STATE_OVERRIDE for Intentionally-Offline Sources

**Symptom:** Watchdog perma-alerts on sources that are configured-but-not-operational (daemon installed but no API key on this machine, source data doesn't exist here, etc.).

**Bad fix:** Lower the source's threshold to absurdly high values (`365 * 86400`) — hides real problems if the source ever DOES come online.

**Bad fix:** Remove the source from `SOURCE_THRESHOLDS_SECONDS` entirely — loses the discoverability of "this source is known but not running."

**Good fix:** Add an explicit `paused` override with an actionable message:
```js
const SOURCE_STATE_OVERRIDE = {
  openai_api: { status: 'paused', message: 'daemon requires OPENAI_ADMIN_KEY env var (not set)' },
  copilot:    { status: 'paused', message: 'daemon getting HTTP 403 from GitHub API — fix PAT scope/expiry/org' },
};
```

The watchdog reader (Phase 1 D2) counts `paused` as ok (does not exit 1), but the `message` field is right there for an operator to read when they want to bring the source online. See **invariants.md §11**.

---

## 9. Windows Scheduled Task Without Admin

**Symptom:** A task XML imported via `schtasks /Create /XML <file>` silently fails — the script reports success but the task doesn't show up in `schtasks /Query`.

**Root cause:** XML imports require admin if the XML contains certain elements (`<RunLevel>HighestAvailable</RunLevel>`, `<UseUnifiedSchedulingEngine>`, etc.). When run non-elevated, schtasks accepts the command but the task creation fails silently.

**Fix:** Use the command-line `schtasks /Create` form instead — works without admin:
```pwsh
schtasks /Create /TN "MyTask" /TR 'wscript.exe "C:\path\to\launcher.vbs"' /SC MINUTE /MO 5 /F
```

`/SC MINUTE /MO 5` means "every 5 minutes." `/F` overwrites without prompting. The created task runs as the current user with InteractiveToken logon type (the default), which is appropriate for most user-mode daemons.
