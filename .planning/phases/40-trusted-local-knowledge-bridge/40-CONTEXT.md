# Phase 40: Trusted Local Knowledge Bridge - Context

**Gathered:** 2026-04-29
**Status:** Ready for planning
**Mode:** auto

<domain>
## Phase Boundary

Phase 40 makes the existing Obsidian/local vault Knowledge Bridge operational through a trusted local daemon or bridge pairing model. It covers company-scoped trust handshake evidence, vault sync queue and health state, last applied/conflict/blocked reason visibility in API and UI, and deterministic tests for unavailable, stale, and conflict scenarios.

This phase does not make the local vault the source of truth, does not add broad native/mobile capture, does not implement app-store distribution, and does not bypass the existing approved import/export provenance and graph/wiki projection contracts.

</domain>

<decisions>
## Implementation Decisions

### Trust Boundary And Pairing
- **D-01:** Add a trusted local bridge pairing model on top of the existing Knowledge Bridge, not a separate knowledge subsystem. Pairing should produce a company-scoped bridge identity with token/handshake evidence, status, actor/audit metadata, and last seen timestamp.
- **D-02:** Pairing tokens must be short-lived or single-use, stored as hashed/verifiable evidence rather than plaintext secrets, and bound to `companyId`. Routes must continue to use `assertCompanyAccess` and must not let a bridge paired for one company read or write another company vault.
- **D-03:** Treat the local daemon as an external worker that reports state and applies approved sync operations. The web server should not directly write arbitrary desktop paths; the daemon/bridge performs local filesystem work after trust is established.

### Sync Queue And Health Evidence
- **D-04:** Introduce a company-scoped vault sync queue/status model that records pending export/import jobs, last applied timestamp, conflict count, blocked reason, bridge availability, stale threshold status, and recent operation result.
- **D-05:** Reuse the existing vault writer dry-run and import preview/apply contracts as queue job inputs/outputs. Queue items should reference page keys, vault paths, candidate IDs, and provenance evidence instead of storing opaque unstructured blobs only.
- **D-06:** Bridge health should be visible as evidence, not just a boolean: `available`, `unavailable`, `stale`, `blocked`, and `conflict` states should include reason codes, timestamps, queue counts, and the bridge identity that reported them.

### Knowledge Contract Preservation
- **D-07:** RT2 DB, wiki pages, graph nodes/edges, projector state, and audit/activity records remain canonical. Local markdown remains an inspection/edit surface whose write-back enters RT2 only through approved import candidates or explicit conflict decisions.
- **D-08:** Import/export apply must preserve existing frontmatter provenance fields such as `rt2_page_key`, `rt2_page_type`, `rt2_company_id`, `rt2_updated_at`, and `rt2_source_event_ids`.
- **D-09:** Vault-originated graph relationships must remain `AMBIGUOUS` until operator validation. Phase 40 must not regress Phase 26/Phase 21 confidence semantics by treating Obsidian wikilinks as `EXTRACTED`.

### Operator Surface
- **D-10:** Extend the existing `KnowledgePage` Bridge tab rather than adding a separate dashboard. Operators should see pairing status, bridge identity, last seen, queue counts, last applied, conflict count, blocked reason, and recent audit evidence near existing vault writer/import controls.
- **D-11:** UI should stay dense and evidence-forward: compact status badges, queue rows, timestamps, reason codes, and action buttons for dry-run, enqueue/apply, retry, and conflict review. Avoid marketing-style explanation panels.
- **D-12:** Shared contracts for bridge pairing, sync queue, health, and operation results should live in `packages/shared/src/types/rt2-knowledge.ts` and `packages/shared/src/validators/rt2-knowledge.ts`, consumed by both server routes and UI API client.

### Verification
- **D-13:** Add deterministic route/service tests for successful pairing, rejected cross-company bridge access, unavailable bridge, stale last-seen, blocked reason, queued sync, last applied update, conflict count, and preservation of existing import/apply provenance behavior.
- **D-14:** Preserve embedded Postgres coverage where persistence matters, but keep or extend fallback route-contract tests so default verification remains deterministic on Windows hosts where embedded Postgres may skip.
- **D-15:** Verification should include `pnpm typecheck && pnpm test`; if embedded Postgres support skips locally, document the host constraint and rely on deterministic fallback coverage for default CI/local behavior.

### the agent's Discretion
- Exact table names and endpoint names, provided they are company-scoped, migration-backed, typed, and surfaced through existing Knowledge Bridge routes/UI.
- Exact daemon protocol shape, provided local filesystem operations are represented as trusted bridge reports/apply results rather than direct arbitrary server writes.
- Exact stale threshold default, retry wording, and queue row layout, provided blocked/unavailable/conflict evidence remains visible and testable.

</decisions>

<specifics>
## Specific Ideas

- Treat Phase 40 as the operational continuation of Phase 21: Phase 21 made vault writer/import/conflict approval available; Phase 40 adds trusted local runtime identity, queueing, health, and evidence.
- The bridge should answer "can this company safely operate its local vault bridge now?" rather than only "is a root path configured?"
- Unavailable and stale are first-class states. Operators need to know whether the daemon never paired, stopped heartbeating, reported a filesystem block, or found conflicts.
- Queue/apply evidence should connect back to activity log entries so bridge operations are auditable like Phase 39 connector apply evidence.

</specifics>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Product And Phase Scope
- `.planning/PROJECT.md` - RT2-first identity, v2.6 goal, trusted local bridge scope, and deterministic local development constraint.
- `.planning/REQUIREMENTS.md` - `EXT-03` requirement for trusted local Obsidian bridge/daemon pairing and sync health evidence.
- `.planning/ROADMAP.md` - Phase 40 goal and success criteria.
- `.planning/STATE.md` - Current v2.6 state, Phase 39 completion, and deferred native/autonomy boundaries.

### Prior Phase Context
- `.planning/phases/21-obsidian-bidirectional-knowledge-sync/21-CONTEXT.md` - Source-of-truth, vault writer, import apply, and conflict resolution decisions.
- `.planning/phases/21-obsidian-bidirectional-knowledge-sync/21-01-SUMMARY.md` - Actual delivered vault writer, import candidate apply, conflict resolution, and verification evidence.
- `.planning/phases/11-task-mesh-and-knowledge-workspace/11-CONTEXT.md` - Original Obsidian-compatible export and markdown-as-inspection-surface decisions.
- `.planning/phases/26-graphify-projector/26-CONTEXT.md` - Graph confidence contract, especially AMBIGUOUS handling for Obsidian wikilinks.
- `.planning/phases/39-enterprise-connector-apply-loop/39-CONTEXT.md` - Recent v2.6 pattern for connector apply evidence, readiness surfacing, and deterministic verification.

### Existing Code Evidence
- `packages/shared/src/types/rt2-knowledge.ts` - Existing vault export, writer, import preview/apply, conflict, and operations health shared contracts to extend.
- `packages/shared/src/validators/rt2-knowledge.ts` - Existing knowledge route validators to extend for pairing, queue, heartbeat/report, and apply requests.
- `packages/db/src/schema/rt2_v33_knowledge_sync.ts` - Existing vault settings and sync decision schema to extend or complement with bridge pairing and queue state.
- `packages/db/src/migrations/0091_rt2_phase21_knowledge_sync.sql` - Current persistence baseline for vault writer settings and sync decisions.
- `server/src/services/rt2-knowledge-projector.ts` - Existing export, dry-run, import preview/apply, conflict resolution, wiki/graph projection, and provenance behavior.
- `server/src/routes/rt2-knowledge.ts` - Existing company-scoped Knowledge Bridge routes and activity log writes.
- `server/src/routes/rt2-knowledge-operations.ts` - Existing knowledge operations health route pattern.
- `server/src/services/rt2-knowledge-operations.ts` - Existing health aggregation pattern for semantic/contradiction/Jarvis states.
- `ui/src/api/rt2-knowledge.ts` - Existing UI API client methods for Knowledge Bridge operations.
- `ui/src/pages/rt2/KnowledgePage.tsx` - Existing Knowledge Bridge operator surface to extend.
- `ui/src/lib/queryKeys.ts` - Existing RT2 knowledge query key namespace to extend for bridge health/queue queries.
- `server/src/__tests__/rt2-knowledge-routes.test.ts` - Embedded Postgres route coverage for vault export/import/writer/conflict behavior.
- `server/src/__tests__/rt2-v23-route-fallback.test.ts` - Deterministic fallback route-contract coverage for Knowledge Bridge without embedded Postgres.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `rt2KnowledgeProjectorService.exportObsidianVault` already renders RT2 wiki pages into Obsidian-compatible files with frontmatter provenance.
- `saveVaultWriterSettings` and `dryRunVaultWriter` already model a guarded writer contract and warn when `local_path` would imply unsafe server-side local writes.
- `previewObsidianVaultImport`, `applyObsidianVaultImport`, and `resolveObsidianVaultConflict` already split candidates, apply approved changes, preserve sync decisions, and log route activity.
- `rt2V33KnowledgeVaultSettings` and `rt2V33KnowledgeSyncDecisions` provide the current persistence anchor for vault settings and sync audit decisions.
- `KnowledgePage` already has the Bridge tab, vault writer settings, dry-run, import preview/apply, graph report, and contradiction review controls.
- `rt2KnowledgeOperationsService` already aggregates health statuses with reason codes and flow links that Phase 40 can mirror for bridge health.

### Established Patterns
- RT2 knowledge API paths live under `/companies/:companyId/rt2/knowledge/...`.
- Company-scoped route access uses `assertCompanyAccess`; activity/audit evidence uses `logActivity`.
- Shared contracts are exported through `@paperclipai/shared`, with server and UI consuming the same types.
- Local dev and CI must remain deterministic without mandatory external daemon or provider dependencies.
- Existing graph/wiki projections treat RT2-controlled tables as canonical and vault markdown as operator-supplied evidence.

### Integration Points
- Add or extend DB schema for trusted bridge pairing, heartbeat/last-seen, sync queue entries, and health evidence.
- Add service methods near existing vault writer/import functions for pairing issuance/verification, heartbeat/report ingestion, queue enqueue/list/apply status, and bridge health aggregation.
- Add routes under `server/src/routes/rt2-knowledge.ts`, likely under `/knowledge/local-bridge/...` or `/knowledge/vault-bridge/...`, while preserving current vault export/import endpoints.
- Extend `rt2KnowledgeApi`, `queryKeys.rt2Knowledge`, and the Bridge tab in `KnowledgePage` to render pairing and health evidence.
- Extend deterministic tests in `rt2-knowledge-routes.test.ts` and `rt2-v23-route-fallback.test.ts` for persistence and fallback route contracts.

</code_context>

<deferred>
## Deferred Ideas

- Slack/Teams/native/mobile capture source installation and signed inbound review queue belong to Phase 41.
- Jarvis autonomous rewrite proposal/eval guardrails belong to Phase 42.
- App-store style native distribution and push notifications remain future native distribution scope.
- Cross-company knowledge federation remains outside v2.6 trusted company-local bridge scope.

</deferred>

---

*Phase: 40-trusted-local-knowledge-bridge*
*Context gathered: 2026-04-29*
