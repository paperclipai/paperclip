# Root-Level Markdown File — Move/Archive/Merge Execution Plan

> **PLAN ONLY. Nothing has been moved, renamed, deleted, merged, or committed.**
> Generated 2026-06-20 against `master` @ `bb5f60ef`. Derived from `ROOT_FILE_RATIONALIZATION.md`.
>
> Execute manually later, in order. Verify the "references" finding still holds before running (it was confirmed at plan time).

---

## 0. Key facts that shape this plan

- **Every file proposed for archive/merge/relocate is UNTRACKED** (never committed). → All moves use plain `mv`, **not** `git mv`. There is no git history to preserve and no commit needed.
- **No external file references any file being moved.** Confirmed at plan time via repo-wide grep (excluding `node_modules`, `.git`, `.remember`, `docs`). → **No inbound-reference updates are required for any move.**
  - Sole cross-reference: `CONTENT_DRAFTS.md` ← `CONTENT_PIPELINE_REPORT.md`. Both are sources of the *same* merge target, so the reference becomes internal to the merged file. No edit needed.
- **`QSL_CONFIG.md` (refs=4) and `SELARIX_CONFIG.md` (refs=6) are NOT moved** — they are active "read-first" configs with live inbound references and hard-coded path expectations. Moving them would break references and agent workflows. They stay at root.
- **`adapter-plugin.md` is NOT moved** — although flagged as a relocation candidate, it is tracked upstream content; relocating it would diverge from upstream for no functional gain. Kept in place.
- Three destination directories do not yet exist and would be created by the plan:
  `docs/archive/`, `docs/runbooks/`, and (for merges) `docs/archive/` is reused.

---

## 1. Directory creation (prerequisite step)

```sh
cd /c/Users/mikeb/paperclip
mkdir -p docs/archive
mkdir -p docs/runbooks
```
Rollback: `rmdir docs/archive docs/runbooks` (only if empty).

---

## 2. RELOCATE (1 file)

| Current path | Proposed destination | Action | Tracked? | mv type | Inbound refs to update | Rollback |
|---|---|---|---|---|---|---|
| `MOLTBOOK_INTEGRATION.md` | `docs/runbooks/MOLTBOOK_INTEGRATION.md` | relocate | Untracked | `mv` | None (refs=0) | `mv docs/runbooks/MOLTBOOK_INTEGRATION.md ./MOLTBOOK_INTEGRATION.md` |

```sh
mv MOLTBOOK_INTEGRATION.md docs/runbooks/MOLTBOOK_INTEGRATION.md
```
Rationale: living runbook (broken-integration tracker), kept but moved out of root.

---

## 3. ARCHIVE (4 files)

Stale, standalone, point-in-time reports with zero inbound references. Preserve as history.

| Current path | Proposed destination | Action | Tracked? | mv type | Inbound refs to update | Rollback |
|---|---|---|---|---|---|---|
| `AWS_MARKETPLACE_RESEARCH.md` | `docs/archive/AWS_MARKETPLACE_RESEARCH.md` | archive | Untracked | `mv` | None | `mv docs/archive/AWS_MARKETPLACE_RESEARCH.md ./AWS_MARKETPLACE_RESEARCH.md` |
| `CRAWDADDY_PRELAUNCH_REPORT.md` | `docs/archive/CRAWDADDY_PRELAUNCH_REPORT.md` | archive | Untracked | `mv` | None | `mv docs/archive/CRAWDADDY_PRELAUNCH_REPORT.md ./CRAWDADDY_PRELAUNCH_REPORT.md` |
| `EC2_STATUS_REPORT.md` | `docs/archive/EC2_STATUS_REPORT.md` | archive | Untracked | `mv` | None | `mv docs/archive/EC2_STATUS_REPORT.md ./EC2_STATUS_REPORT.md` |
| `GUIDE_DRAFTS.md` | `docs/archive/GUIDE_DRAFTS.md` | archive | Untracked | `mv` | None | `mv docs/archive/GUIDE_DRAFTS.md ./GUIDE_DRAFTS.md` |

```sh
mv AWS_MARKETPLACE_RESEARCH.md   docs/archive/AWS_MARKETPLACE_RESEARCH.md
mv CRAWDADDY_PRELAUNCH_REPORT.md docs/archive/CRAWDADDY_PRELAUNCH_REPORT.md
mv EC2_STATUS_REPORT.md          docs/archive/EC2_STATUS_REPORT.md
mv GUIDE_DRAFTS.md               docs/archive/GUIDE_DRAFTS.md
```
> Note on `GUIDE_DRAFTS.md`: derived from a $197 paid playbook — verify source licensing before any *reuse* (archiving the local copy is fine).

---

## 4. MERGE (7 files → 2 consolidated documents)

> **No content is merged in this plan.** This section only specifies the target filename, the source files, what would be preserved, and the future procedure. Merging is a content-assembly step (manual or scripted), **followed** by relocating the originals into `docs/archive/originals/` (NOT deleting them).

### Merge A — QSL/Selarix setup history

- **Proposed target:** `docs/archive/qsl-selarix-setup-history.md`
- **Source files (all untracked, refs=0):**
  - `BLUEPRINT_DEPLOYMENT_REPORT.md`
  - `PAPERCLIP_ORG_SETUP_COMPLETE.md`
  - `SELARIX_OPS_SETUP.md`
  - `SECURITY_DIVISION_REPORT.md`
- **What would be preserved (verbatim, under dated `##` sections):**
  - Original date + title of each report
  - The QSL org bring-up record (company ID `839bfea4-…`, Blueprint v3.1)
  - Selarix Paperclip setup record (company ID, first-heartbeat SSH/health results, SEL-1)
  - Selarix security-division agent roster (WatchDog, etc.)
  - All prose references to `QSL_CONFIG.md` retained as historical text (target stays at root → still valid)
- **Future procedure (do not run now):**
  ```sh
  # 1. assemble (manual editor or scripted concat with section headers) into:
  #    docs/archive/qsl-selarix-setup-history.md
  # 2. then preserve originals (do NOT delete):
  mkdir -p docs/archive/originals
  mv BLUEPRINT_DEPLOYMENT_REPORT.md   docs/archive/originals/
  mv PAPERCLIP_ORG_SETUP_COMPLETE.md  docs/archive/originals/
  mv SELARIX_OPS_SETUP.md             docs/archive/originals/
  mv SECURITY_DIVISION_REPORT.md      docs/archive/originals/
  ```
- **Rollback:**
  ```sh
  mv docs/archive/originals/BLUEPRINT_DEPLOYMENT_REPORT.md   ./
  mv docs/archive/originals/PAPERCLIP_ORG_SETUP_COMPLETE.md  ./
  mv docs/archive/originals/SELARIX_OPS_SETUP.md             ./
  mv docs/archive/originals/SECURITY_DIVISION_REPORT.md      ./
  rm docs/archive/qsl-selarix-setup-history.md   # only the newly-assembled file
  ```

### Merge B — Content operation

- **Proposed target:** `docs/archive/content-operation.md`
- **Source files (all untracked):**
  - `CONTENT_DRAFTS.md` (referenced only by `CONTENT_PIPELINE_REPORT.md` → becomes internal)
  - `CONTENT_LOG.md`
  - `CONTENT_PIPELINE_REPORT.md`
- **What would be preserved (verbatim, under dated `##` sections):**
  - Approved LinkedIn/social drafts (CrawDaddy)
  - The content post log (Telegram/Moltbook/LinkedIn channel records, dates)
  - The content-pipeline setup record (GitHub→Zapier→LinkedIn)
  - The internal DRAFTS↔PIPELINE cross-reference, now resolved within one file
- **Future procedure (do not run now):**
  ```sh
  # 1. assemble into docs/archive/content-operation.md
  # 2. then preserve originals (do NOT delete):
  mkdir -p docs/archive/originals
  mv CONTENT_DRAFTS.md          docs/archive/originals/
  mv CONTENT_LOG.md             docs/archive/originals/
  mv CONTENT_PIPELINE_REPORT.md docs/archive/originals/
  ```
- **Rollback:**
  ```sh
  mv docs/archive/originals/CONTENT_DRAFTS.md          ./
  mv docs/archive/originals/CONTENT_LOG.md             ./
  mv docs/archive/originals/CONTENT_PIPELINE_REPORT.md ./
  rm docs/archive/content-operation.md
  ```

---

## 5. KEEP — no move (listed for completeness, NO action)

| File | Tracked? | Why it stays at root |
|---|---|---|
| `README.md` | Tracked | Project landing page (refs=38) |
| `AGENTS.md` | Tracked | Contributor/agent guidance (refs=72) |
| `CONTRIBUTING.md` | Tracked | Contribution guide (refs=6) |
| `ROADMAP.md` | Tracked | Roadmap (refs=3) |
| `SECURITY.md` | Tracked | GitHub-standard location |
| `adapter-plugin.md` | Tracked | Upstream doc; relocating diverges from upstream |
| `architecture_changelog.md` | Tracked | Living decision log |
| `governance_risks.md` | Tracked | **Read by code** (`governance-risks-export.ts`) — must stay |
| `liveness_report.md` | Tracked | Referenced by board export |
| `QSL_CONFIG.md` | Untracked | Active "read-first" config; inbound refs=4; hard-coded path expectations |
| `SELARIX_CONFIG.md` | Untracked | Active config; inbound refs=6 (board_exports) |

> Plus this plan's own harvest docs under `docs/harvest/` — already in place, no action.

---

## 6. Net effect (after full execution, including future merges)

- Root `.md` count: **23 → 11** (the 9 tracked project files + 2 active configs).
- 1 relocated → `docs/runbooks/`
- 4 archived → `docs/archive/`
- 7 merged → 2 files in `docs/archive/`, originals preserved in `docs/archive/originals/`
- **0 files deleted. 0 source files edited. 0 inbound references changed. 0 commits.**

---

## 7. Full rollback (undo everything)

```sh
cd /c/Users/mikeb/paperclip
# relocate + archives
mv docs/runbooks/MOLTBOOK_INTEGRATION.md ./ 2>/dev/null
mv docs/archive/AWS_MARKETPLACE_RESEARCH.md ./ 2>/dev/null
mv docs/archive/CRAWDADDY_PRELAUNCH_REPORT.md ./ 2>/dev/null
mv docs/archive/EC2_STATUS_REPORT.md ./ 2>/dev/null
mv docs/archive/GUIDE_DRAFTS.md ./ 2>/dev/null
# merge originals
mv docs/archive/originals/*.md ./ 2>/dev/null
# remove assembled merge files + empty dirs
rm -f docs/archive/qsl-selarix-setup-history.md docs/archive/content-operation.md
rmdir docs/archive/originals docs/archive docs/runbooks 2>/dev/null
```
Because all moved files are untracked, `git` state is unaffected by any step; rollback is purely filesystem `mv`.
