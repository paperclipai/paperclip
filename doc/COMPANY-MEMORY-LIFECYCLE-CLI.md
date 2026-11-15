# Company Memory Lifecycle CLI (TECH-8191)

Operator reference for the live agent-scoped Mem0 migration. For a non-localhost target, pass `--prod` and set `MEMORY_UPGRADE_ALLOW_PROD=1`. Host locality is not proof that a database is non-production.

Confirmed mutations require `--confirm <company-uuid>`, matching `--company` when both are supplied. Without confirmation, commands that support dry runs produce a read-only preview. Reports support `--output`/`--out` and `--format text|json`.

| Command | Purpose | Writes? | Requires `--confirm` | Dry-run support | Key flags | Refusal conditions |
| --- | --- | --- | --- | --- | --- | --- |
| `census` | Inspect legacy rows, routing, and conversion budget. | No; read-only. | No. | Read-only by definition; no `--dry-run`. | `--database-url`, `--company`, `--control-plane-url`, `--table`, `--long-threshold`, `--prod`. | Missing DSN; invalid target/table; production safety gate. |
| `sweep` | Convert legacy rows, embed them, and record ledger/staging outcomes; live collection is `SELECT`-only. | Yes: ledger, staging, counters; no live rows. Uses the company's OpenAI key. | Yes; IDs must match. | No `--dry-run`. | `--model`, `--openai-key-file`, `--max-rows`, `--max-cost-usd`, rate limits, pause flags, `--operator-label`, `--prod`. | Missing/mismatched IDs or DSNs; lease, routing, budget, converter, or preflight failure. |
| `publish` | Publish converted staging rows to the live collection. | Yes: live insert and staging `published_at` in one transaction. | Yes. | Yes, `--dry-run`. | `--batch-sources`, `--max-rows`, `--page-size`, pause flags, `--prod`. | Malformed staging; source, tenant-fence, schema/vector, state, or lease failure. |
| `flip` | Set the company marker and advance `sweeping` through `flipping` to `draining`. | Yes: marker, state, counters. | Yes, plus `--ack-agent-scope-flag`. | Yes, `--dry-run`. | `--ack-agent-scope-flag`, `--mode copy`, `--probe-limit`, `--prod`. | Outstanding publishable source; state/marker, mode, preflight, lease, or fence failure. Acknowledgment is not proof. |
| `drain` | Establish post-flip quiescence evidence; it does not run a sweep. | Yes when confirmed: probe streak/confirmation evidence. | Yes. | Yes, `--dry-run`; `--once` runs one iteration. | `--max-drain-hours`, `--probe-interval-minutes` (minimum 10), `--probe-limit`, `--blocking-run-limit`, `--once`, `--prod`. | Missing observation, pending work, missing-scope rows, unfinished pre-flip runs, competing lease, or timeout. Timeout leaves `draining`. |
| `verify` | Apply completeness gates and advance `draining` to `verified`. | Yes when gates pass: timestamp/state/counters. | Yes. | Yes, `--dry-run`. | `--allow-quarantined`, `--probe-limit`, `--blocking-run-limit`, `--prod`. | Failed gate, including pending publish, probe blockers, quarantines (unless explicitly allowed), or lease conflict. |
| `rollback` | Clear marker and revert/terminate the upgrade state. | Yes: marker/state/lease; never deletes live rows. | Yes. | Yes, `--dry-run`. | `--table`, `--prod`. | `sweeping`, `needs_recovery`, or `pruning`/`completed`; refused once pruning starts. |
| `recover` | Recover `needs_recovery` to recorded prior state and release the lease. | Yes, atomically: state/error/lease. Never changes marker. | Yes. | Yes, `--dry-run`. | `--control-plane-url`, `--prod`. | State is not `needs_recovery`, deletion admission fails, invalid recovery target, or lease/CAS conflict. |
| `export` | Export converted memories for a single agent from tenant staging to JSONL and manifest files for `rh-memory-mcp` import. | No DB writes; writes external files only with `--confirm`. | Yes (`--confirm <company-uuid>`). | Yes (default is dry run). | `--company`, `--agent`, `--upgrade-id`, `--output-dir`, `--confirm`, `--database-url`, `--control-plane-url`, `--format`, `--table`, `--prod`. | Needs recovery, terminal state aborted, missing staging/ledger tables, unknown agent or non-hermes_local / terminated agent, payload user_id mismatch or malformed payload, missing `--output-dir`, or file path rejection. |
| `filter` | Filter low-value (transient/operational) records from an already-exported JSONL+manifest pair (TECH-8572). | No DB writes; writes filtered external files only with `--confirm`. | Yes (`--confirm <company-uuid>`). | Yes (`--dry-run` or omitting `--confirm`). | `--manifest`, `--jsonl`, `--output-dir`, `--company`, `--agent`, `--upgrade-id`, `--openai-key-file`, `--model`, `--max-cost-usd`, `--concurrency`, `--chat-rpm`, `--chat-tpm`, `--keep-import-keys`, `--dry-run`, `--confirm`, `--prod`. | Checksum/count mismatch, record metadata mismatch, budget exceeded, missing API key on real run, or file path rejection. |

`status` and `prune` are not built. Do not substitute manual SQL or attempt those commands.

## Typical single-company pilot

1. Run `census` and confirm the supported embedding pair (§5.5). Deploy the parser and rebuilt Hermes image before changing agent hardening configuration.
2. Run `sweep`, then `publish`, until no publishable staging remains. Quarantined sources do not block `flip`.
3. Add `PAPERCLIP_MEMORY_HARDENING=agent-scoped-mem0` to each intended agent's `adapterConfig.env`, resending the complete existing environment. Do not enable it server-wide for a narrow pilot.
4. Run `flip ... --confirm <uuid> --ack-agent-scope-flag`. This is a live cutover: do not use `NOLOGIN` or terminate connections.
5. Run `drain` until two clean probes at least 10 minutes apart establish quiescence. Other agents' company-scoped writes commonly prevent confirmation; never run prune on a partially flipped company.
6. Run `verify`; treat quarantines as a recorded policy decision, not a routine `--allow-quarantined` override.
7. If state becomes `needs_recovery`, run `recover` first. Rollback retains agent-scoped rows and is near-final: a later upgrade reconverts and duplicates legacy content (TECH-8326).

## Export subcommand (`pnpm memory:upgrade export`)

The `export` subcommand exports converted memories from `paperclip_memory_upgrade_staging` for a single agent to JSONL format for downstream ingestion into the external `rh-memory-mcp` service (TECH-8573).

### Guarantees and read-only behavior
- Runs strictly read-only against the tenant database inside a `READ ONLY REPEATABLE READ` transaction (`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`).
- Acquires no lease, performs no DDL, bumps no fences, updates no counters, and modifies zero database records on tenant or control plane.
- By default runs as a **dry run** (no files written, report counts only). Passing `--confirm <company-uuid>` (matching `--company`) and `--output-dir <dir>` writes export files.

### Flags
- `--database-url <dsn>` (or `COMPANY_MEMORY_DATABASE_URL` env var): Tenant PostgreSQL connection string.
- `--control-plane-url <dsn>` (or `CONTROL_PLANE_DATABASE_URL` env var): Control plane database connection string.
- `--company <uuid>`: Target company UUID (required).
- `--agent <uuid>`: Target agent UUID (required; must be an active or paused `hermes_local` agent belonging to the company).
- `--upgrade-id <uuid>`: Optional upgrade ID (defaults to the most recent upgrade row for the company).
- `--output-dir <dir>`: Target directory for export files (required with `--confirm`). Must exist, must not reside within the repository, and must not be reached through an in-repo symlink.
- `--confirm <company-uuid>`: Confirms execution and enables writing output files (must strictly match `--company`).
- `--format <text|json>`: Output reporting format (default: `text`).
- `--table <name>`: Live table name for tenant preflight (default: `mem0_memories`).
- `--prod`: Required alongside `MEMORY_UPGRADE_ALLOW_PROD=1` when connecting to non-local databases.
- `--help, -h`: Displays command help.

### Output files
When run with `--confirm`:
- `<output-dir>/export-<agent>.jsonl`: Newline-delimited JSON records (mode `0600`, exclusive create `wx`). Line schema:
  `{"import_key": <uuid>, "company_id", "agent_id", "text", "created_at", "type", "subject", "confidence", "migrated_from", "migration_id", "converter_id", "converter_version"}`.
- `<output-dir>/export-<agent>.manifest.json`: JSON manifest (mode `0600`, exclusive create `wx`):
  `{"format_version": 1, "company_id", "agent_id", "upgrade_id", "converter_id", "converter_version", "record_count", "skipped_counts_by_outcome", "jsonl_sha256", "created_at", "tool": "paperclip memory:upgrade export"}`.

### What export does NOT do
- Does NOT publish memories to the live Mem0 collection table (`mem0_memories`).
- Does NOT flip the company scope marker or advance upgrade lifecycle states (`sweeping`, `completed`, etc. remain unchanged).
- Does NOT prune or delete staging, ledger, or live rows.
- Does NOT modify control-plane records, lease tokens, or counters.
- Does NOT import memories into `rh-memory-mcp` (downstream import is performed separately).

## Filter subcommand (`pnpm memory:upgrade filter`)

The `filter` subcommand removes low-value (transient/operational) records from an already-exported memory JSONL+manifest pair prior to import into `rh-memory-mcp` (TECH-8572).

### Two-stage classification
1. **Deterministic prefilter (Stage 1)**: Evaluates a versioned rule list of 10 rules (`rule_run_identifier_or_uuid`, `rule_run_id_statement`, `rule_api_base_url`, `rule_wake_trigger_reason`, `rule_status_complete_marked_done`, `rule_ticket_marked_done`, `rule_no_assigned_tasks`, `rule_made_no_changes`, `rule_no_new_memories_saved`, `rule_agent_instruction_echo`). Drops matching records with zero model cost.
2. **LLM classifier (Stage 2)**: Classifies remaining records with strict structured output (`gpt-5.4-mini`, temperature 0, pinned prompt SHA-256) into a closed set of reasons:
   - Keep reasons: `durable_fact`, `durable_preference`, `decision`, `lesson`, `procedure`.
   - Drop reasons: `run_status`, `transient_id`, `environment_detail`, `uninformative`.
   - Concurrency: `--concurrency <int>` (default 4, range 1..16). Bounded retries (max 4) on 429/5xx/network errors with 60-second per-request timeout. Terminal 400/401/403/insufficient_quota abort the run promptly.

### Budget and key resolution
- Preflight worst-case projection check: calculated conservatively from serialized request body bytes (body bytes / 3 + 100 max completion tokens). Refuses to start if projected cost exceeds `--max-cost-usd` (default $2).
- In-flight reservation: reserves cost before dispatching each concurrent request and settles upon completion, ensuring concurrent in-flight requests never jointly exceed `--max-cost-usd`.
- Operational cost guidance:
  - **Talent** (~368 records): ~$0.10 USD (well within default $2).
  - **CTO** (~1,100 records): ~$0.31 USD (well within default $2).
  - **Chief** (~15.9k records): ~$4.45 USD. Chief will exceed the default `--max-cost-usd 2`, so operators must pass `--max-cost-usd 5` or higher. At default concurrency 4 (and 500 RPM), Chief takes approximately 1.5–2 hours (or multiple hours at concurrency 2).
- Key resolution: reads from external `--openai-key-file` (0600, outside repository) or `company_secrets` via the control plane when `--company` is provided. Never reads `process.env.OPENAI_API_KEY`.
- `--dry-run` without an API key runs Stage 1 deterministic prefiltering only and reports counts needing classification.

### Output files, COMPLETE marker, and audit report
All output files are written to an exclusive temporary staging directory (mode `0700`) next to the target destination. Upon writing all artifacts and the `COMPLETE` marker, the directory is atomically renamed to `<output-dir>`. If a failure occurs, the temporary directory is cleaned up and no destination directory is created. Operators and downstream ingestion tooling must only consume output directories containing `COMPLETE`.

When run with `--confirm <company-uuid>`:
- `<output-dir>/<jsonl-filename>`: Rewritten JSONL retaining kept records in original input order and key structure (mode `0600`).
- `<output-dir>/<manifest-filename>`: Rewritten manifest conforming strictly to export manifest schema (containing only the 11 export keys, no extra top-level keys) with updated `record_count`, recomputed `jsonl_sha256`, and `skipped_counts_by_outcome.dropped_low_value`.
- `<output-dir>/filter-metadata.json`: Contains the full filter metadata block (`filter_id`, `filter_version`, `prompt_sha256`, `model`, counts, rule breakdowns, timestamps).
- `<output-dir>/filter-audit.txt` & `<output-dir>/filter-audit.json`: Audit reports listing `(import_key, decision, stage, reason)` only — never containing memory text.
- `<output-dir>/COMPLETE`: Written last before directory atomic publication.
- `--keep-import-keys <file>` allows force-keeping specific records to reverse incorrect classifications without re-running the model across all records. Dropped records are not deleted from the old store.
