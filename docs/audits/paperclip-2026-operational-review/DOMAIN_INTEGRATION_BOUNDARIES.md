# Paperclip Operational Audit 2026 — Sprint 4
## DOMAIN_INTEGRATION_BOUNDARIES

**Evidence date:** 2026-07-15  
**Scope:** Architectural boundary between Paperclip-owned state and domain-owned state, with implementation evidence for every boundary.

---

## 1. Paperclip-Owned State

These tables and concepts are owned and governed by Paperclip core:

### 1.1 Work System
| Table | Ownership | Evidence |
|-------|-----------|----------|
| `issues` | Paperclip | `packages/db/src/schema/issues.ts` — `company_id`, `project_id`, `assignee_agent_id`, `status`, `priority`, `origin_kind`, `origin_id`, `origin_fingerprint` |
| `issue_comments` | Paperclip | `packages/db/src/schema/issue_comments.ts` |
| `issue_documents` | Paperclip | `packages/db/src/schema/issue_documents.ts` — links `documents` to `issues` |
| `issue_attachments` | Paperclip | `packages/db/src/schema/issue_attachments.ts` — links `assets` to `issues` |
| `issue_approvals` | Paperclip | `packages/db/src/schema/issue_approvals.ts` — links `approvals` to `issues` |
| `issue_relations` | Paperclip | `packages/db/src/schema/issue_relations.ts` |
| `issue_labels` | Paperclip | `packages/db/src/schema/issue_labels.ts` |
| `documents` | Paperclip | `packages/db/src/schema/documents.ts` — revision-tracked |
| `document_revisions` | Paperclip | `packages/db/src/schema/document_revisions.ts` |
| `assets` | Paperclip | `packages/db/src/schema/assets.ts` |
| `approvals` | Paperclip | `packages/db/src/schema/approvals.ts` — `status`, `type`, `requested_by_agent_id` |
| `approval_comments` | Paperclip | `packages/db/src/schema/approval_comments.ts` |

### 1.2 Agent Runtime
| Table | Ownership | Evidence |
|-------|-----------|----------|
| `agents` | Paperclip | `packages/db/src/schema/agents.ts` — `company_id`, `status`, `adapter_type`, `role` |
| `agent_api_keys` | Paperclip | `packages/db/src/schema/agent_api_keys.ts` — hashed at rest |
| `agent_config_revisions` | Paperclip | `packages/db/src/schema/agent_config_revisions.ts` |
| `agent_runtime_state` | Paperclip | `packages/db/src/schema/agent_runtime_state.ts` |
| `agent_task_sessions` | Paperclip | `packages/db/src/schema/agent_task_sessions.ts` |
| `heartbeat_runs` | Paperclip | `packages/db/src/schema/heartbeat_runs.ts` — `status`, `context_snapshot`, `agent_id` |
| `heartbeat_run_events` | Paperclip | `packages/db/src/schema/heartbeat_run_events.ts` |
| `heartbeat_run_watchdog_decisions` | Paperclip | `packages/db/src/schema/heartbeat_run_watchdog_decisions.ts` |

### 1.3 Routines and Scheduling
| Table | Ownership | Evidence |
|-------|-----------|----------|
| `routines` | Paperclip | `packages/db/src/schema/routines.ts` |
| `routineTriggers` | Paperclip | `packages/db/src/schema/routines.ts` |
| `routineRuns` | Paperclip | `packages/db/src/schema/routines.ts` |

### 1.4 Activity and Audit
| Table | Ownership | Evidence |
|-------|-----------|----------|
| `activity_log` | Paperclip | `packages/db/src/schema/activity_log.ts` — `actor_type`, `action`, `entity_type`, `entity_id` |

### 1.5 Plugin System
| Table | Ownership | Evidence |
|-------|-----------|----------|
| `plugins` | Paperclip | `packages/db/src/schema/plugins.ts` |
| `plugin_config` | Paperclip | `packages/db/src/schema/plugin_config.ts` |
| `plugin_company_settings` | Paperclip | `packages/db/src/schema/plugin_company_settings.ts` |
| `plugin_jobs` | Paperclip | `packages/db/src/schema/plugin_jobs.ts` |
| `plugin_job_runs` | Paperclip | `packages/db/src/schema/plugin_jobs.ts` |
| `plugin_state` | Plugin-owned keys, Paperclip-owned table | `packages/db/src/schema/plugin_state.ts` — host manages storage |
| `plugin_entities` | Plugin-owned data, Paperclip-owned table | `packages/db/src/schema/plugin_entities.ts` — host manages storage |
| `plugin_logs` | Paperclip | `packages/db/src/schema/plugin_logs.ts` |
| `plugin_webhook_deliveries` | Paperclip | `packages/db/src/schema/plugin_webhooks.ts` |
| `plugin_database_namespaces` | Paperclip | `packages/db/src/schema/plugin_database.ts` |
| `plugin_migrations` | Paperclip | `packages/db/src/schema/plugin_database.ts` |

---

## 2. Domain-Owned State

These concepts represent data that belongs to external domain systems. Paperclip may store pointers, sync cursors, or cached views, but the authoritative source is outside Paperclip.

### 2.1 Customer Records
- **Not stored in Paperclip.** There is no `customers` table.
- If needed, a plugin could store customer mappings in `plugin_entities`.

### 2.2 Mailbox Synchronization Cursors
- **Not stored in Paperclip natively.**
- A plugin (e.g., email sync plugin) would store the IMAP/Exchange cursor in `plugin_state` (scope: `company` or `instance`).

### 2.3 Raw Email Evidence
- **Not stored in Paperclip natively.**
- Email content could be stored as `issue_attachments` (linked to `assets`) if converted to Paperclip work, or stored in a plugin's database namespace.

### 2.4 Subscriber Consent
- **Not stored in Paperclip.**
- Would belong to an external system or plugin tables.

### 2.5 Purchases / Store Intelligence
- **Not stored in Paperclip.**
- Would belong to an external e-commerce system.

### 2.6 Verification History
- **Not stored in Paperclip.**
- Would belong to an external identity verification system.

### 2.7 External System IDs (Plugin Entity Mappings)
- Plugin-owned but stored in Paperclip's `plugin_entities` table.
- The `external_id` column points to the remote system's identifier.
- The `data` JSONB column can cache remote entity state.
- **Boundary:** Paperclip stores the mapping; the external system owns the authoritative record.

**Evidence:**
- `packages/db/src/schema/plugin_entities.ts` — `external_id`, `entity_type`, `data`

---

## 3. Boundary Analysis

### 3.1 Issue origin kinds (`issues.origin_kind`)
This column is the primary boundary marker for how an issue entered the system:

| Origin Kind | Meaning | Owner |
|-------------|---------|-------|
| `manual` | Created by user/agent via UI/API | Paperclip |
| `routine_execution` | Created by a routine run | Paperclip |
| `stale_active_run_evaluation` | Created by liveness harness | Paperclip |
| `plugin:{pluginKey}` | Created by a plugin | Plugin (via Paperclip API) |
| `harness_liveness_escalation` | Escalation from liveness system | Paperclip |

**Evidence:**
- `packages/shared/src/constants.ts::ISSUE_ORIGIN_KINDS`
- `packages/db/src/schema/issues.ts::origin_kind`

### 3.2 Plugin namespace boundary
Plugins get a dedicated database namespace (schema) for their own tables. The host:
- Creates the namespace deterministically from the plugin key.
- Runs migrations from the plugin's `migrationsDir`.
- Gates queries so the plugin can only write in its own namespace.
- Allows read access to selected core tables via `coreReadTables` declaration.

**Boundary rule:** Plugin SQL cannot modify core tables; it can only read join targets.

**Evidence:**
- `packages/db/src/schema/plugin_database.ts`
- `server/src/services/plugin-database.ts`

### 3.3 Secret boundary
- `company_secrets` stores encrypted material.
- `company_secret_versions` stores versioned ciphertext.
- Secret providers handle decryption.
- Plugins only see resolved plaintext via `ctx.secrets.resolve()`; they never see the ciphertext or provider internals.

**Evidence:**
- `packages/db/src/schema/company_secrets.ts`
- `packages/db/src/schema/company_secret_versions.ts`
- `server/src/services/plugin-secrets-handler.ts`

### 3.4 Activity log boundary
The `activity_log` records WHO did WHAT to WHICH entity. It does not store the full entity state — only the action and summary details. The entity itself is the authoritative state.

**Evidence:**
- `packages/db/src/schema/activity_log.ts`
- `server/src/services/activity-log.ts`

---

## 4. State Duplication Risks

### 4.1 Plugin entity caching (`plugin_entities.data`)
Plugins may cache external entity state in `plugin_entities.data`. This is a deliberate caching boundary, but:
- Stale data risk if sync fails.
- No automatic TTL or eviction.
- Plugin responsible for cache invalidation.

**Severity:** Low — by design; plugins manage their own consistency.

### 4.2 Routine variable defaults in `routines.variables`
Routine variable definitions include `defaultValue`. If the same semantic value is also stored in `company_secrets` or agent config, there is potential for divergence. No automatic synchronization exists.

**Severity:** Low — operator-managed.

### 4.3 `heartbeat_runs.contextSnapshot` stores a point-in-time view of issue/agent state
The `contextSnapshot` JSONB captures the issue ID, task ID, and other run context. If the issue is later modified (reassigned, reprioritized), the snapshot is stale. This is by design (audit trail) but means the snapshot is not the current state.

**Severity:** Negligible — snapshots are intentionally point-in-time.

---

## 5. Architectural Contradictions

### 5.1 `plugin_entities` is described as "for structured object mappings that the host can understand and query for cross-plugin UI integration" but there is no evidence of cross-plugin UI integration using this table
The schema comment says `plugin_entities` enables cross-plugin UI integration, but no frontend code was found that queries `plugin_entities` across plugins. The table is used by individual plugins for their own mappings.

**Severity:** Low — the table exists for future cross-plugin features; current usage is plugin-local.

### 5.2 `plugin_database_namespaces` allocates namespaces per plugin, but there is no evidence of namespace cleanup on plugin uninstall
When a plugin is uninstalled, `plugin-loader.ts::cleanupInstallArtifacts()` removes on-disk files and runs `npm uninstall`, but there is no code inspected that drops the plugin's database namespace or its tables.

**Evidence:**
- `plugin-loader.ts::cleanupInstallArtifacts()` — file cleanup only
- No `DROP SCHEMA` or migration rollback found

**Severity:** Medium — orphaned database schemas on uninstall.

### 5.3 `issues.originFingerprint` is used for routine execution deduplication, but it is also `notNull().default('default')`, meaning all non-routine issues share the same fingerprint value
The `openRoutineExecutionIdx` unique index applies only when `originKind = 'routine_execution'`. For non-routine issues, `originFingerprint` is `'default'` and the unique index does not apply. This is correct but means the column is overloaded: it is a deduplication key for routines and a meaningless default for everything else.

**Severity:** Negligible — by design; partial index handles it.

---

*No other contradictions identified from current evidence.*
