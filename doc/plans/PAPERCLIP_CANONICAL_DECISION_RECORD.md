# READ THIS FIRST

This document is the canonical architectural decision record for Paperclip.

Before making implementation decisions, also review:

1. `PRE_PORT_BASELINE_2026-07-16.md`
2. `PAPERCLIP_UPSTREAM_INTEGRATION_PLAN_2026-07-16.md`

Do not contradict this document without recording a new architectural decision.

---

# Paperclip Canonical Decision Record

**Status:** Approved

**Last Updated:** 2026-07-16

---

## Canonical Repository

`C:\Users\mikeb\paperclip`

- Current branch: `docs/paperclip-operational-audit-2026`
- HEAD commit: `e6da760d15fbed89480b952dd74531460986a40e`
- Remotes: `origin` (mbennett-labs fork), `upstream` (paperclipai/paperclip)

---

## Canonical Runtime

**Current upstream Paperclip runtime.**

Verified operational on 2026-07-16 at upstream commit `6ec059ab4eb36faa3ad62c915095916c80829c1b`:
- Embedded PostgreSQL initialized successfully
- 172 migrations applied cleanly
- API served on `127.0.0.1:3100`
- `/api/health` returned `ok`, `authReady: true`, `bootstrapStatus: ready`
- Scheduler and automatic backups operational

The local fork's runtime path is **deprecated** for new development.

---

## Canonical Database Policy

- **Legacy databases are preserved.**
- **No automatic migration** of legacy data to new instances.
- **All new development** uses clean upstream instances.
- Legacy backup verified: `C:\Users\mikeb\.paperclip\instances\default-backup-20260716-104332` (1.27 GB, 25,066 files).

---

## Legacy Runtime Policy

- **Archive only.**
- No further runtime repair work unless new evidence appears.
- Legacy instance directory (`default`) must not be started or migrated.
- Stale `postmaster.pid` renamed; `.env` neutralized as `.env.legacy`.

---

## Integration Strategy

- **Current upstream is the engineering foundation.**
- Selective porting of QSL-specific functionality.
- **No large merge.**
- **No large rebase.**
- New branch `feat/qsl-upstream-integration` to be created from `upstream/master` when approved.

---

## Assets To Preserve

- QSL integrations (`qsl_findings` schema, review service, bridge)
- Board intelligence export system
- Governance documents (`docs/constitution/`, audit artifacts)
- Python guardian scripts (`scripts/governance_checkpoint.py`, `runtime_*.py`)
- QSL agent context templates (`templates/QSL_PAPERCLIP_CONTEXT.md`)
- Fork QoL patches if not already upstream

---

## Assets Archived

- Legacy runtime (`~/.paperclip/instances/default`)
- Legacy database (PostgreSQL data dir, 56 MB)
- Historical embedded PostgreSQL configuration (`config.json` from legacy instance)
- `.env.legacy` (secrets preserved but not loaded)

---

## Current Engineering Direction

**UPSTREAM-BASED PORT**

---

## Rollback Strategy

- Legacy runtime remains untouched.
- Verified backup: `default-backup-20260716-104332`
- Any failed integration branch can be discarded; no legacy state is modified.
- Rollback to pre-integration state: `git checkout docs/paperclip-operational-audit-2026`

---

## Current Phase

- **Phase 0** (Investigation & Planning): **Complete**
- **Phase 1** (Upstream branch creation & verification): **Pending Operator Approval**

---

*This document is updated only when a major architectural decision changes. Future sessions should read this first.*
