# Versioned Agent Memory — Integration Notes

- **Issue**: LET-407
- **Consumers covered**: Mission Control / Command Center, workflow replay, autonomous loop / heartbeat runtime, MCP tool surface, compliance / privacy review.
- **Companion**: [ADR](../adr/0001-versioned-agent-memory.md), [Contract](versioned-agent-memory-contract.md), [Validation Contract](versioned-agent-memory-validation-contract.md).

## 1. Mission Control / Command Center

Mission Control already renders document revisions for completion gates (see `server/src/services/mission-control-gates.ts`). Memory plugs in alongside, not inside, those gates.

### 1.1 New panel

A "Memory" tab on each of:

- **Agent detail page** — list of `scope ∈ {agent, agent_project}` entries for that agent, grouped by scope.
- **Company detail page** — list of `scope = company` entries.
- **Run detail page** — entries *read or written* during that run, with a per-entry "show diff vs prior" affordance.

Panel UI reuses the existing document-revision component pattern from the `ui/` React app (the repo's frontend lives under `ui/`, not `frontend/`). New components live under `ui/src/features/agent-memory/` (this folder will be created by LET-407-C — the implementation plan owns the directory bootstrap). Kept off the LET-407 lane to avoid file overlap with LET-326/LET-337 dashboard work — call this out in the LET-407-C UI issue.

### 1.2 Read API used

| Surface | Endpoint | Notes |
|---|---|---|
| Agent panel | `GET /api/agents/:agentId/memory` | Includes `resolvedFromScope`; sorts by `updatedAt desc`. |
| Company panel | `GET /api/companies/:companyId/memory?scope=company` | — |
| Run panel | `GET /api/runs/:runId/memory-touches` *(new lightweight join endpoint)* | Joins `activity_log` actions `memory.*` filtered by `runId`, plus the resolved entry. |
| Diff modal | `GET /api/companies/:companyId/memory/:memoryId/diff?from=&to=` | rendered via existing markdown diff component |
| Rollback button | `POST /api/companies/:companyId/memory/:memoryId/rollback` | requires `memory.rollback` capability; UI hides for callers without it |

### 1.3 Privacy posture in the UI

- `private_prompt_data:true` rows show only the placeholder string and a 🔒 icon. No body, no diff, no rollback target preview.
- `visibility=agent_only` rows are excluded from the panel entirely for non-owner agents and for all human users (only the owning agent's own runtime can see them via MCP tools).
- Screenshots for the implementation PR must use synthetic seed data only (see Validation Contract §3.4).

### 1.4 No new completion gate

Memory is **not** a Mission Control completion gate. It is read-only context surfaced for transparency. Do not block issue transitions on memory state in this lane. A future issue may add policies like "company-scope memory write requires CEO approval"; out of scope for LET-407.

## 2. Workflow replay

### 2.1 Definition

For any heartbeat run `R`, "replay-coherent memory" = the set of memory entries whose `agent_memory_revisions.created_at <= R.started_at`, with the latest such revision per `memoryId` materialized, filtered through visibility for the replay viewer's identity.

### 2.2 API

```
GET /api/runs/:runId/memory?asOf=<auto>
```

Defaults `asOf = run.started_at`. Returns the same shape as `GET /api/companies/:companyId/memory` but pinned in time, so replay UIs reproduce exactly what the agent could have known when the run executed.

Implementation: a SQL view or recursive CTE that, for each `(scope, scopeAgentId, scopeProjectId, key)` tuple visible to the requested company, picks `MAX(revision_number) WHERE created_at <= :asOf`. Same filter applied to `status='active'` at that asOf timestamp using the `expires_at` column.

### 2.3 Replay must not leak post-run state

The replay endpoint enforces:

- `expires_at` is evaluated at `asOf`, not `now`. (An entry expired *after* the run still shows up in the run's replay.)
- `forgotten` entries that were **soft-forgotten** (`hardDelete=false`) *after* the run still appear in the replay, but their value is null and a `forgottenLater:true` flag is set. (Compliance want: replay still shows "the agent saw something here" even after the user invoked right-to-be-forgotten — we surface the existence, not the content.)
- `forgotten` entries that were **hard-forgotten** (`hardDelete=true`) are deleted from `agent_memory` and `agent_memory_revisions` entirely, per contract §4.6. Replay therefore CANNOT and MUST NOT emit a tombstone or `forgottenLater:true` marker for them — there is no row to attach the marker to and synthesizing one would defeat the right-to-be-forgotten guarantee. The act of hard forgetting is preserved in `activity_log` (action `memory.forget`, `details.hardDelete=true`) and is queried separately via `/api/runs/:runId/audit`. Replay clients that need to know "did anything get hard-forgotten between this run and now?" must consult the audit timeline, not the memory replay surface.
- `private_prompt_data:true` entries follow the same UI rules as live mode: placeholder only.

### 2.4 Heartbeat run event linkage

When the implementation issue lands, add to `heartbeat_run_events`:

- `eventType = "memory_read"` payload `{ count, scopeFilter }` for bulk reads
- `eventType = "memory_write"` payload `{ memoryId, revisionNumber }` for writes

Then replay can correlate "the agent wrote X at event seq N" with the actual stored revision.

### 2.5 Cross-link with `activity_log`

`activity_log.runId` already exists. The memory service writes that field on every `memory.*` action. Replay consumers can pivot on `activity_log` for a full audit timeline without joining `agent_memory_revisions` first.

## 3. Autonomous loop / heartbeat runtime

### 3.1 Memory injection into prompts

The runtime (`server/src/runtime/heartbeat.ts` or equivalent — confirm location in implementation issue) should:

1. Before invoking the LLM, call `agentMemoryService.list({ companyId, scope: resolved, scopeAgentId: self, scopeProjectId: current, includeExpired: false })` with `visibility != agent_only` excluded for non-owner — but in this case **caller is the owning agent**, so `agent_only` entries are included.
2. Render the result as a compact "Memory" section in the system prompt under a token budget (default 4000 tokens; configurable per agent).
3. If the budget is exceeded, prefer most-recently-updated entries; truncate the rest with a `…N more entries omitted…` marker.
4. Record the list of `memoryId:revisionId` pairs actually injected as an entry in the run's prompt-cache key so replay can verify exact inputs.

### 3.2 Writes from the LLM

When the LLM calls `paperclipUpsertAgentMemory`, the runtime:

1. Passes `source.runId = current run id` and `source.kind = "agent_self"` automatically (caller can override `kind` only with allowed values).
2. Defaults `scope` to `agent` and `scopeAgentId` to the calling agent.
3. Refuses writes with `scope=company` unless the agent has `memory.write_company`.

### 3.3 No retroactive rewrite

The runtime must never modify a memory entry's *historical* revisions. All changes go through `upsert` (new revision) or `rollback` (new revision pointing back). This invariant is what makes the replay layer trustworthy.

## 4. MCP surface (external agents)

For external Claude Code instances connecting via the `paperclip` MCP server:

- The six tools enumerated in the contract spec §5 are the only public surface.
- Tools enforce the same capability checks as the REST routes (one code path; routes call into the service, MCP tools call into the routes via internal HTTP client or directly into the service — implementation issue picks one and applies it everywhere).
- An MCP tool result for a redaction failure carries `{ ok: false, code: "REDACTION_REQUIRED", redactedPaths, jsonTextRedactedPaths, textRedactionApplied }` so the calling LLM gets a structured signal, not a thrown exception. The two redaction-path arrays are kept separate (contract §4.1 step 5 / §7.7) so an agent that sent `{ tokens: ["plain", "sk-..."] }` or `{ notes: "Authorization: Bearer eyJabc.def.ghi" }` can see that the offending content was a pass-2 `redactSensitiveText` rewrite (rather than a pass-1 `sanitizeRecord` key-name or JWT value-shape hit) and adjust the payload accordingly. Bare opaque `Bearer <token>` strings without the `Authorization:` prefix and without a JWT-shaped token are a documented gap (validation contract §2.3); LLM callers that want such a value scrubbed must either place it under a key that matches the pass-1 KEY-NAME category list (`authorization`, `bearer`, `token`, etc.) or strip the secret before write.

## 5. Compliance / privacy

### 5.1 Right to forget

`POST /memory/:id/forget { hardDelete: true, reason }` satisfies user requests to remove their data from agent memory. Audit log retains the *act* of forgetting (action, reason, who, when) but not the data itself.

### 5.2 Export

A future endpoint `GET /api/companies/:companyId/memory/export` (out of scope for LET-407, called out in implementation plan as LET-407-E follow-up) will produce a per-subject export (all entries whose `valueText`/`valueJson` references a given subject identifier). For LET-407 we only ensure the data model supports this — the `value_text gin_trgm_ops` index supports text search, and `value_json` is jsonb-indexable.

### 5.3 Data residency

Memory rows live in the same Postgres as everything else; no separate datastore. Residency requirements that apply to `documents` apply equally and need no new infra.

## 6. Backward compatibility

| Surface | Impact |
|---|---|
| `agent_runtime_state.stateJson` | Unchanged. Continues to hold adapter session/cost data. Memory is a new, parallel concept. |
| File-based `MEMORY.md` in `$AGENT_HOME` | Unchanged. Out of scope. Claude Code harness continues to own that surface. A future bridge can sync the harness's MEMORY.md into `agent_memory` with `source.kind="imported"` — explicitly not in this lane. |
| `documents` / `issue_documents` | Untouched. Memory shares the revision *pattern* but not the storage. |
| `activity_log` | New `action` values added (`memory.*`). Schema unchanged. Existing log consumers that filter by `entity_type` will simply not see memory rows unless they opt in. |
| Existing MCP tools | None renamed or removed. New tools added. |
| Existing REST routes | None changed. New routes added. |
| Migrations | One new additive migration (0090). No backfill of historical data. |

## 7. Risk register

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | Agents flood `agent_memory` with noisy writes, blowing up table size | Med | Med | Implementation issue must add a per-agent write-rate counter (e.g., `agent_memory_writes_per_day` derived from activity_log) and a UI surface so we see runaway agents. Default expiry policy and a config-level `memory_default_ttl_days` proposed for follow-up. |
| R2 | Redaction false negatives — a novel secret pattern slips through | Med | High | The acceptance gate in Validation Contract §3.4 forces an explicit list of patterns. Implementation must reuse the redaction module unchanged; any new pattern must be added to the central regex, not the memory service. |
| R3 | Replay diverges from real prompt history due to caching | Low | High | Runtime injection (§3.1) records `memoryId:revisionId` pairs in the prompt-cache key. Replay verifies these match before returning a coherent set. |
| R4 | Cross-company leak via misconfigured route | Low | Critical | Every route enforces `companyId` from path matches the row's `company_id` and the caller's company. Mirrors documents.ts guard. Tested in §3.5 of validation contract. |
| R5 | `private_prompt_data:true` leaks via diff endpoint | Low | High | Diff endpoint runs redaction pass on output (defense-in-depth) AND refuses to return body for `private_prompt_data:true` entries to anyone except the owning agent. |
| R6 | Hard-delete misuse | Low | High | `memory.forget.hard` capability is human-admin-only; agents cannot self-grant. Audit log retains the act. |
| R7 | Drift between contract and implementation | Med | Med | Implementation issues link back to this contract; reviewer rejects PRs whose schema or behavior diverges without an ADR amendment. |

## 8. Rollout plan

Phase ordering (each phase is one or more follow-up issues — see implementation plan):

1. **Phase 0 (this lane, LET-407)**: contract + validation contract + integration notes committed. No code, no migration applied. *Done when QA Validator + Claude Reviewer PASS.*
2. **Phase 1 (LET-407-A)**: schema + service + REST routes + unit/service tests. Migration generated via drizzle-kit and applied **locally only**. Live-flag protected: feature is reachable but `MEMORY_API_ENABLED` env defaults `false` in production config. *Done when CI is green and code review PASS.*
3. **Phase 2 (LET-407-B)**: MCP tools + capability registration. *Done when MCP smoke tests pass and at least one EAOS agent has invoked the tool against a local instance.*
4. **Phase 3 (LET-407-C)**: Mission Control UI panel + screenshots with synthetic data. *Done when screenshots reviewed.*
5. **Phase 4 (LET-407-D)**: replay endpoint + heartbeat run event types + golden fixtures. *Done when replay fixtures pass byte-equal.*
6. **Phase 5 (LET-407-E)**: compliance export endpoint. Separate lane; not required to flip `MEMORY_API_ENABLED`.
7. **Production enablement gate**: separate CEO-approved deploy issue. Requires Andrii approval per `LET-161` policy because flipping the production live flag = "live release". Not in any of the Phase 1–5 issues; called out explicitly so no implementation issue accidentally enables it.

## 9. Rollback (the migration itself)

If 0090 is applied to production by mistake (it should not be in this lane), rollback is:

```sql
DROP TABLE IF EXISTS "agent_memory_revisions";
DROP TABLE IF EXISTS "agent_memory";
```

Safe because no other table FKs into them. Down-migration file path reserved as `0090_agent_memory.down.sql` for the implementation issue.

## 10. Out of scope for LET-407

Explicitly **not** part of this lane (and not required for QA Validator / Claude Reviewer PASS):

- Any code under `server/`, `ui/`, `packages/mcp-server/`, `packages/db/src/schema/`, or `packages/db/src/migrations/` (the actual repo locations; earlier drafts incorrectly referenced `frontend/` and `apps/`).
- File-based `MEMORY.md` migration or bridge.
- Vector / embedding memory (a separate roadmap item if ever).
- Cross-company memory federation.
- Live external integrations (Linear/Slack/etc. importers).
- Production flag flip / deploy / restart.
