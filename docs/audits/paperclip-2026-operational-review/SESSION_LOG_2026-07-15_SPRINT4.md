# Paperclip Operational Audit 2026 — Sprint 4
## FINAL SUMMARY

**Completed:** 2026-07-15  
**Scope:** Plugin architecture, routines, adapters, MCP/CLI/API surfaces, domain boundaries, and extension decision matrix.  
**Rule compliance:** No production code modified. No email implementation designed. No upstream comparison.

---

## 1. Files Inspected

### Schema (29 files)
- `packages/db/src/schema/plugins.ts`
- `packages/db/src/schema/plugin_company_settings.ts`
- `packages/db/src/schema/plugin_config.ts`
- `packages/db/src/schema/plugin_jobs.ts`
- `packages/db/src/schema/plugin_state.ts`
- `packages/db/src/schema/plugin_logs.ts`
- `packages/db/src/schema/plugin_database.ts`
- `packages/db/src/schema/plugin_entities.ts`
- `packages/db/src/schema/plugin_webhooks.ts`
- `packages/db/src/schema/routines.ts`
- `packages/db/src/schema/issues.ts`
- `packages/db/src/schema/issue_documents.ts`
- `packages/db/src/schema/issue_attachments.ts`
- `packages/db/src/schema/issue_approvals.ts`
- `packages/db/src/schema/activity_log.ts`
- `packages/db/src/schema/company_secrets.ts`
- `packages/db/src/schema/heartbeat_runs.ts`
- `packages/db/src/schema/agents.ts`
- `packages/db/src/schema/agent_api_keys.ts`
- `packages/db/src/schema/documents.ts`
- `packages/db/src/schema/assets.ts`
- `packages/db/src/schema/approvals.ts`
- `packages/db/src/schema/projects.ts`
- `packages/db/src/schema/goals.ts`
- `packages/db/src/schema/company_memberships.ts`
- `packages/db/src/schema/labels.ts`
- `packages/db/src/schema/execution_workspaces.ts`
- `packages/db/src/schema/heartbeat_run_events.ts`
- `packages/db/src/schema/budget_incidents.ts`

### Server Services (19 files)
- `server/src/services/plugin-loader.ts`
- `server/src/services/plugin-lifecycle.ts`
- `server/src/services/plugin-worker-manager.ts`
- `server/src/services/plugin-capability-validator.ts`
- `server/src/services/plugin-host-services.ts`
- `server/src/services/plugin-event-bus.ts`
- `server/src/services/plugin-job-scheduler.ts`
- `server/src/services/plugin-tool-dispatcher.ts`
- `server/src/services/plugin-stream-bus.ts`
- `server/src/services/plugin-secrets-handler.ts`
- `server/src/services/routines.ts`
- `server/src/services/activity-log.ts`
- `server/src/services/adapter-plugin-store.ts`
- `server/src/services/issue-assignment-wakeup.ts`
- `server/src/services/cron.ts`
- `server/src/services/companies.ts` (referenced)
- `server/src/services/issues.ts` (referenced)
- `server/src/services/heartbeat.ts` (referenced)
- `server/src/services/secrets.ts` (referenced)

### Server Routes (8 files)
- `server/src/routes/plugins.ts`
- `server/src/routes/routines.ts`
- `server/src/routes/adapters.ts`
- `server/src/routes/approvals.ts`
- `server/src/routes/issues.ts` (partial)
- `server/src/routes/authz.ts`
- `server/src/routes/index.ts`
- `server/src/routes/plugin-ui-static.ts` (referenced)

### Adapters (3 files)
- `server/src/adapters/builtin-adapter-types.ts`
- `server/src/adapters/plugin-loader.ts`
- `server/src/adapters/types.ts`

### Shared Types / Constants (5 files)
- `packages/shared/src/types/plugin.ts`
- `packages/shared/src/types/routine.ts`
- `packages/shared/src/constants.ts`
- `packages/shared/src/types/adapter-skills.ts`
- `packages/shared/src/validators/routine.ts`

### Plugin SDK (1 file)
- `packages/plugins/sdk/src/define-plugin.ts`

### CLI (2 files)
- `cli/src/commands/client/plugin.ts`
- `cli/src/commands/routines.ts`

### Documentation (2 files)
- `doc/TASKS-mcp.md`
- `AGENTS.md` (fork-specific context)

---

## 2. Documents Created

1. `09_PLUGIN_ARCHITECTURE.md` — Discovery, metadata, lifecycle, workers, capabilities, host services, persistence, secrets, jobs, failures, audit, UI contributions
2. `09A_PLUGIN_WORKERS_AND_CAPABILITIES.md` — Process isolation, capability enforcement, host service surface, sandbox boundaries, secret injection, scheduling, failures
3. `09B_UI_EXTENSION_POINTS.md` — Slot types, rendering, navigation, data-fetching, auth, company scoping, governed actions, core modification requirements
4. `10_ROUTINES_AND_TRIGGER_SYSTEM.md` — Schema, triggers, schedules, payloads, idempotency, concurrency, catch-up, issue creation, assignment, wakeup, completion, history
5. `10A_EXTERNAL_ADAPTERS_AND_HTTP_AGENTS.md` — Built-in vs external, registry, config, execution, heartbeat, identity, secrets, sessions, timeouts, auditability
6. `10B_MCP_CLI_AND_API_SURFACES.md` — MCP spec, CLI commands, HTTP routes, webhooks, API keys, run identity, board auth, company scoping, safe surfaces matrix
7. `EXTENSION_DECISION_MATRIX.md` — 9 extension mechanisms compared across 11 dimensions
8. `DOMAIN_INTEGRATION_BOUNDARIES.md` — Paperclip-owned vs domain-owned state, boundary rules, duplication risks

---

## 3. Extension Capability Coverage Matrix

| Capability | Plugin | Routine | External Adapter | External Service + API | Core Mod Required |
|-----------|--------|---------|-----------------|----------------------|------------------|
| Discovery | ✅ npm/local scan | ✅ DB schema | ✅ JSON store | N/A | N/A |
| Background execution | ✅ Worker process | ✅ Heartbeat run | ✅ Heartbeat run | N/A | N/A |
| Cron scheduling | ✅ plugin-jobs scheduler | ✅ routineTriggers | ❌ | ❌ | N/A |
| Webhook ingress | ✅ Plugin webhooks | ✅ Public trigger URL | ❌ | N/A | N/A |
| Issue creation | ✅ Capability-gated | ✅ Automatic | ❌ | ✅ API | N/A |
| Agent wakeup | ✅ Capability-gated | ✅ Automatic | ❌ | ✅ API | N/A |
| UI contributions | ✅ Slots, launchers, pages | ❌ | ❌ Config schema only | ❌ | N/A |
| Scoped API routes | ✅ `/api/plugins/:id/api/*` | ❌ | ❌ | N/A | N/A |
| Agent tools | ✅ Manifest declaration | ❌ | ❌ | N/A | N/A |
| Database namespace | ✅ Migrations + runtime SQL | ❌ | ❌ | N/A | N/A |
| Secrets access | ✅ Config-referenced UUIDs | ✅ Webhook secrets | ✅ Agent config | External | N/A |
| Activity logging | ✅ Automatic + explicit | ✅ Automatic | ✅ via runs | ✅ API | N/A |
| Approval creation | ❌ | ❌ | ❌ | ✅ API | N/A |
| Approval UI integration | ❌ | ❌ | ❌ | ❌ | ✅ |
| Issue list customization | ❌ | ❌ | ❌ | ❌ | ✅ |
| Board view customization | ❌ | ❌ | ❌ | ❌ | ✅ |

---

## 4. Highest-Confidence Findings

1. **Plugin system is production-ready** with full lifecycle, out-of-process workers, capability-based access control, SDK, bridge, streams, and database namespaces.
2. **Routines are mature** with cron/webhook/API triggers, concurrency policies (`coalesce_if_active`, `always_enqueue`, `skip_if_active`), idempotency, and automatic issue creation + agent wakeup.
3. **External adapter system works** — adapters can be installed from npm or local paths, registered dynamically, and provide config schemas + UI parsers.
4. **Company scoping is enforced throughout** — every core table has `company_id`, and `assertCompanyAccess()` blocks cross-company access for both agents and board users.
5. **Agent API keys are hashed at rest** and scoped to companies.
6. **Activity logging covers all major mutations** with actor attribution, run linkage, and redaction support.
7. **Plugin secrets are tightly scoped** — only UUIDs referenced in plugin config are resolvable; rate-limited at 30/min.

---

## 5. Unsupported or Incomplete Extension Claims

1. **Plugin approval creation — UNSUPPORTED.** No `approvals.create` capability exists in `OPERATION_CAPABILITIES`. Plugins cannot request board approvals.
2. **Plugin UI for approval workflow — UNSUPPORTED.** No UI slot exists for inline approval gates.
3. **MCP server implementation — UNVERIFIED.** Specification exists (`doc/TASKS-mcp.md`) but no runtime MCP server code was found.
4. **Plugin per-company worker isolation — UNSUPPORTED.** Plugins are instance-wide; one worker per plugin regardless of company count.
5. **Plugin formal sandbox — UNSUPPORTED.** Workers are trusted Node.js processes with host filesystem access.
6. **Catch-up queue persistence — PARTIAL.** `enqueue_missed_with_cap` fires synchronously in the scheduler tick; no persistent queue.
7. **Plugin namespace cleanup on uninstall — UNVERIFIED.** No code inspected that drops plugin database schemas on uninstall.

---

## 6. Remaining Unknowns

1. **Heartbeat service internals** — Not fully traced; exact run dispatch flow from heartbeat to adapter not inspected.
2. **Agent adapter execution details** — Wire protocol, retry logic, and timeout handling per adapter not traced.
3. **MCP server runtime** — Whether an MCP server is running and how it maps to the spec is unknown.
4. **Plugin dev watcher behavior** — `plugin-dev-watcher.ts` referenced but not inspected.
5. **E2B sandbox provider** — Plugin sandbox provider exists but integration details unknown.
6. **Cost/budget enforcement in routines** — Budget blocking checked in `dispatchRoutineRun` but full budget service not inspected.
7. **Instance settings and backup routes** — Present but not inspected.

---

## 7. Architectural Contradictions (Consolidated)

| # | Contradiction | Severity | Location |
|---|--------------|----------|----------|
| 1 | Company-scoped plugin enablement (`plugin_company_settings`) stored but not enforced at worker startup | Medium | `plugin-lifecycle.ts`, `plugin-host-services.ts` |
| 2 | Plugin UI contributions served without integrity checks (no SRI, CSP, sandbox) | Medium | `plugin-ui-static.ts`, `routes/plugins.ts` |
| 3 | `enqueue_missed_with_cap` runs synchronously in tick, not in a persistent queue | Low | `routines.ts::tickScheduledTriggers()` |
| 4 | Webhook auth failures do not update trigger `last_result` or `last_fired_at` | Low | `routines.ts::firePublicTrigger()` |
| 5 | Plugin tools execute without checkout ownership verification | Medium | `plugin-tool-dispatcher.ts`, `routes/plugins.ts` |
| 6 | MCP specification exists but no runtime implementation found | Medium | `doc/TASKS-mcp.md` |
| 7 | Hot-install rejects builtin overrides, but startup init allows them | Low | `routes/adapters.ts`, `adapters/plugin-loader.ts` |
| 8 | `plugin_entities` described for cross-plugin UI but no evidence of cross-plugin usage | Low | `schema/plugin_entities.ts` |
| 9 | Plugin database namespaces may not be cleaned up on uninstall | Medium | `plugin-loader.ts::cleanupInstallArtifacts()` |
| 10 | `page` slot route collision check only at install, not at runtime after uninstall/reinstall | Low | `plugin-loader.ts::assertPageRoutePathsAvailable()` |
| 11 | Plugin `order` field declared but no evidence frontend sorts by it | Low | `types/plugin.ts`, UI not inspected for sorting |
| 12 | `issues.originFingerprint` overloaded: deduplication key for routines, meaningless default for others | Negligible | `schema/issues.ts` |

---

## 8. Proven Usable Extension Mechanisms

1. **Native Plugin** — Full SDK, worker isolation, capabilities, UI slots, tools, jobs, webhooks, scoped API routes, database namespace.
2. **Routine + Webhook Trigger** — External systems POST to public URL; routine creates issue and wakes agent.
3. **Routine + Schedule Trigger** — Cron-based recurring work with automatic issue creation.
4. **External Adapter Plugin** — Add new agent backends without core modification.
5. **External Service + Paperclip API** — Any external system can create issues, comments, approvals via authenticated API.
6. **Plugin Scoped API Routes** — Plugin exposes its own REST API under `/api/plugins/:id/api/*` with auth and company resolution.
7. **Plugin Agent Tools** — Plugin contributes tools that agents can invoke during runs.

---

## 9. Recommended Scope for Next Design Sprint

Based on this audit, the next design sprint (email operations / customer operations / external data sources) should focus on:

### 9.1 Immediate proven paths
- **Webhook-triggered routines** for simple intake (email → issue creation)
- **Native plugins** for complex intake (email parsing, classification, attachment handling, stateful sync)
- **Plugin scoped API routes** for external systems to push structured data

### 9.2 Gaps to address before production external intake
- **Approval creation from plugins** — Add `approvals.create` and `issue_approvals.link` to `OPERATION_CAPABILITIES` if plugins need to request board approval
- **Per-company plugin enablement enforcement** — Decide whether plugins should be instance-wide or per-company; implement accordingly
- **Plugin namespace cleanup** — Ensure plugin uninstall drops database schemas
- **MCP server implementation verification** — If MCP is a planned integration surface, confirm it exists and works

### 9.3 Out of scope (requires core modification)
- Custom approval UI inline with plugin pages
- Custom issue list columns or board swimlanes
- Core navigation shell modifications

### 9.4 Boundary decisions to document
- Where mailbox sync cursors live (plugin state vs routine state vs external system)
- Where raw email evidence lives (issue attachments vs plugin namespace vs external system)
- Whether customer identity is stored in `plugin_entities` or referenced externally
- Whether subscriber consent checks happen in Paperclip or in the external intake service

---

*Audit complete. No production code modified. All findings are evidence-backed.*
