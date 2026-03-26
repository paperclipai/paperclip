---
name: debug-paperclip
description: Query and diagnose Paperclip heartbeat run errors, agent failures, and log files. Use when the user asks about failed runs, agent errors, heartbeat logs, run diagnostics, error history, why an agent failed, stderr output, or checking run status. Covers the heartbeat_runs, heartbeat_run_events, and activity_log tables plus local ndjson log files.
allowed-tools: Bash, Read, Grep, Glob
---

# debug-paperclip

Read-only diagnostic skill for investigating Paperclip agent heartbeat runs, failures, and logs.

## Quick Reference

### Database connection

```bash
PGPASSWORD=paperclip psql -h 127.0.0.1 -p 54329 -U paperclip -d paperclip -c "QUERY" 2>&1 | cat
```

Always pipe through `| cat` to avoid pager issues.

## Key Tables

### `heartbeat_runs` — one row per agent invocation

| Column | Type | Notes |
|---|---|---|
| `id` | uuid | Primary key (also the run ID) |
| `agent_id` | uuid | FK -> `agents.id` |
| `company_id` | uuid | FK -> `companies.id` |
| `status` | text | `queued`, `running`, `succeeded`, `failed`, `cancelled` |
| `invocation_source` | text | `on_demand`, etc. |
| `error` | text | Human-readable error message |
| `error_code` | text | Machine-readable code (e.g. `adapter_failed`) |
| `exit_code` | integer | Process exit code |
| `signal` | text | Kill signal if applicable |
| `stdout_excerpt` | text | Truncated stdout capture |
| `stderr_excerpt` | text | Truncated stderr capture |
| `started_at` | timestamptz | When the run started |
| `finished_at` | timestamptz | When the run ended |
| `process_pid` | integer | OS process ID |
| `log_store` | text | Always `local_file` |
| `log_ref` | text | Path: `{companyId}/{agentId}/{runId}.ndjson` |
| `log_bytes` | bigint | Size of log file |
| `log_compressed` | boolean | Whether log is gzipped |
| `usage_json` | jsonb | Token usage / cost metadata |
| `result_json` | jsonb | Structured result from the run |
| `context_snapshot` | jsonb | Snapshot of agent context at run start |
| `retry_of_run_id` | uuid | If this run is a retry, points to original |
| `process_loss_retry_count` | integer | How many times process was lost and retried |

### `heartbeat_run_events` — granular event stream per run

| Column | Type | Notes |
|---|---|---|
| `run_id` | uuid | FK -> `heartbeat_runs.id` |
| `agent_id` | uuid | FK -> `agents.id` |
| `seq` | integer | Ordering within a run |
| `event_type` | text | `lifecycle`, `error`, `structured`, `adapter.invoke` |
| `level` | text | `info`, `error`, etc. |
| `message` | text | Event description |
| `payload` | jsonb | Structured event data |

### `activity_log` — high-level audit trail

| Column | Type | Notes |
|---|---|---|
| `run_id` | uuid | FK -> `heartbeat_runs.id` (nullable) |
| `agent_id` | uuid | FK -> `agents.id` |
| `action` | text | What happened |
| `entity_type` | text | What was affected |
| `entity_id` | text | ID of affected entity |
| `details` | jsonb | Extra context |

## Log Files (Filesystem)

Runs store full ndjson logs on the Paperclip server filesystem. The path is:

```text
$PAPERCLIP_LOG_DIR/{companyId}/{agentId}/{runId}.ndjson
```

The `log_ref` column in `heartbeat_runs` contains the relative path. To read:

```bash
# Find the log directory (usually on the Paperclip server host)
find ~/Projects/paperclip -name "*.ndjson" -path "*/logs/*" -type f 2>/dev/null | head -3

# If found, read a specific run's log
cat "$PAPERCLIP_LOG_DIR/$LOG_REF" | head -50
```

If the log files are not on the local machine, fall back to `stdout_excerpt`, `stderr_excerpt`, and `heartbeat_run_events` for diagnostics.

## Instructions

When a user asks about errors, failures, or diagnostics:

### 1. Identify the scope

Ask (or infer) what they want:

- A specific agent's failures?
- A specific run ID?
- Recent failures across all agents?
- A time window?

### 2. Query the database

**Recent failures (all agents):**

```sql
SELECT a.name, hr.status, hr.error_code, LEFT(hr.error, 120) AS error,
       hr.exit_code, hr.finished_at
FROM heartbeat_runs hr
JOIN agents a ON hr.agent_id = a.id
WHERE hr.status = 'failed'
ORDER BY hr.finished_at DESC LIMIT 10;
```

**Failure breakdown by agent:**

```sql
SELECT a.name, count(*) AS failures,
       max(hr.finished_at) AS last_failure
FROM heartbeat_runs hr
JOIN agents a ON hr.agent_id = a.id
WHERE hr.status = 'failed'
GROUP BY a.name ORDER BY failures DESC;
```

**Failure rate per agent (last 7 days):**

```sql
SELECT a.name,
       count(*) FILTER (WHERE hr.status = 'succeeded') AS ok,
       count(*) FILTER (WHERE hr.status = 'failed') AS fail,
       round(100.0 * count(*) FILTER (WHERE hr.status = 'failed') / count(*), 1) AS fail_pct
FROM heartbeat_runs hr
JOIN agents a ON hr.agent_id = a.id
WHERE hr.started_at > now() - interval '7 days'
GROUP BY a.name ORDER BY fail_pct DESC;
```

**Specific run details:**

```sql
SELECT hr.*, a.name AS agent_name
FROM heartbeat_runs hr
JOIN agents a ON hr.agent_id = a.id
WHERE hr.id = '<run-id>';
```

**Events for a run (ordered):**

```sql
SELECT seq, event_type, level, message, payload
FROM heartbeat_run_events
WHERE run_id = '<run-id>'
ORDER BY seq;
```

**Error events only:**

```sql
SELECT a.name, hre.message, hre.payload, hre.created_at
FROM heartbeat_run_events hre
JOIN agents a ON hre.agent_id = a.id
WHERE hre.level = 'error'
ORDER BY hre.created_at DESC LIMIT 20;
```

**Stdout/stderr for a run:**

```sql
SELECT stdout_excerpt, stderr_excerpt
FROM heartbeat_runs WHERE id = '<run-id>';
```

**Activity log for a run:**

```sql
SELECT action, entity_type, entity_id, details
FROM activity_log WHERE run_id = '<run-id>'
ORDER BY created_at;
```

### 3. Check log files (if available)

```bash
# Check if log files exist locally
LOG_REF=$(PGPASSWORD=paperclip psql -h 127.0.0.1 -p 54329 -U paperclip -d paperclip -tA \
  -c "SELECT log_ref FROM heartbeat_runs WHERE id = '<run-id>'")
find ~/Projects/paperclip -name "$(basename "$LOG_REF")" -type f 2>/dev/null
```

### 4. Summarize findings

Present results as a clear summary:

- Which agents failed and why
- Error patterns (repeated `error_code`s, common `exit_code`s)
- Suggested next steps (retry, config fix, escalate)

## Common Error Codes

| error_code | Meaning |
|---|---|
| `adapter_failed` | The adapter process exited non-zero |
| `timeout` | Run exceeded time limit |
| `process_lost` | Process disappeared unexpectedly |
| `cancelled` | Run was manually cancelled |

## Best Practices

- Always join `heartbeat_runs` with `agents` to get human-readable names
- Use `| cat` on all psql commands to avoid pager
- Check `stdout_excerpt` / `stderr_excerpt` before hunting for log files
- Use `heartbeat_run_events` for the most granular error detail
- Filter by time window to keep queries fast on large tables
