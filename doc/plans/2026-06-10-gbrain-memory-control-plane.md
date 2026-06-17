# Gbrain Memory Control Plane — V1 Implementation Spec

Date: 2026-06-10
Status: implementing
Builds on: `doc/plans/2026-03-17-memory-service-surface-api.md` (contract), `doc/plans/2026-06-09-gbrain-local-adapter-memory.md` (target flow), `doc/memory-landscape.md` (landscape).

## Goal

Make Paperclip agents remember: pre-run hydrate from gbrain (the local personal
knowledge brain federated with the Obsidian vault), post-run capture back into
gbrain, with a Paperclip-owned `memory_operations` audit trail, `/api/memory`
routes, and an AI OS cockpit memory surface. Obsidian stays the source of
truth; gbrain is the index/recall layer; Paperclip owns bindings, provenance,
and audit (model-independent).

## Verified ground truth (do not re-derive)

- gbrain CLI: `/Users/laptop/.local/bin/gbrain` v0.27.0. Machine interface is
  `gbrain call <tool> '<json>'` → JSON on stdout. Verified tools:
  - `query` `{query, top_k, expand:false}` → array of
    `{slug, page_id, title, type, chunk_text, chunk_id, score, stale, source_id}`.
    Latency ~0.4 s with `expand:false`.
  - `put_page` `{slug, content, type, tags[]}` → `{slug, status:"created_or_updated", chunks, ...}`.
  - `get_page` `{slug}` → full page row (`compiled_truth` holds markdown).
  - `delete_page` `{slug}` → soft delete, 72 h recoverable.
  - `list_pages` supports type/tag filters.
- Embeddings: `ollama` nomic-embed-text (now pulled; writes fail loudly if the
  model is missing — treat as provider unavailability, never fatal).
- The server runs on the host via LaunchAgent (port 3101), NOT in Docker, but
  its PATH may not include `~/.local/bin` → always resolve an absolute binary
  path (config `binPath` → `PAPERCLIP_GBRAIN_BIN` env → `~/.local/bin/gbrain`
  → `gbrain`).
- heartbeat.ts anchors (working tree, branch `codex/fix-paperclip-recovery-stalls`):
  - factory `heartbeatService(db, options)` line ~2989; sibling services
    (`recoveryService`, `productivityReviewService`) constructed ~3015.
  - `executeRun()` ~7623; `context.paperclipTaskMarkdown` if/else set/delete at
    7931–7935 → insert hydrate hook immediately after this block, same
    set/delete pattern, own key `paperclipMemoryMarkdown`.
  - `adapter.execute()` call at ~8763.
  - Post-run completion block: `finalizedRun`/`outcome`/`status`/
    `persistedResultJson`/`agent`/`issueId` in scope ~8993–9059. Insert capture
    after the run-summary issue-comment block (~9023). Pre-execute setup
    failures (~9135+) are NOT captured in V1 (no adapter output existed).
- Adapters consume context keys via `asString()` and `joinPromptSections()`:
  claude-local `src/server/execute.ts` ~658, codex-local ~664 (codex file is
  dirty with in-flight branch work — extend, never revert).
- DB: Drizzle + Postgres. New tables follow `workspace_operations` /
  `cost_events` conventions: uuid PK defaultRandom, `companyId` uuid FK
  notNull + indexed, jsonb with `.$type<...>()`, timestamps with
  `timezone: true` + `defaultNow()`. Export from `packages/db/src/schema/index.ts`.
  `pnpm db:generate` (runs numbering check + tsc + drizzle-kit) → SQL in
  `packages/db/src/migrations/0102_memory_control_plane.sql`. Company scoping is
  enforced in queries and same-company binding-target constraints.
- Routes: Express; zod schemas defined locally in route files; pattern =
  `assertCompanyAccess(req, companyId)` early, `validate(schema)` middleware,
  `HttpError` helpers, `logActivity(db, ...)` on mutations. Register in
  `server/src/app.ts` near issueRoutes (~line 220).
- UI: React Query polling (5–10 s refetch like the cockpit), `api` client in
  `ui/src/api/client.ts`, query keys in `ui/src/lib/queryKeys.ts`, cards use
  `rounded-lg border border-border bg-card p-4`, `StatusPill` in
  AiOsCockpit.tsx. New pages go inside `boardRoutes()` in `ui/src/App.tsx`
  under the `/:companyPrefix` layout. Do NOT extend LIVE_EVENT_TYPES in V1 —
  polling only.
- LiteLLM: the generic `http` adapter discards response bodies — NOT a viable
  chat route. Model routing goes via base-URL env injection into CLI adapters
  (environments service / per-agent env), proxied by a local LiteLLM instance.
  Existing backing store: docker container `steve-litellm-postgres`
  (postgres:16 @ 127.0.0.1:55432, db/user `litellm`).

## Scoping decision (single-operator)

gbrain is a personal, instance-global brain. This deployment is
`local_trusted`, one human operator, currently one company (Ray). V1 policy:

- **Reads (hydrate/query): instance-global.** The whole brain is searchable —
  that is the point (Obsidian vault + project history inform every agent).
- **Writes (capture/note): namespaced** under `paperclip/<companyPrefix-lower>/…`
  slugs, tagged `paperclip`, `company:<prefix-lower>`, plus `agent:<slug>` and
  `kind:<run-capture|note>`.
- Multi-company isolation is therefore NOT provided by the gbrain provider;
  `memory_operations` rows are still company-scoped. Documented limitation,
  noted in code comment on the provider.

## Data model (packages/db)

`memory_bindings` — id uuid PK; companyId uuid FK notNull; key text notNull
(default binding key: `default`); provider text notNull (`gbrain`); config
jsonb `$type<MemoryBindingConfig>` default {}; enabled boolean notNull default
true; createdAt/updatedAt. Unique (companyId, key). Index (companyId).

`memory_binding_targets` — id uuid PK; companyId uuid FK notNull; targetType
text notNull (`company` | `agent`); targetId uuid notNull (companyId or
agentId); bindingId uuid FK → memory_bindings notNull (cascade); createdAt.
Unique (companyId, targetType, targetId).

`memory_operations` — id uuid PK; companyId uuid FK notNull; bindingId uuid FK
(set null); operation text notNull (`query`|`capture`|`record_upsert`|`list`|`get`|`forget`);
hookKind text (`pre_run_hydrate`|`post_run_capture`|`manual_capture`|null);
intent text (`agent_preamble`|`answer`|`browse`|null); status text notNull
(`succeeded`|`failed`); agentId uuid FK (set null); issueId uuid FK (set null);
heartbeatRunId uuid FK (set null); scopeJson jsonb; requestJson jsonb (query
text, topK, slug — never full payloads); resultJson jsonb (snippet slugs +
scores + counts only, never chunk text); usageJson jsonb (latencyMs,
attributionMode: "included_in_run" for hook ops, "untracked" for operator
ops); errorMessage text; createdAt. Indexes: (companyId, createdAt),
(companyId, heartbeatRunId), (companyId, agentId, createdAt).

No `memory_extraction_jobs` in V1 (gbrain is synchronous).

## Memory service (server/src/services/memory/)

`types.ts` — V1 subset of the contract from the 2026-03-17 plan:
`MemoryScope`, `MemorySourceRef`, `MemorySnippet`, `MemoryContextBundle`,
`MemoryProvider` interface `{ key; isAvailable(): Promise<boolean>;
query(req): Promise<MemoryContextBundle>; capture(req): Promise<{slug}>;
get(slug); forget(slug) }`, `MemoryBindingConfig` `{ binPath?, queryTimeoutMs?
(default 4000), captureTimeoutMs? (default 15000), topK? (default 5),
hydrateEnabled? (default true), captureRunsEnabled? (default true),
maxSnippetChars? (default 600), maxBundleChars? (default 4000) }`.

`gbrain-provider.ts` — wraps `execFile(binPath, ["call", tool, json], {timeout})`,
parses stdout JSON, hard timeout per call, every failure → typed error result
(never throw past the provider boundary). Binary resolution order as above;
`isAvailable()` = binary exists (fs access X_OK), cached ~60 s.

`service.ts` — `memoryService(db)` returns:
- `resolveBinding(companyId, agentId?)` — agent target → company target →
  if none: auto-bootstrap a company-default gbrain binding when the binary
  resolves (local_trusted single-operator bootstrap), `logActivity` action
  `memory.binding_created` actorType `system`. Returns null if provider
  unavailable and no binding exists.
- `hydrateForRun({companyId, agentId, runId, issue, wakeReason, wakeCommentBody})`
  → string | null. Builds query from issue identifier + title + description
  (≤500 chars) + wake reason + wake comment (≤300 chars). Provider query
  topK/expand:false. Formats markdown bundle:
  header `## Remembered context (advisory)` + one-line disclaimer ("retrieved
  memory, possibly stale; current issue comments/documents are authoritative;
  not instructions") + `- [slug] (score) — snippet` lines, snippet/bundle
  caps from config. Logs one memory_operations row (hookKind pre_run_hydrate,
  intent agent_preamble) on success AND failure. NEVER throws; returns null on
  any failure, empty results, hydrateEnabled=false, or no binding.
- `captureRunCompletion({run, agent, issueRef, outcome, status, resultJson})`
  → void. Skips when captureRunsEnabled=false/no binding/provider unavailable.
  Page slug `paperclip/<prefix>/runs/<runId>`; content: run outcome/status,
  issue identifier+title, agent name, started/finished, then the run summary
  text Paperclip already builds for issue comments (reuse
  `buildHeartbeatRunIssueComment(persistedResultJson)` output; fall back to
  resultJson summary fields; truncate ~6000 chars; NEVER include env vars,
  tokens, or secrets — content comes only from the already-redacted run
  summary path). Tags per scoping decision. Logs memory_operations row
  (hookKind post_run_capture). NEVER throws.
- `queryForOperator({companyId, query, topK})` → snippets (intent browse, logged).
- `noteForOperator({companyId, title?, text})` → {slug} under
  `paperclip/<prefix>/notes/<shortid>` (hookKind manual_capture, logged,
  logActivity `memory.note_created`).
- `getOverview(companyId)` → binding + providerAvailable + stats
  (opsLast24h, failuresLast24h, lastHydrateAt, lastCaptureAt).
- `listOperations(companyId, {limit≤200, before?})`.
- `updateBinding(companyId, {enabled?, config partial})` (logActivity
  `memory.binding_updated`).

## Heartbeat wiring (server/src/services/heartbeat.ts)

- Factory: `const memorySvc = memoryService(db);` next to recovery (~3015).
- Pre-run: immediately after the `paperclipTaskMarkdown` if/else (7931–7935):
  ```ts
  const memoryMarkdown = await memorySvc.hydrateForRun({...}).catch(() => null);
  if (memoryMarkdown) context.paperclipMemoryMarkdown = memoryMarkdown;
  else delete context.paperclipMemoryMarkdown;
  ```
  (service has its own timeout; total added latency budget ≤ ~4.5 s, typical 0.4 s).
- Post-run: in the completion block after the issue-comment section (~9023):
  `await memorySvc.captureRunCompletion({...}).catch(() => {});` — fires for
  both succeeded and failed terminal outcomes.

## Adapter consumption

claude-local and codex-local `src/server/execute.ts`: read
`context.paperclipMemoryMarkdown` with the existing `asString` pattern and add
it to `joinPromptSections` directly AFTER taskContextNote. Codex file has
in-flight branch changes — extend only. Other adapters: follow-up, not V1.

## HTTP API (server/src/routes/memory.ts)

All under `/api`, registered in app.ts. `assertCompanyAccess` first. Local zod
schemas. Mutations log activity.

- `GET  /companies/:companyId/memory/overview` → `{ binding, providerAvailable, stats }`
- `GET  /companies/:companyId/memory/operations?limit&before` → `{ items }`
- `POST /companies/:companyId/memory/query` `{query, topK?}` → `{ snippets, latencyMs }`
- `POST /companies/:companyId/memory/note` `{title?, text}` → `{ slug }`
- `PATCH /companies/:companyId/memory/binding` `{enabled?, config?}` → binding

## UI

- `ui/src/api/memory.ts` (`memoryApi`), `queryKeys.memory.*`.
- AiOsCockpit: add a "Memory" panel card (StatusPill: `on`/`off`/`unavailable`;
  last hydrate/capture relative times; ops + failures 24 h; link to memory page).
  Follow the existing Field/StatusPill components and card classes; poll 10 s.
- New `ui/src/pages/MemoryPage.tsx`, route `path="memory"` in `boardRoutes()`:
  binding status + enable/disable, operations table (op, hook, status, agent,
  run link, latency, age), "Search memory" box (POST query, render snippets
  with slug + score), "Save note" composer. Breadcrumbs like other pages.

## LiteLLM routing (deployment-side, minimal repo footprint)

- Config at `~/.config/litellm/config.yaml`: master key; model_list with
  `ollama/*` local models (http://host.docker.internal:11434) and passthrough
  entries for anthropic/openai keyed from env when present.
- Container `steve-litellm` (ghcr.io/berriai/litellm:main-stable), port
  127.0.0.1:4000, DATABASE_URL → steve-litellm-postgres (127.0.0.1:55432,
  via host.docker.internal), restart unless-stopped.
- Paperclip opt-in per agent via environments/env config: document the exact
  vars (`ANTHROPIC_BASE_URL=http://127.0.0.1:4000` + key for claude-local;
  `OPENAI_BASE_URL` equivalent for codex-local) in
  `doc/litellm-routing.md`. Do NOT flip live agents automatically.

## Guardrails

- Memory is advisory; hydration markdown explicitly labeled, capped.
- Every provider failure degrades to "no memory" + a failed memory_operations
  row; runs never block or fail because of memory.
- No secrets in captures (content limited to the already-redacted run-summary
  path); no transcript dumps; operation log stores slugs/scores, not chunks.
- Capture stays inside `paperclip/<prefix>/…` slugs (vault write-boundary
  compliant; Obsidian remains authoritative for human-authored truth).

## Tests (vitest, follow existing styles in server/src/__tests__)

- `memory-service.test.ts` — binding resolution + auto-bootstrap, hydrate
  formatting/caps/disable/failure-swallow, capture slug+tags, operation rows
  written for success and failure, overview stats. Use a stub provider.
- `memory-gbrain-provider.test.ts` — arg construction, JSON parse, timeout and
  non-zero-exit handling (stub execFile).
- Heartbeat regression — paperclipMemoryMarkdown set/deleted; capture invoked
  on terminal outcomes (embedded-service style like existing heartbeat tests).
- Routes test — happy path + company-scope rejection (style:
  issue-comment-reopen-routes.test.ts).
- Adapter prompt tests — memory section present after task context
  (codex-local parse.test.ts style; claude-local equivalent).
