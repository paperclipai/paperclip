# Moving a company's agents to per-agent memory (rh-memory-mcp)

**Status (16 Nov 2026):** the full pipeline below was run in production on
2026-11-13..16 for 20 companies. It is an **additive** import into external,
per-agent `rh-memory-mcp`; it is **not** the in-place Mem0 flip/drain/verify path
([lifecycle CLI](./COMPANY-MEMORY-LIFECYCLE-CLI.md)). The old tenant stays as the
fallback. This runbook never publishes, flips, drains, or prunes, and every
production step needs its own explicit approval.

The [operations appendix](./COMPANY-MEMORY-RMM-MIGRATION-OPS.md) holds the importer
guards, transfer gate, and rollback detail. Exact flags below were checked against
`scripts/memory-upgrade-*.ts`, the importer `cli.py`, and
`default-mcp-missing-entry-enrollment.ts`; items we could not check are marked
**(unverified)**.

## A. Company owner quick path

### What changes

| Before | After enrolment |
| --- | --- |
| All agents in the company shared one company-wide memory. | Each agent sees **only its own** memories. |
| Hermes agents used in-process Mem0. | Hermes agents use `rh-memory-mcp` (`runtimeMemory` is turned off). |

> **Warning: enrolment alone does NOT convert old memory.** An enrolled agent starts
> **empty** and no longer sees the old shared company memory. Ask an operator to
> run the conversion (section B, steps 0-4) **before**, or right after, you enrol.
> Conversion covers only Hermes (`hermes_local`) agents. Claude and Codex agents cannot
> be exported, so their share of the old company memory is not carried over.

### Who may run it

A member of that company who is an owner or admin, or holds `tools:manage_connections`,
or an instance admin (no membership needed). Other callers get HTTP 403. Agents created by other agents
may report `owner_required`; an operator can fix that (see B5).

### Steps

1. **Ask an operator to convert the company's old memory first** (B0-B4). Skip only if
   the company has no memory database, or its only agents are archived or terminated
   (paused Hermes agents are still exportable and should be converted).
2. **Dry run** (the default, writes nothing):
   `POST /api/companies/:companyId/default-mcp/missing-entry-enrollment` with
   `{ "keys": ["agent-memory"] }`. Read the per-agent outcomes: `would_add`, or
   `skipped` with a reason.
3. **Real run**, after approval:
   `{ "keys": ["agent-memory"], "dryRun": false, "confirm": "add-missing-default-mcp-entries" }`.
   A batch is at most 25 agents; pass the returned `nextCursor` as `afterId` until it is null.
4. **Verify:** a running agent picks the change up on its next run. Give an agent a
   read-only task such as "what do you remember?". It should answer from recalled notes.
   New agents in an in-scope company are enrolled automatically (confirmed in prod).
5. **Rollback:** ask an operator. There is no unenrol endpoint (see the appendix).
   Imported rows can be rolled back by provenance; the old tenant is untouched.

## B. Operator pipeline

Run per company, then per agent. Approvals are needed before any spend, any
production read of a secret, the import, and the enrolment.

| Step | What | Writes | Needs |
| --- | --- | --- | --- |
| 0 | Census | nothing | tenant + control-plane DSNs (env vars) |
| 1 | Sweep | staging tables only | company OpenAI key, spend |
| 2 | Export (per agent) | local 0600 files | none beyond DB read |
| 3 | Filter + secret scan (per agent) | local 0600 files | OpenAI key, spend |
| 4 | Import (per agent) | `rh-memory-mcp` prod | approved host, guards, SSM reads |
| 5 | Enrol (per company) | agent adapter config | approval, board manager |

Use `pnpm --silent memory:upgrade <subcommand>` (script `memory:upgrade` in
`package.json`). Non-localhost targets need `--prod` plus `MEMORY_UPGRADE_ALLOW_PROD=1`.
Pass DSNs and keys through env vars (`COMPANY_MEMORY_DATABASE_URL`,
`CONTROL_PLANE_DATABASE_URL`) or 0600 files (`--openai-key-file`), never on a command line.

### 0. Census (read-only, no spend)

`census --company <uuid> [--format json] [--output <path>]`. Record: live legacy row
count, per-agent counts, scope (all rows seen were company-scoped, `user_id='company'`),
embedding model and dims (`text-embedding-3-small`, 1536 is supported), projected cost.

### 1. Sweep (staging only, resumable)

`sweep --company <uuid> --confirm <uuid> --openai-key-file <0600 file> --chat-rpm 150 --chat-tpm 100000 --max-cost-usd <n> --operator-label <text> --prod`

- Uses **each company's own OpenAI key**; default model `gpt-5.4-mini`.
- No parallelism flag exists. We ran two company sweeps at a time as separate
  processes. `--chat-rpm 150 --chat-tpm 100000` was conservative (code defaults are
  500 / 200,000); raise only if there are no 429s.
- By default the sweep pauses while any agent run is active (`--pause-when-active-runs`, default 1).
- **Resumable:** the ledger key is (upgrade, source), so a rerun skips finished
  sources (the RED resume skipped 7,017).
- Outcomes per source: `staged`, `dedup`, `noise`, `sensitive`, `quarantined`,
  `unroutable` (row with no agent).
- **Halts** when quarantined > 50, or >= 200 rows considered and quarantined > 2%.
- **Stuck row:** a sweep leaves one `company_memory_upgrades` row in state `sweeping`
  forever. There is **no abort or prune command** (`prune`/`status` are stubs, and
  `rollback` refuses `sweeping`). That row blocks deleting the company
  (`company_memory_upgrade_active`) until a new tool command or a reviewed
  control-plane update sets it to `aborted`.

### 2. Export (per agent, read-only)

`export --company <uuid> --agent <uuid> --upgrade-id <uuid> --output-dir <dir outside any repo> --confirm <uuid>`
(omit `--confirm` for a dry run). Writes `export-<agent>.jsonl` and
`export-<agent>.manifest.json`, mode 0600.

- Only `hermes_local` agents that are not terminated are eligible; others are refused
  with `AGENT_INELIGIBLE` (`claude_local`, `codex_local`, terminated).
- One source row yields 1-6 records, so export counts exceed staged counts
  (DANAA: 103 staged, 224 records).

### 3. Filter and secret scan (per agent)

`filter --manifest <m> --jsonl <j> --output-dir <new dir> --company <uuid> --agent <uuid> --upgrade-id <uuid> --openai-key-file <f> --max-cost-usd <n> --concurrency <n> --confirm <uuid>`

1. Deterministic rules run first, then the pinned-prompt classifier (drop reasons
   `run_status`, `transient_id`, `environment_detail`, `uninformative`). Typical keep
   rate was 30-55%.
2. Output goes **only** to an atomic staging directory that holds a `COMPLETE` marker
   file. An abort loses that agent's whole run. Use only directories containing `COMPLETE`.
3. Known failure: `FILTER_INVALID_CLASSIFICATION` (classifier gave a keep decision with a
   drop reason, or the reverse) aborts the whole run.
4. Practice that worked for big agents:
   - Split the export into chunks of about 350 records. Each chunk needs a valid
     manifest: the same 11 keys, recomputed `record_count` and `jsonl_sha256`, the same
     migration/converter ids. Validate with the importer's `load_manifest`/`load_jsonl`.
   - Filter chunks 2-3 at a time; retry a failed chunk once.
   - If a record is still invalid, **drop** it (reason `classifier_invalid`).
     Never force-keep. Do not use `--keep-import-keys` for uncertain records.
5. **Secret scan** the kept records for secrets, emails, and phone numbers with
   regexes. Use the current `post.py` rules in `rh-data-platform`, not older looser
   lists **(unverified: `post.py` was not located in this review)**. The importer has no exclude
   flag, so build a **new manifest/JSONL pair** without the flagged records.

### 4. Import (approved operator host, not ECS exec)

Guards and command shapes are in the [appendix](./COMPANY-MEMORY-RMM-MIGRATION-OPS.md).
Production values: `--expect-schema rh_memory_mcp_prod --expect-collection memories --expect-db-role rh_memory_app_prod --expect-embed-model text-embedding-3-small --expect-embed-dims 1536 --expect-host-fingerprint <fp>`, plus `RH_MEMORY_IMPORT_ALLOWED=true`.

- The fingerprint covers host:port only, and dev and prod share one Postgres, so
  schema + collection + role are the real guards.
- DB URL: SSM `/rh-platform-prod/rh-memory-mcp/postgres-db-url`, **current version
  only** (older versions hold the admin DSN, TECH-8413). OpenAI key for embeddings:
  `/rh-memory-mcp/prod/openai-api-key`. Every SSM read needs explicit approval that
  states what and why.
- The importer runs idempotent DDL at store init as the service role.
- **One import per agent:** importing two upgrades of the same agent duplicates rows.

Per agent, in order:

1. **Baseline:** migrated rows for the agent must be 0.
2. **Dry run:** existing 0.
3. **Apply** (`--apply`). Speed was about 0.4 s per record, serial.
4. **DB verification:** counts, unique `import_key`, 1536-dim vectors, `created_at` preserved.
5. **`--verify`** (`--verify-probes 5`). Recall probes via the store: fewer than 5/5 is a
   warning only (for example crowding by shared 3-word prefixes).
6. **Isolation check:** compare per-agent **migrated** counts. Do **not** compare total
   counts: live organic writes legitimately change them (a new auto-enrolled agent wrote
   organic rows mid-run and caused a false halt).
7. Keep the rollback journal (`import-<agent>-<migration_id>.ids.jsonl`, 0600).

Direct writes bypass the REST rate limiter and use OpenAI embedding quota and a DB session.

### 5. Enrol per company (after import, with explicit approval)

Dry run first, then the real run (calls in section A, steps 2-3).

| Outcome | Meaning |
| --- | --- |
| `would_add` / `added` | Agent will get / got the `agent-memory` entry. |
| `skipped: agent_terminated` | Terminated agent. |
| `skipped: nothing_missing` | Already enrolled, or the server backfill flag is off (below). |
| `skipped: owner_required` | No responsible user in the audit log (agent created by an agent). |
| `failed: enrollment_error` | Per-agent error; inspect server logs, then re-run (idempotent). |
| top-level `blocked` | `feature_flag_off` or `enrollment_in_progress`: nothing scanned, no outcomes, null `nextCursor`. |
| other skips | `company_archived`, `company_out_of_scope`, `no_default_mcp_state` (legacy enrolment first), `corrupted_existing_state`, `legacy_access_conflict`, `lost_race`. |

- The server must have `PAPERCLIP_AGENT_MEMORY_BACKFILL_ENABLED=true` and a valid memory
  config; otherwise every agent reports `nothing_missing`.
- `owner_required`: once PR #414 (merge `773eed4a`) is deployed, an operator can add
  `responsibleUserId` to the body. It fills only agents with no audit-log owner, the
  user must be an active verified member, and it is audited per agent.
- HTTP 403 means the caller has no access to the company, or is not a manager (owner,
  admin, `tools:manage_connections`, or instance admin; the code checks both).
- **What an agent receives:** Hermes gets env `MEM0_API_KEY` (secret ref), `MEM0_HOST`,
  `MEM0_USER_ID`, `MEM0_PROXY`, plus `memoryProvider: mem0` and `runtimeMemory: false`.
  Claude and Codex get `RH_MEMORY_TOKEN`, `RH_MEMORY_URL`, `RH_MEMORY_PROXY` and are wired
  through hooks (recall at `UserPromptSubmit`), **not** as an MCP tool connector.
  End-of-turn capture is **off** for them by default (fork #401, TECH-8644) unless the
  server sets `PAPERCLIP_AGENT_MEMORY_CAPTURE=on` or the agent sets `RH_MEMORY_CAPTURE`.

## Explicit memory tools for Claude and Codex agents (TECH-8832)

Enrolling a Claude or Codex agent wires the recall hook and sets its memory environment. The end-of-turn capture hook is registered in the image for every Claude and Codex run, and it captures unless `RH_MEMORY_CAPTURE` holds an off value; new enrolments get an explicit `off` unless the server sets `PAPERCLIP_AGENT_MEMORY_CAPTURE=on`, while a legacy agent with no value set captures. Either way the agent has no way to search, save or delete memory on its own. The optional `agent-memory-tools` entry (added by the memory tools PR in this series, so these steps apply once it is deployed) adds that: `memory_search`, `memory_add` and `memory_delete`, through the agent's own gateway connection to the memory service, using the same `agent-memory-<agentId>` token (no second secret, one rotation).

- **Server flags:** `PAPERCLIP_AGENT_MEMORY_TOOLS_ENABLED=true` on top of the memory flags above. New Claude and Codex agents then get it at creation; Hermes agents never do.
- **Existing agents:** run the missing-entry enrolment with `"keys": ["agent-memory-tools"]` (dry run first). It needs the backfill flag and an `agent-memory` entry already present on the agent.
- **What the agent is told:** the injected guidance names the three tools and says what to save (lasting decisions, preferences, corrections; never status, ids or URLs). It says the end of each turn is captured automatically only when the agent's `RH_MEMORY_CAPTURE` is not an off value; with the tools on, leave capture off so a fact is not written twice.
- **Without the entry:** the guidance says recall is automatic and that the agent has no tool to search or save memory in the run.

## Access and operations lessons

- Tenant and control-plane DBs are private RDS. Operators reach them with an
  `aws ssm start-session` port-forward (`AWS-StartPortForwardingSessionToRemoteHost`)
  through the running prod Paperclip ECS task to the RDS host on port 5432. The tunnel
  dies whenever that task is replaced (the task failed health checks and was replaced
  5 times on 2026-11-16, TECH-8776, cause unknown). Run a supervisor that reopens it and
  wrap long commands in retry loops.
- A tool worker idle for more than 10 minutes with no log output is hung on a dead
  connection. Kill it, wait for the 10-minute lease (`LEASE_FENCED_OUT`), then retry.
  `EMBEDDING_FAILED` can really be a dead DB connection.
- **Never put a DSN or key on a command line.** A pnpm echo leaked a DB password into
  an agent transcript on 2026-11-16. Use env vars or 0600 files, `pnpm --silent` (or run
  node directly), and keep output filters on for `postgres(ql)://`, including
  backslash-escaped forms.
- Read only CURRENT SSM versions. Do not run prod Terraform or service restarts during
  an import window; announce on the agent board first (another agent's prod apply during
  an import caused a harmless stop).
- **Cleanup after sign-off:** delete exports, filtered files, samples, and journals
  (they hold memory text). The old tenant's staging keeps the converted records. Handle
  stuck `sweeping` rows (step 1).
- **Quality caveat:** kept sets still contain some stale point-in-time status facts;
  consolidation is tracked in TECH-8751..8756.
- Companies with no memory database, or whose agents are all archived or terminated,
  have nothing to convert; enrol their live agents directly. Paused Hermes agents are
  still exportable (only non-`hermes_local` and terminated agents are refused).

## Timings and costs from the first full run

| Item | Observed |
| --- | --- |
| Sweep cost | about $0.000164 per row |
| Sweep speed | about 18-24 sources/min per run |
| DAN | 7,822 rows, $1.28, about 6.5 h |
| RED | 7,061 sources |
| All 20 companies | about $3.3, about 9 h wall (2 sweeps in parallel) |
| Import speed | about 0.4 s per record, serial (15,658 records in about 102 min observed; 0.4 s is rounded) |
| Filter keep rate | typically 30-55% |

## Not done by this runbook

No publish, flip, drain, prune, backend switch, or unenrol. Enrolment, rollback of the
backend, and any change to the old tenant each need their own approval.
