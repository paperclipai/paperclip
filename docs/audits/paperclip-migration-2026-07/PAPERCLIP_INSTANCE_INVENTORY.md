# Paperclip Instance Inventory

**Sprint:** 5A — Runtime Isolation and Canonical Instance Determination  
**Date:** 2026-07-16  
**Scope:** Read-only investigation of local machine  
**Investigator:** Automated system survey  

---

## 1. Discovered Paperclip Repositories / Working Copies

| # | Path | Classification | Remote(s) | Current Branch | HEAD Commit | Clean? |
|---|------|----------------|-----------|----------------|-------------|--------|
| 1 | `C:\Users\mikeb\paperclip` | **CANONICAL CANDIDATE** | origin: `https://github.com/mbennett-labs/paperclip.git`<br>upstream: `https://github.com/paperclipai/paperclip.git` | `docs/paperclip-operational-audit-2026` | `e6da760d1`<br>*(docs(constitution): ratify governance principles and finalize library guide)* | **NO** — 12 uncommitted files (audit/constitution docs) |
| 2 | `C:\Users\mikeb\bittensor-qsl\paperclip` | **INACTIVE / ISOLATED** | origin: `https://github.com/mbennett-labs/quantumshield-api.git` | `docs/platform-vision` | `d29f83e` | **NO** — parent dir dirty |

### 1.1 Canonical Repository Detail — `C:\Users\mikeb\paperclip`

- **Branch history relative to master:**
  - Diverged from `master` at `bb5f60ef2` *(feat: add heartbeat quota-protection guardrails)*
  - Audit branch is 4 commits ahead of `master`:
    1. `eb38b6d97` — docs(audit): establish Paperclip operational architecture baseline  
       *(tag: `audit-paperclip-baseline-2026-07-15`)*
    2. `50be4d96e` — docs(constitution): ratify AI and Human Roles v1.0  
       *(tag: `constitution-03-v1.0`)*
    3. `67f68b33c` — docs(constitution): ratify Epistemic Principles v1.0  
       *(tag: `constitution-04-v1.0`)*
    4. `e6da760d1` — docs(constitution): ratify governance principles and finalize library guide  
       *(tag: `constitution-05-v1.0`, HEAD)*
- **Uncommitted files (new, not modified):**
  - `doc/plans/2026-07-08-thebinmap-intelligence-constitution.md`
  - `docs/audits/paperclip-2026-operational-review/` (9 files)
  - `docs/constitution/` (4 files)
- **Tags of note:**
  - `audit-paperclip-baseline-2026-07-15` — marks the audit baseline commit
  - `constitution-03-v1.0` through `constitution-05-v1.0` — constitution ratification chain
  - Numerous release/canary tags up to `v2026.626.0`

### 1.2 Non-Paperclip Directory — `C:\Users\mikeb\bittensor-qsl\paperclip`

- **Actual project:** `quantumshield-api` (not Paperclip)
- **Contains:** QSL/Directory Factory API codebase
- **Impact:** None on Paperclip runtime. No shared dependencies detected.

---

## 2. Other Paperclip-Artifact Directories

| Path | Type | Date | Content |
|------|------|------|---------|
| `C:\Users\mikeb\.paperclip\instances\default` | Runtime data directory | 2026-04-03 (dir), 2026-06-22 (last log) | Embedded postgres DB, backups, workspaces, company caches, server logs |
| `C:\Users\mikeb\.paperclip.zip` | Compressed backup | 2026-04-16 | Unknown contents; likely pre-instance snapshot |
| `C:\Users\mikeb\paperclip.zip` | Compressed backup | 2026-04-16 | Unknown contents; likely repo or instance snapshot |

---

## 3. Classification Summary

| Instance | Classification | Rationale |
|----------|----------------|-----------|
| `C:\Users\mikeb\paperclip` (branch `docs/paperclip-operational-audit-2026`) | **CANONICAL CANDIDATE** | This is the repository state produced by the 2026 operational audit. It is the only Paperclip source tree on the machine. |
| `C:\Users\mikeb\.paperclip\instances\default` (embedded postgres + data) | **ACTIVE CONFLICT** | Contains live production-like data for 2 companies, but schema is stale (30+ migrations behind repo), `.env` mismatched, server not currently running yet postgres is alive. |
| `C:\Users\mikeb\bittensor-qsl\paperclip` | **INACTIVE / ISOLATED** | Not Paperclip. No runtime or database overlap. |
| `.paperclip.zip` / `paperclip.zip` (2026-04-16) | **LEGACY — PRESERVE** | Historical backups. Do not delete. |
| PostgreSQL on port 54329 | **ACTIVE CONFLICT** | Database process is running but schema is incompatible with current repo code. |

---

## 4. Evidence Preservation Notes

- All filesystem metadata (timestamps, sizes) recorded above is current as of survey execution.
- `server.log` (174 MB, last write 2026-06-22) captures the complete runtime history of the active-conflict instance.
- Automatic database backups exist in `C:\Users\mikeb\.paperclip\instances\default\data\backups` (oldest observed: 2026-06-07; newest: 2026-06-22).
- No commands were issued that modified any file, process, port, or database during this survey.
