# Root-Level Markdown File Rationalization

> Read-only inventory of every root-level `.md` file. **No files moved, renamed, deleted, or committed.**
> Generated 2026-06-20 against `master` @ `bb5f60ef`.
>
> **Date column:** for git-tracked files, the date is the last commit that touched the file (`git log`). For untracked files, it is the filesystem modified time (no git history exists). Untracked files were never committed — they are local operational artifacts of the QSL/Selarix lab.
>
> **Referenced elsewhere:** count of other files (excluding `node_modules`, `.git`, `.remember`, `docs/harvest`, and the file itself) that mention the filename. Code references are called out explicitly. Note: standard GitHub files (e.g. `SECURITY.md`) are consumed by tooling/convention even at refs=0.

---

## Per-file inventory

### Tracked project files (part of the upstream/fork codebase)

| # | Filename | Apparent purpose | Last modified | Referenced elsewhere? | Duplicate? | Disposition | Confidence |
|---|---|---|---|---|---|---|---|
| 1 | `README.md` | Project landing page / product overview | 2026-04-23 (commit) | **Yes — 38** (skills, CLI, releases) | No | **KEEP** | High |
| 2 | `AGENTS.md` | Contributor + AI-agent guidance, repo invariants | 2026-04-24 (commit) | **Yes — 72** (skills, board_exports, code) | No | **KEEP** | High |
| 3 | `CONTRIBUTING.md` | Contribution guide | 2026-04-16 (commit) | **Yes — 6** (PR template, README, CLI) | No | **KEEP** | High |
| 4 | `ROADMAP.md` | Product roadmap | 2026-04-20 (commit) | **Yes — 3** (README, CONTRIBUTING, PR tmpl) | No | **KEEP** | High |
| 5 | `SECURITY.md` | Security disclosure policy (GitHub-standard) | 2026-04-10 (commit) | No (refs=0) — consumed by GitHub convention | No | **KEEP** | High |
| 6 | `adapter-plugin.md` | Adapter-plugin system documentation | 2026-03-31 (commit) | No (refs=0) | No | **KEEP** *(candidate to relocate to `doc/`)* | Medium |
| 7 | `architecture_changelog.md` | Founder's dated architecture decision log | 2026-05-12 (commit) | No (refs=0) | No | **KEEP** | High |
| 8 | `governance_risks.md` | Founder's risk register (GR-001…GR-006) | 2026-05-12 (commit) | **Yes — 2**, incl. **code** (`server/src/services/governance-risks-export.ts`) | No | **KEEP** | High |
| 9 | `liveness_report.md` | Liveness/recovery subsystem assessment | 2026-05-12 (commit) | **Yes — 1** (`board_exports/hardening_sprint_review.md`) | No | **KEEP** | High |

### Untracked operational artifacts (local QSL/Selarix lab; never committed)

| # | Filename | Apparent purpose | Last modified (fs) | Referenced elsewhere? | Duplicate? | Disposition | Confidence |
|---|---|---|---|---|---|---|---|
| 10 | `QSL_CONFIG.md` | QSL "single source of truth" config — *"ALWAYS read first"* | 2026-04-14 | **Yes — 4** (blueprint, setup, selarix-ops) | No | **KEEP** *(active config; contains infra IPs/wallets — keep local, do not publish)* | High |
| 11 | `SELARIX_CONFIG.md` | Selarix agent config (company ID, EC2, wallet) | 2026-04-03 | **Yes — 6** (board_exports/*) | No | **KEEP** *(active config; sensitive — keep local)* | High |
| 12 | `MOLTBOOK_INTEGRATION.md` | Integration **runbook** — status BROKEN (401 since 2026-04-09) | 2026-05-13 (newest untracked) | No (refs=0) | No | **KEEP** *(living runbook, still actionable; relocate to a `runbooks/`)* | Medium |
| 13 | `AWS_MARKETPLACE_RESEARCH.md` | One-time research report (Selarix → AWS Marketplace) | 2026-03-31 | No (refs=0) | No | **ARCHIVE** | High |
| 14 | `CRAWDADDY_PRELAUNCH_REPORT.md` | Point-in-time pre-launch verification report | 2026-03-30 | No (refs=0) | No | **ARCHIVE** | High |
| 15 | `EC2_STATUS_REPORT.md` | Point-in-time EC2 status snapshot | 2026-04-14 | No (refs=0) | No | **ARCHIVE** | High |
| 16 | `BLUEPRINT_DEPLOYMENT_REPORT.md` | One-time blueprint deployment snapshot | 2026-04-03 | No (refs=0; it *references* QSL_CONFIG) | No (overlaps setup cluster) | **MERGE** → setup-history archive | Medium |
| 17 | `PAPERCLIP_ORG_SETUP_COMPLETE.md` | One-time QSL org setup completion report | 2026-04-14 | No (refs=0) | No (overlaps setup cluster) | **MERGE** → setup-history archive | Medium |
| 18 | `SELARIX_OPS_SETUP.md` | One-time Selarix Paperclip setup report | 2026-03-30 | No (refs=0) | No (overlaps setup cluster) | **MERGE** → setup-history archive | Medium |
| 19 | `SECURITY_DIVISION_REPORT.md` | One-time Selarix security-division deployment report | 2026-03-31 | No (refs=0) | No (overlaps setup cluster) | **MERGE** → setup-history archive | Medium |
| 20 | `CONTENT_DRAFTS.md` | Draft LinkedIn/social content (CrawDaddy) | 2026-03-30 | **Yes — 1** (CONTENT_PIPELINE_REPORT) | No (overlaps content cluster) | **MERGE** → content archive | Medium |
| 21 | `CONTENT_LOG.md` | Log of posted content | 2026-04-03 | No (refs=0) | No (overlaps content cluster) | **MERGE** → content archive | Medium |
| 22 | `CONTENT_PIPELINE_REPORT.md` | One-time content-pipeline setup report | 2026-03-30 | No (refs=0) | No (overlaps content cluster) | **MERGE** → content archive | Medium |
| 23 | `GUIDE_DRAFTS.md` | PQC guide drafts spun from a $197 paid playbook | 2026-03-31 | No (refs=0) | No | **ARCHIVE** *(verify license of source playbook before any reuse)* | Medium |

**Duplicate analysis:** No two files are byte-for-byte or near-duplicate copies. Three *thematic clusters* exist with overlapping (not duplicated) content:
- **Setup-history cluster:** #16, #17, #18, #19 — distinct one-time setup snapshots of the same QSL/Selarix bring-up.
- **Content cluster:** #20, #21, #22 — drafts, post log, and pipeline setup for the same content operation.
- **Config vs setup distinction:** `QSL_CONFIG.md`/`SELARIX_CONFIG.md` are *living config* (KEEP); the `*_SETUP_*`/`*_REPORT` files are *frozen snapshots* of how that config came to be (ARCHIVE/MERGE).

---

## 1. KEEP (9 files)

Living, referenced, or convention-required. **No action needed for retention**; two are relocation candidates.

- `README.md` — refs=38
- `AGENTS.md` — refs=72
- `CONTRIBUTING.md` — refs=6
- `ROADMAP.md` — refs=3
- `SECURITY.md` — GitHub-standard
- `adapter-plugin.md` — project doc *(relocation candidate → `doc/`)*
- `architecture_changelog.md` — living decision log
- `governance_risks.md` — **referenced by code** (`governance-risks-export.ts`)
- `liveness_report.md` — referenced by board export
- `QSL_CONFIG.md` — active "read-first" config (refs=4) *(sensitive)*
- `SELARIX_CONFIG.md` — active config (refs=6) *(sensitive)*
- `MOLTBOOK_INTEGRATION.md` — actionable runbook (broken integration to fix) *(relocation candidate → `runbooks/`)*

> Note: count is 12 entries; the two config files and the runbook are KEEP-but-relocate. Strict "leave at root, do nothing" = the 9 tracked/standard project files (#1–9). The 3 untracked KEEPs are retained-but-better-relocated.

## 2. ARCHIVE (4 files)

Stale, standalone, point-in-time reports with zero inbound references. Preserve as institutional history, out of repo root.

- `AWS_MARKETPLACE_RESEARCH.md` (2026-03-31)
- `CRAWDADDY_PRELAUNCH_REPORT.md` (2026-03-30)
- `EC2_STATUS_REPORT.md` (2026-04-14)
- `GUIDE_DRAFTS.md` (2026-03-31) — **check source-playbook license before reuse**

## 3. MERGE (7 files → 2 consolidated archives)

Overlapping thematic snapshots better consolidated than scattered.

- **→ `archive/qsl-selarix-setup-history.md`:** `BLUEPRINT_DEPLOYMENT_REPORT.md`, `PAPERCLIP_ORG_SETUP_COMPLETE.md`, `SELARIX_OPS_SETUP.md`, `SECURITY_DIVISION_REPORT.md`
- **→ `archive/content-operation.md`:** `CONTENT_DRAFTS.md`, `CONTENT_LOG.md`, `CONTENT_PIPELINE_REPORT.md`

## 4. UNKNOWN (0 files)

No files were left unclassified. Lowest-confidence calls (Medium) are the relocation/merge items where "archive vs merge" is a judgment call, not a correctness question — flagged inline above. If forced to surface the genuinely ambiguous ones:
- `MOLTBOOK_INTEGRATION.md` — keep-as-runbook vs archive-the-broken-integration depends on whether you intend to fix Moltbook. **Your call.**
- `GUIDE_DRAFTS.md` — archive vs delete depends on the licensing of the $197 source playbook it was derived from. **Verify before reuse.**

---

## Cross-cutting observations (no action taken)

1. **All 14 operational artifacts are untracked.** They are not part of the open-source project history; they are local lab outputs. This is the cleanest signal separating "project" from "your deployment."
2. **`QSL_CONFIG.md` and `SELARIX_CONFIG.md` contain infrastructure IPs and wallet addresses.** They are correctly untracked. Keep them out of any commit and out of upstream contributions.
3. **`governance_risks.md` is load-bearing** — it is read by `governance-risks-export.ts`. Do not archive it.
4. Reducing the root from 23 → 9 markdown files (move 4 to archive, merge 7 into 2, relocate 3) would make the repo root legible without losing any history.
