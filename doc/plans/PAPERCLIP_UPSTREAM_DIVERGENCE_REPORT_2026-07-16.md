# Paperclip Upstream Divergence Report

Date: 2026-07-16
Audited local branch: `docs/paperclip-operational-audit-2026` @ `e6da760d1`
Local fork default (`master`): `bb5f60ef2`
Upstream (`upstream/master`): `6ec059ab4` (also verified in disposable worktree `paperclip-upstream-test`)
Merge-base: `1d9f7a5149fe60b66234d696f9ddc468e5afe19e`

---

## 1. Commit Quantities

| Measure | Count |
|---------|-------|
| Commits on `master` not in upstream | **44** |
| Commits on upstream `master` not in local | **798** |
| Commits on audited branch ahead of `master` | **4** (constitution docs) |
| Untracked working-tree files (audited branch) | ~30 (audit docs, constitution, session logs, plans) |

## 2. Branch Topology

```
upstream/master (6ec059ab4) ── 798 commits ──► [upstream HEAD]
        │
        ▼
   merge-base (1d9f7a51)
        │
        └── local/master (bb5f60ef2) ── 44 commits ──► [local master]
                      │
                      └── docs/paperclip-operational-audit-2026 (e6da760d1)
                              ── 4 additional commits (constitution ratification)
```

## 3. Local Commit Themes (master)

The 44 local-only commits cluster into these feature groups:

### 3.1 QSL Security & Review System
- `qsl_findings` DB table + migrations (`0071`, `0072`)
- `server/src/services/qsl-review.ts` — sync, dedup, review state-machine
- `server/src/routes/qsl-bridge.ts` — company-scoped bridge endpoints
- `ui/src/pages/QslReview.tsx` — review UI with approve/deny controls
- `ui/src/api/qsl.ts` — API client for QSL review

### 3.2 Board Intelligence Export
- `server/src/services/board-export.ts` — comprehensive operational state export
- `server/src/routes/board-export.ts` — API endpoints
- `server/scripts/generate-board-export.ts` — CLI script
- `board_exports/` directory

### 3.3 Governance & Runtime Guardians
- `scripts/runtime_guardian.py` / `runtime_remediator.py` / `runtime_history.py`
- `scripts/governance_checkpoint.py`
- `docs/RUNTIME_*.md` model documentation
- `governance_risks.md` — active risk register
- `liveness_report.md` — liveness subsystem assessment

### 3.4 Provider Routing Infrastructure (Stage 0)
- `server/src/services/provider-routing.ts`
- `server/src/services/provider-routing-policy.ts`
- `packages/adapters/claude-local/src/server/execute.ts` — quota protection guardrails

### 3.5 Heartbeat / Recovery Hardening
- `server/src/services/heartbeat.ts` — quota-protection guardrails
- `server/src/services/recovery/service.ts` — liveness/deadlock hardening
- `server/src/services/institutional-backup.ts`

### 3.6 Hermes Adapter Fix
- `ui/src/adapters/hermes-local/index.ts` — restore `listSkills` / `syncSkills`

### 3.7 UI Integration (QSL Review)
- `ui/src/App.tsx` — route registration
- `ui/src/components/Sidebar.tsx` — navigation entry
- `ui/src/lib/company-routes.ts` — route mapping
- `ui/src/lib/queryKeys.ts` — query keys

## 4. Upstream Evolution Since Divergence (798 commits)

Verified upstream at `6ec059ab4` successfully:
- Booted clean embedded PostgreSQL (172 migrations)
- Started API on `127.0.0.1:3100`
- Passed `/api/health`
- Initialized plugin workers and schedulers
- Created scheduled DB backups

The 798-commit delta is too large for manual review. Key upstream themes observed from recent commits:
- AuthZ governance (agent inbox archive access)
- Recovery throttling and quota reset handling
- Inbox archive agent policies
- Continued UI polish, runtime hardening, plugin system maturation

## 5. Divergence Assessment

| Factor | Assessment |
|--------|------------|
| Age of divergence | Several months (exact date of merge-base not tracked, but 798 commits implies significant drift) |
| Touch overlap | Local changes touch `heartbeat.ts`, `recovery/`, `adapters/`, `ui/src/`, `schema/` — all areas under heavy upstream evolution |
| Merge conflict forecast | **High** — any merge or rebase will encounter conflicts in recovery, adapter registry, and UI routing |
| Database schema drift | Local added `qsl_findings` + review state columns; upstream added 172 migrations including inbox archive policies |
| Runtime compatibility | Local fork fails embedded PG init; upstream succeeds. This is a critical operational blocker for the local codebase |

## 6. Files Changed (master vs upstream/master)

**Code & Schema (must port or reconcile):**
- `packages/db/src/migrations/0071_qsl_findings.sql`
- `packages/db/src/migrations/0072_qsl_findings_review_states.sql`
- `packages/db/src/migrations/meta/_journal.json`
- `packages/db/src/schema/index.ts`
- `packages/db/src/schema/qsl_findings.ts`
- `packages/shared/src/types/instance.ts`
- `packages/shared/src/validators/instance.ts`
- `packages/adapters/claude-local/src/server/execute.ts`
- `packages/adapters/claude-local/src/server/parse.ts`
- `server/src/adapters/registry.ts`
- `server/src/app.ts`
- `server/src/config.ts`
- `server/src/routes/approvals.ts`
- `server/src/routes/board-export.ts`
- `server/src/routes/qsl-bridge.ts`
- `server/src/services/approvals.ts`
- `server/src/services/board-export.ts`
- `server/src/services/governance-risks-export.ts`
- `server/src/services/heartbeat.ts`
- `server/src/services/instance-settings.ts`
- `server/src/services/institutional-backup.ts`
- `server/src/services/provider-routing-policy.ts`
- `server/src/services/provider-routing.ts`
- `server/src/services/qsl-review.ts`
- `server/src/services/recovery/*`
- `server/src/__tests__/claude-local-execute.test.ts`
- `server/src/__tests__/provider-routing-policy.test.ts`
- `server/src/__tests__/provider-routing.test.ts`
- `server/src/__tests__/recovery-classifiers.test.ts`
- `server/scripts/generate-board-export.ts`
- `ui/src/App.tsx`
- `ui/src/adapters/hermes-local/index.ts`
- `ui/src/api/qsl.ts`
- `ui/src/components/Sidebar.tsx`
- `ui/src/lib/company-routes.ts`
- `ui/src/lib/queryKeys.ts`
- `ui/src/pages/QslReview.tsx`
- `.gitignore`

**Documentation & Scripts (preserve as documentation or port):**
- `architecture_changelog.md`
- `board_exports/README.md`
- `board_exports/hardening_sprint_review.md`
- `cli/src/commands/env.ts`
- `docs/GOVERNANCE_CHECKPOINT_MODEL.md`
- `docs/RUNTIME_GUARDIAN.md`
- `docs/RUNTIME_HISTORY_MODEL.md`
- `docs/RUNTIME_OPERATIONS_V4.md`
- `docs/RUNTIME_REMEDIATION_MODEL.md`
- `docs/RUNTIME_TOPOLOGY_MODEL.md`
- `docs/architecture/README.md`
- `docs/institutional-history/*`
- `docs/plans/provider-routing.md`
- `governance_risks.md`
- `liveness_report.md`
- `scripts/governance_checkpoint.py`
- `scripts/runtime_export.py`
- `scripts/runtime_guardian.py`
- `scripts/runtime_history.py`
- `scripts/runtime_remediator.py`
- `scripts/runtime_rotation.py`
- `scripts/runtime_topology_report.py`
- `templates/QSL_PAPERCLIP_CONTEXT.md`

**Untracked on audited branch (NOT in master commit history):**
- `docs/constitution/00_FOUNDATIONAL_PRINCIPLES.md`
- `docs/constitution/01_INSTITUTIONAL_INTELLIGENCE_MODEL.md`
- `docs/constitution/02_GOVERNED_DECISION_LOOP.md`
- `docs/audits/paperclip-2026-operational-review/*`
- `doc/plans/2026-07-08-thebinmap-intelligence-constitution.md`
- Various session logs and analysis reports at repo root

## 7. Critical Finding: Embedded PostgreSQL Failure

The local fork (`master`) fails during embedded PostgreSQL initialization on the same machine where upstream (`6ec059ab4`) succeeds. This makes the current local codebase **operationally non-viable** as a foundation. The safest path is to adopt upstream as the runtime foundation and port local intellectual property onto it.

---
*Report generated 2026-07-16. No mutations performed on any repository.*
