# Paperclip Local Asset Preservation Matrix

Date: 2026-07-16
Applies to: `C:\Users\mikeb\paperclip` local fork

---

## Classification Legend

| Class | Meaning |
|-------|---------|
| **MUST PRESERVE** | Core QSL IP or operational capability that must survive integration |
| **PRESERVE AS DOCUMENTATION** | Valuable record but does not need to be executable code in the new codebase |
| **PORT OR REIMPLEMENT** | Needs to be translated onto upstream foundation; may require adaptation |
| **LEGACY REFERENCE ONLY** | Historical record, not to be carried forward as active code |
| **SAFE TO DROP** | Can be discarded without loss of QSL IP |
| **UNKNOWN — REVIEW REQUIRED** | Insufficient evidence to classify; needs operator decision |

---

## 1. Constitutional & Governance Documents

| Asset | Location | Classification | Rationale |
|-------|----------|----------------|-----------|
| QSL Foundational Principles | `docs/constitution/00_FOUNDATIONAL_PRINCIPLES.md` | **MUST PRESERVE** | Core institutional identity. Untracked working tree file. |
| Institutional Intelligence Model | `docs/constitution/01_INSTITUTIONAL_INTELLIGENCE_MODEL.md` | **MUST PRESERVE** | Core institutional identity. Untracked working tree file. |
| Governed Decision Loop | `docs/constitution/02_GOVERNED_DECISION_LOOP.md` | **MUST PRESERVE** | Core institutional identity. Untracked working tree file. |
| Architecture Changelog | `architecture_changelog.md` | **PRESERVE AS DOCUMENTATION** | Valuable decision record; not runtime code. |
| Governance Risks Register | `governance_risks.md` | **PRESERVE AS DOCUMENTATION** | Active risk register should be migrated to new issue/plan system. |
| Liveness Report | `liveness_report.md` | **PRESERVE AS DOCUMENTATION** | Assessment artifact; upstream may have addressed some gaps. |
| Runtime Guardian Model | `docs/RUNTIME_GUARDIAN.md` | **PRESERVE AS DOCUMENTATION** | Design documentation. |
| Runtime History Model | `docs/RUNTIME_HISTORY_MODEL.md` | **PRESERVE AS DOCUMENTATION** | Design documentation. |
| Runtime Operations V4 | `docs/RUNTIME_OPERATIONS_V4.md` | **PRESERVE AS DOCUMENTATION** | Design documentation. |
| Runtime Remediation Model | `docs/RUNTIME_REMEDIATION_MODEL.md` | **PRESERVE AS DOCUMENTATION** | Design documentation. |
| Runtime Topology Model | `docs/RUNTIME_TOPOLOGY_MODEL.md` | **PRESERVE AS DOCUMENTATION** | Design documentation. |
| Governance Checkpoint Model | `docs/GOVERNANCE_CHECKPOINT_MODEL.md` | **PRESERVE AS DOCUMENTATION** | Design documentation. |
| Institutional History Logs | `docs/institutional-history/*` | **PRESERVE AS DOCUMENTATION** | Historical log of hardening sprints. |
| Provider Routing Plan | `docs/plans/provider-routing.md` | **PRESERVE AS DOCUMENTATION** | Plan document; implementation may differ on upstream. |

## 2. Operational Audits & Session Artifacts

| Asset | Location | Classification | Rationale |
|-------|----------|----------------|-----------|
| 2026 Operational Review — Plugin Architecture | `docs/audits/paperclip-2026-operational-review/09_PLUGIN_ARCHITECTURE.md` | **MUST PRESERVE** | Audit of plugin system and extension points. |
| 2026 Operational Review — Plugin Workers | `docs/audits/paperclip-2026-operational-review/09A_PLUGIN_WORKERS_AND_CAPABILITIES.md` | **MUST PRESERVE** | Critical capability inventory. |
| 2026 Operational Review — UI Extension Points | `docs/audits/paperclip-2026-operational-review/09B_UI_EXTENSION_POINTS.md` | **MUST PRESERVE** | Critical capability inventory. |
| 2026 Operational Review — External Adapters | `docs/audits/paperclip-2026-operational-review/10A_EXTERNAL_ADAPTERS_AND_HTTP_AGENTS.md` | **MUST PRESERVE** | Adapter architecture assessment. |
| 2026 Operational Review — MCP Surfaces | `docs/audits/paperclip-2026-operational-review/10B_MCP_CLI_AND_API_SURFACES.md` | **MUST PRESERVE** | MCP security assessment. |
| 2026 Operational Review — Routines & Triggers | `docs/audits/paperclip-2026-operational-review/10_ROUTINES_AND_TRIGGER_SYSTEM.md` | **MUST PRESERVE** | Trigger system assessment. |
| 2026 Operational Review — Domain Boundaries | `docs/audits/paperclip-2026-operational-review/DOMAIN_INTEGRATION_BOUNDARIES.md` | **MUST PRESERVE** | Integration architecture. |
| 2026 Operational Review — Extension Matrix | `docs/audits/paperclip-2026-operational-review/EXTENSION_DECISION_MATRIX.md` | **MUST PRESERVE** | Decision rationale. |
| Session Log SPRINT4 | `docs/audits/paperclip-2026-operational-review/SESSION_LOG_2026-07-15_SPRINT4.md` | **PRESERVE AS DOCUMENTATION** | Session record. |
| TheBinMap Intelligence Constitution | `doc/plans/2026-07-08-thebinmap-intelligence-constitution.md` | **PRESERVE AS DOCUMENTATION** | Cross-project plan document. |

## 3. QSL-Specific Integrations

| Asset | Location | Classification | Rationale |
|-------|----------|----------------|-----------|
| QSL Findings DB Schema | `packages/db/src/schema/qsl_findings.ts` | **PORT OR REIMPLEMENT** | Core QSL data model. Must be reconciled with upstream migration regime. |
| QSL Migrations 0071, 0072 | `packages/db/src/migrations/0071_*.sql`, `0072_*.sql` | **PORT OR REIMPLEMENT** | Schema changes must be ported as new migrations on upstream baseline. |
| QSL Review Service | `server/src/services/qsl-review.ts` | **PORT OR REIMPLEMENT** | Core business logic. Likely conflicts with upstream recovery/service changes. |
| QSL Bridge Routes | `server/src/routes/qsl-bridge.ts` | **PORT OR REIMPLEMENT** | API surface. Must be re-tested against upstream auth patterns. |
| QSL Review UI Page | `ui/src/pages/QslReview.tsx` | **PORT OR REIMPLEMENT** | React page. Must be adapted to upstream UI component changes. |
| QSL API Client | `ui/src/api/qsl.ts` | **PORT OR REIMPLEMENT** | Thin API wrapper; low porting cost. |
| QSL UI Integration | `ui/src/App.tsx`, `Sidebar.tsx`, `company-routes.ts`, `queryKeys.ts` | **PORT OR REIMPLEMENT** | Route registration and navigation. Low porting cost. |
| Board Intelligence Export Service | `server/src/services/board-export.ts` | **PORT OR REIMPLEMENT** | QSL-specific operational export. High value, but may conflict with upstream board changes. |
| Board Export Routes | `server/src/routes/board-export.ts` | **PORT OR REIMPLEMENT** | API surface for exports. |
| Board Export CLI Script | `server/scripts/generate-board-export.ts` | **PORT OR REIMPLEMENT** | Utility script. |
| QSL Paperclip Context Template | `templates/QSL_PAPERCLIP_CONTEXT.md` | **MUST PRESERVE** | Agent operating instructions for QSL. |

## 4. Runtime Guardians & Governance Scripts

| Asset | Location | Classification | Rationale |
|-------|----------|----------------|-----------|
| Governance Checkpoint Python | `scripts/governance_checkpoint.py` | **PORT OR REIMPLEMENT** | Standalone script; low coupling. Can be copied as-is. |
| Runtime Export Python | `scripts/runtime_export.py` | **PORT OR REIMPLEMENT** | Standalone script; low coupling. |
| Runtime Guardian Python | `scripts/runtime_guardian.py` | **PORT OR REIMPLEMENT** | Standalone script; low coupling. |
| Runtime History Python | `scripts/runtime_history.py` | **PORT OR REIMPLEMENT** | Standalone script; low coupling. |
| Runtime Remediator Python | `scripts/runtime_remediator.py` | **PORT OR REIMPLEMENT** | Standalone script; low coupling. |
| Runtime Rotation Python | `scripts/runtime_rotation.py` | **PORT OR REIMPLEMENT** | Standalone script; low coupling. |
| Runtime Topology Report Python | `scripts/runtime_topology_report.py` | **PORT OR REIMPLEMENT** | Standalone script; low coupling. |

## 5. Provider Routing & Adapter Changes

| Asset | Location | Classification | Rationale |
|-------|----------|----------------|-----------|
| Provider Routing Service | `server/src/services/provider-routing.ts` | **UNKNOWN — REVIEW REQUIRED** | Upstream may have evolved routing. Must diff against upstream before porting. |
| Provider Routing Policy | `server/src/services/provider-routing-policy.ts` | **UNKNOWN — REVIEW REQUIRED** | Same as above. |
| Claude-local Quota Protection | `packages/adapters/claude-local/src/server/execute.ts`, `parse.ts` | **PORT OR REIMPLEMENT** | Critical operational guardrail. Small change set. |
| Adapter Registry Changes | `server/src/adapters/registry.ts` | **UNKNOWN — REVIEW REQUIRED** | May conflict with upstream adapter plugin system evolution. |

## 6. Heartbeat & Recovery Hardening

| Asset | Location | Classification | Rationale |
|-------|----------|----------------|-----------|
| Heartbeat Quota Protection | `server/src/services/heartbeat.ts` | **UNKNOWN — REVIEW REQUIRED** | Upstream has evolved heartbeat significantly. May have superseded local changes. |
| Recovery Service Hardening | `server/src/services/recovery/*` | **UNKNOWN — REVIEW REQUIRED** | Upstream has extensive recovery evolution. Local changes may be redundant or conflicting. |
| Institutional Backup Service | `server/src/services/institutional-backup.ts` | **PORT OR REIMPLEMENT** | QSL-specific backup orchestration. |
| Approval Deduplication | `server/src/services/approvals.ts`, `routes/approvals.ts` | **UNKNOWN — REVIEW REQUIRED** | Upstream may have addressed approval race conditions. |

## 7. UI Changes

| Asset | Location | Classification | Rationale |
|-------|----------|----------------|-----------|
| stderr_group accordion | `ui/src/components/transcript/RunTranscriptView.tsx` | **PORT OR REIMPLEMENT** | Fork QoL patch per AGENTS.md. Confirmed present in both local and upstream test (upstream may have merged independently). |
| tool_group accordion | `ui/src/components/transcript/RunTranscriptView.tsx` | **PORT OR REIMPLEMENT** | Fork QoL patch per AGENTS.md. Verify if still divergent. |
| Dashboard excerpt (LatestRunCard) | `ui/src/components/dashboard/LatestRunCard.tsx` (assumed) | **UNKNOWN — REVIEW REQUIRED** | Fork QoL patch per AGENTS.md. Exact file not confirmed in diff. |
| Hermes-local adapter UI fix | `ui/src/adapters/hermes-local/index.ts` | **PORT OR REIMPLEMENT** | Small fix; upstream may have different Hermes strategy. |

## 8. Deployment, Environment & Secrets

| Asset | Location | Classification | Rationale |
|-------|----------|----------------|-----------|
| `.env.legacy` | Repo root (untracked) | **LEGACY REFERENCE ONLY** | Legacy environment file. Do not carry secrets forward. |
| `cli/src/commands/env.ts` | Tracked change | **UNKNOWN — REVIEW REQUIRED** | Minor change; verify against upstream CLI evolution. |
| `server/src/config.ts` | Tracked change | **UNKNOWN — REVIEW REQUIRED** | Config change; verify against upstream config schema. |
| `.gitignore` | Tracked change | **PORT OR REIMPLEMENT** | Likely adds QSL-specific ignores. Trivial to port. |

## 9. Database Migrations

| Asset | Location | Classification | Rationale |
|-------|----------|----------------|-----------|
| Migration 0071 — qsl_findings | `packages/db/src/migrations/0071_qsl_findings.sql` | **PORT OR REIMPLEMENT** | Must be renumbered to avoid conflict with upstream's 172 migrations. |
| Migration 0072 — review states | `packages/db/src/migrations/0072_qsl_findings_review_states.sql` | **PORT OR REIMPLEMENT** | Must be renumbered. |
| Migration journal | `packages/db/src/migrations/meta/_journal.json` | **SAFE TO DROP** | Will be regenerated by Drizzle on new migration generation. |

## 10. Historical Company / Runtime Data

| Asset | Location | Classification | Rationale |
|-------|----------|----------------|-----------|
| Legacy default instance | `C:\Users\mikeb\.paperclip\instances\default` | **LEGACY REFERENCE ONLY** | Must not start or migrate. Preserved read-only. |
| Verified backup | `C:\Users\mikeb\.paperclip\instances\default-backup-20260716-104332` | **MUST PRESERVE** | Verified backup of legacy state. |
| Sprint5 clean instance | `C:\Users\mikeb\.paperclip\instances\sprint5-clean` | **UNKNOWN — REVIEW REQUIRED** | Purpose and contents unknown without inspection. |
| Upstream clean test instance | `C:\Users\mikeb\.paperclip\instances\upstream-clean-test` | **SAFE TO DROP** | Disposable test artifact. |
| Disposable upstream test repo | `C:\Users\mikeb\paperclip-upstream-test` | **SAFE TO DROP** | Worktree of main repo; can be recreated. |
| SELARIX company data (in backup) | backup DB | **MUST PRESERVE** | Agent configs, issues, companies. |
| QSL Security Ops company data (in backup) | backup DB | **MUST PRESERVE** | Agent configs, issues, companies. |

## 11. Session Logs & Analysis Reports (Repo Root)

| Asset | Location | Classification | Rationale |
|-------|----------|----------------|-----------|
| `PAPERCLIP_CANONICAL_INSTANCE_RECOMMENDATION.md` | Repo root | **PRESERVE AS DOCUMENTATION** | Analysis artifact. |
| `PAPERCLIP_CLEAN_RUNTIME_VERIFICATION_2026-07-16.md` | Repo root | **PRESERVE AS DOCUMENTATION** | Verification record. |
| `PAPERCLIP_CONFLICT_RISK_ASSESSMENT.md` | Repo root | **PRESERVE AS DOCUMENTATION** | Analysis artifact. |
| `PAPERCLIP_DATA_AND_DATABASE_MAP.md` | Repo root | **PRESERVE AS DOCUMENTATION** | Data map. |
| `PAPERCLIP_EMBEDDED_POSTGRES_BUG_ANALYSIS_2026-07-16.md` | Repo root | **PRESERVE AS DOCUMENTATION** | Root-cause analysis. |
| `PAPERCLIP_INSTANCE_INVENTORY.md` | Repo root | **PRESERVE AS DOCUMENTATION** | Inventory. |
| `PAPERCLIP_ISOLATION_EXECUTION_2026-07-16.md` | Repo root | **PRESERVE AS DOCUMENTATION** | Execution record. |
| `PAPERCLIP_LEGACY_ROLLBACK_2026-07-16.md` | Repo root | **PRESERVE AS DOCUMENTATION** | Rollback plan. |
| `PAPERCLIP_RUNTIME_MAP.md` | Repo root | **PRESERVE AS DOCUMENTATION** | Runtime map. |
| `clean-server-*.log`, `dev-server-*.log/err` | Repo root | **SAFE TO DROP** | Transient logs. |
| `LEGACY_POSTGRES_STATE_2026-07-16.txt` | Repo root | **PRESERVE AS DOCUMENTATION** | State snapshot. |

---

## Summary Counts

| Classification | Count |
|----------------|-------|
| MUST PRESERVE | 9 |
| PRESERVE AS DOCUMENTATION | 27 |
| PORT OR REIMPLEMENT | 21 |
| LEGACY REFERENCE ONLY | 3 |
| SAFE TO DROP | 5 |
| UNKNOWN — REVIEW REQUIRED | 10 |

---
*Matrix generated 2026-07-16. No mutations performed.*
