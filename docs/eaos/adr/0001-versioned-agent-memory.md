# ADR 0001 — Versioned Agent Memory

- **Status**: Proposed (architecture lane only — no production migration, no deploy)
- **Date**: 2026-05-18
- **Issue**: LET-407
- **Parent roadmap lane**: LET-161 (EAOS CEO loop, roadmap item #4 — Versioned Agent Memory with provenance/scope/expiry/diff/rollback)
- **Authors**: EAOS Claude Architect
- **Reviewers required to close**: QA Validator (PASS) + Claude Reviewer (PASS)

## 1. Context

EAOS agents currently have two unsatisfactory memory surfaces:

| Surface | Where | What it does | Why it is not enough |
|---|---|---|---|
| `agent_runtime_state.stateJson` (JSONB) | `packages/db/src/schema/agent_runtime_state.ts` | One row per agent: cost/token counters, last run, opaque adapter state | No history, no diff, no rollback, no provenance, no scope hierarchy. Mutating overwrite is destructive. |
| File-based `MEMORY.md` + per-fact files | `$AGENT_HOME/memory/` and per-skill `para-memory-files` | Per-agent markdown notes the LLM curates between runs | Not in the database. Not queryable across agents or company. No audit trail. Cannot be governed, redacted, or replayed. Invisible to Mission Control. |

`agent_config_revisions` proves the repo accepts the *pattern* of versioned, rollback-able agent state — but it is scoped to **adapter/runtime configuration**, not learned facts.

The roadmap item is to give each agent (and each company) a **first-class, versioned, governed memory store** that:

1. Captures *what an agent learned* (semantic facts, user preferences, project state, references) and *where it learned it from*.
2. Has the same governance properties as our document subsystem (revision history, diff, rollback, lock, audit log).
3. Can be redacted, expired, and scoped so private prompt data and secrets never leak into UI, logs, or replays.
4. Plugs into Mission Control (visible "agent memory" view per agent/company/run) and into workflow replay (memory state at run N is reconstructable).

## 2. Decision

Introduce a **`agent_memory`** entity in the existing Postgres schema, modeled after `documents` + `document_revisions`, scoped by **(company_id, scope, scope_id, key)** with per-write revisions, soft-delete, expiry, and supersession. Reuse `activity_log` for the audit trail and the existing redaction module for secret stripping. Surface it through a typed service in `server/src/services/`, REST routes under `/api/companies/:companyId/memory` and `/api/agents/:agentId/memory`, and Zod-validated MCP tools `paperclipUpsertAgentMemory` / `paperclipListAgentMemory` / `paperclipDiffAgentMemoryRevisions` / `paperclipRollbackAgentMemory`.

### 2.1 Why a new table rather than reusing `documents`

We considered three alternatives:

- **(a) Reuse `documents` + `issue_documents`-style junction.** Rejected: documents are large free-form bodies with markdown editor UX; memory entries are small structured facts queried by key + scope, often retrieved in bulk per agent per run. The two domains have different read patterns, retention policies (memory expires; documents do not), and access-control surfaces.
- **(b) Extend `agent_runtime_state` with a JSONB log.** Rejected: append-only JSONB columns become un-indexable, un-redactable, and break the "diff/rollback per fact" requirement. Cannot scope per-company facts that are *not* tied to a single agent.
- **(c) New `agent_memory` + `agent_memory_revisions` parallel to `documents` + `document_revisions`.** **Chosen.** Same revision/lock pattern the team already knows; per-entry granularity enables expiry and redaction without touching unrelated rows; scope union allows per-agent *and* per-company memory in one table.

### 2.2 Scope hierarchy

Each memory entry has exactly one scope:

```
scope ∈ { "company" | "agent" | "agent_project" }
scope_id  → companies.id  | agents.id  | "<agents.id>:<projects.id>"
```

`agent_project` is the most specific scope. A read for a given (agent, project) returns the union with conflict resolution **most-specific-scope-wins**, with ties broken by `latest_revision_created_at desc`. This is documented in §4.4 of the contract.

### 2.3 Provenance

Every revision carries:

- `source.kind` ∈ `human_message | agent_self | run_observation | imported | system | external_tool | rollback` (the authoritative enum used by ADR, contract, validation, and integration notes; `rollback` is reserved for revisions produced by §2.4 rollback)
- `source.runId` — the heartbeat run that produced this revision (nullable for imports/seeded data)
- `source.commentId` / `source.documentId` / `source.issueId` — first-class FK pointers when the fact came from those entities
- `source.externalRef` — `{ system, id, url? }` for facts pulled from external systems (Linear, GitHub PR, Slack thread)
- `source.confidence` — 0..1 float; agents must set this themselves; default 0.5

This is enough to (i) answer "where did the agent learn this?" in Mission Control and (ii) drive deterministic replay (§4 of integration notes).

### 2.4 Expiry, supersession, diff, rollback

- **Expiry**: `expires_at` (nullable timestamp). Background sweep moves expired entries to `status = "expired"`; reads filter them out by default but they remain queryable for audit. No hard delete except via explicit `forget` API (§4.6 contract).
- **Supersession**: writes set `supersedes_revision_id` pointing at the prior revision they replace. `agent_memory.latest_revision_id` advances. The chain remains intact, so the full history per `(company_id, scope, scope_id, key)` is replayable.
- **Diff**: compute on demand from `agent_memory_revisions.value_json` between two revision ids (or "latest vs N back"). For markdown/text values we expose a unified-diff helper; for JSON we expose RFC 6902 JSON Patch. Diffs are computed server-side so the redaction layer runs before serialization.
- **Rollback**: `POST .../rollback { targetRevisionId }` creates a *new* revision whose `value_json` equals the target's `value_json` and `source.kind = "rollback"`, `source.rollbackFromRevisionId = currentLatest`. Never destructive.

### 2.5 Redaction and secrets boundary

Memory writes go through a new memory-service wrapper `sanitizeMemoryJson` (contract §7.7) that composes `sanitizeRecord` from `server/src/redaction.ts` (reused unchanged) with a second per-string-leaf pass. We add three rules in the memory service:

1. **Two-pass JSON sanitization.** Pass 1 is `sanitizeRecord` (redacts via two branches on object property values at any record depth: branch (a) the key name matches `SECRET_PAYLOAD_KEY_RE`, or branch (b) the string-valued property matches the anchored `JWT_VALUE_RE` — runs recursively via `sanitizeValue → sanitizeRecord`, does not inspect array elements). Pass 2 walks the result and runs `redactSensitiveText` over every remaining string leaf, so content matching one of the seven shapes enumerated in validation contract §2.3 — for example `{ notes: "Authorization: Bearer eyJabc.def.ghi" }` (Authorization-bearer header) or `{ tokens: ["plain", "sk-live-..." ] }` (OpenAI-style key) — is also rewritten before persistence. Coverage is bounded to those seven shapes; a bare opaque `Bearer <token>` without the `Authorization:` prefix and without a JWT-shaped token is a documented gap (see validation contract §2.3). The wrapper returns disjoint dot-path arrays `redactedPaths` (pass-1 hits) and `jsonTextRedactedPaths` (pass-2 hits); the write is rejected with HTTP 422 unless `acknowledgeRedaction: true`. The 422 body is `{ code: "REDACTION_REQUIRED", redactedPaths, jsonTextRedactedPaths, textRedactionApplied }`.
2. Free-text `value_text` is run through `sanitizeTextWithFlag` (wraps `redactSensitiveText`) before persist; the original is **never** written to the database, and the `textRedactionApplied` flag participates in the 422 gate.
3. A separate `private_prompt_data: true` flag may be set on a write to mark the entry as `visibility = "agent_only"`. Such entries are never returned to UI or replay consumers; only the owning agent's runtime can read them. Mission Control shows only a redacted summary (`"<private prompt data — 142 chars>"`).

This boundary is the acceptance gate for "No raw secrets or private prompt data are exposed in docs, tests, UI, or logs."

### 2.6 Audit

Every write/read/delete/rollback emits an `activity_log` row with `entity_type = "agent_memory"`, `entity_id = "<companyId>:<scope>:<scope_id>:<key>"`, `action ∈ { "memory.create", "memory.update", "memory.rollback", "memory.expire", "memory.forget", "memory.read.bulk" }`. Bulk reads coalesce into one row with `details.count` to avoid log flooding.

## 3. Consequences

**Positive**

- Mission Control gains a "Memory" panel per agent / per company with diff + rollback that uses the same UI primitives as document revisions.
- Workflow replay (heartbeat run reconstruction) can pin to `agent_memory_revisions.created_at <= run.startedAt` to reproduce exactly what the agent "knew" at run time.
- Compliance / privacy reviews can answer "what does agent X know about user Y" via a single keyed lookup.
- The MCP surface for agents (`paperclipUpsertAgentMemory`, etc.) is small and Zod-validated; agents stop curating ad-hoc `MEMORY.md` files in untracked locations.

**Negative / cost**

- One new table pair (`agent_memory`, `agent_memory_revisions`) plus the contract-defined index set: three scope-specific partial unique indexes on `agent_memory` (company / agent / agent_project), three secondary lookup indexes on `agent_memory` (`company_updated`, `agent`, `expires`), one trigram GIN index on `agent_memory.latest_value_text` for diff/search, one unique `(memory_id, revision_number)` index plus `memory_created` and `run` secondary indexes on `agent_memory_revisions`. Write amplification = 1 row per write into each table. At expected write rate (<50 writes per agent per day, ~30 agents) this is negligible.
- File-based `MEMORY.md` curated by Claude Code outside Paperclip is *not* migrated; it remains a separate surface owned by the harness, not the kernel. Out of scope for LET-407.

**Neutral**

- The Drizzle migration is **drafted but not applied** in this lane (LET-407 is architecture-only). The implementation issue (LET-407-A, see §6 of the implementation plan) will run `drizzle-kit generate` and apply it locally first.

## 4. Status of "real vs preview/stub"

| Component | Status after LET-407 |
|---|---|
| ADR + contract spec + validation contract + integration notes | **Real** — committed to `docs/eaos/` on branch `enterprise-agent-os/LET-407` |
| Drizzle migration SQL | **Draft only** — inlined in the contract doc, not in `packages/db/src/migrations/` (avoiding the drizzle-kit auto-discovery path) |
| `agent_memory` service in `server/src/services/` | **Not started** — split into implementation issue |
| MCP tools and REST routes | **Not started** — split into implementation issue |
| Mission Control UI panel | **Not started** — split into UI issue |
| Replay integration | **Contract only** — implementation deferred to LET-407-D |

## 5. Open questions for reviewers

1. **Conflict resolution for company-scope writes from two agents in parallel.** Current proposal: optimistic concurrency via `baseRevisionId`, like `upsertIssueDocument`. Reviewers, confirm this is the right default vs. last-writer-wins.
2. **Default TTL.** Proposal: `expires_at = null` (never expires) unless caller specifies. Some teams will want enforced max-TTLs per company; should that be a `company_settings.memory_default_ttl_days`? Open for follow-up issue.
3. **Cross-company visibility.** Proposal: hard prohibition — memory is partitioned by `company_id` and the service rejects cross-company reads at the route layer, mirroring how `documents` is scoped. Reviewers, confirm.

## 6. References

- Existing primitives surveyed: `agent_runtime_state`, `agent_config_revisions`, `documents` + `document_revisions`, `issue_documents`, `activity_log`, `heartbeat_run_events`.
- Redaction module: `server/src/redaction.ts` (functions `sanitizeRecord`, `redactSensitiveText`, constant `REDACTED_EVENT_VALUE`).
- Mission Control gates: `server/src/services/mission-control-gates.ts` (mission-control-completion document keys).
- Industry references consulted (concept-level, no code copied):
  - LangChain Memory abstractions — <https://python.langchain.com/docs/concepts/memory/>
  - MemGPT / Letta versioned-memory pattern — <https://www.letta.com/blog/memgpt>
  - OpenAI Assistants API thread/run memory model — <https://platform.openai.com/docs/assistants/how-it-works>
  - PostgreSQL row-versioning / append-only audit patterns — <https://www.postgresql.org/docs/current/triggers.html>
  - W3C PROV-DM provenance vocabulary — <https://www.w3.org/TR/prov-dm/>
