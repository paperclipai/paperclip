# Paperclip Custom UI Provenance Note

Date: 2026-07-16
Scope: Historical custom UIs referenced in operator context

---

## 1. Request Context

The operator noted that "at least two historical Paperclip-derived custom UIs also exist and must eventually be identified and evaluated." This note records the findings of a light provenance investigation.

---

## 2. Search Methodology

Searched the local filesystem under `C:\Users\mikeb` for:
- Directories named `*ui*` or `*paperclip*` at depth ≤ 2
- Git repositories with Paperclip-related history
- React/Vite project directories that might contain a forked Paperclip UI

Searched the canonical repository for:
- Evidence of external UI submodules or worktrees
- References to custom UI paths in configuration
- UI build artifacts outside `ui/dist`

---

## 3. Findings

### 3.1 Canonical UI (in-repo)

**Location:** `C:\Users\mikeb\paperclip\ui/`
**Status:** Primary UI for the fork
**Backend expected:** Local fork server (`packages/db`, `server/src`)
**Unique work:**
- QSL Review page (`ui/src/pages/QslReview.tsx`)
- QSL API client (`ui/src/api/qsl.ts`)
- Route registration for `/qsl-review`
- Navigation entry in Sidebar
- Hermes-local adapter UI fixes
- Fork QoL patches (see below)

**Evaluation:** This UI should be **ported** to the upstream-based branch, not reused as-is.

### 3.2 Upstream Test UI (disposable worktree)

**Location:** `C:\Users\mikeb\paperclip-upstream-test\ui/`
**Status:** Detached HEAD worktree of the same repo, checked out at upstream `master`
**Backend expected:** Upstream server (clean embedded PG)
**Unique work:** None — this is pristine upstream source
**Evaluation:** **SAFE TO DROP** after integration. This is a reference baseline, not a custom UI.

### 3.3 QSL selarix-lab UI

**Location:** `C:\Users\mikeb\qsl\selarix-lab\ui`
**Status:** External directory, not a git repo (no `.git` detected)
**Backend expected:** UNKNOWN — may be a standalone React project or an older UI snapshot
**Unique work:** UNKNOWN — directory exists but contents were not inspected
**Evaluation:** **UNKNOWN — REVIEW REQUIRED.** Path discovered but not explored. May contain a historical UI fork or may be an unrelated project.

### 3.4 QSL timeline-ui

**Location:** `C:\Users\mikeb\qsl\timeline-ui`
**Status:** External directory, not a git repo (no `.git` detected)
**Backend expected:** UNKNOWN
**Unique work:** UNKNOWN
**Evaluation:** **UNKNOWN — REVIEW REQUIRED.** Path discovered but not explored.

### 3.5 Other UI-like directories (ruled out)

| Path | Ruling |
|------|--------|
| `C:\Users\mikeb\bittensor-qsl\paperclip` | Appears to be a `paperclip` skills/config directory for bittensor project, not a UI. |
| `C:\Users\mikeb\cmsc495-capstone\project-artifacts\user-guide` | Capstone user guide, not a Paperclip UI. |
| Various `node_modules` and `build` dirs | Build artifacts, not source UIs. |

---

## 4. Fork QoL Patches (Documented in AGENTS.md)

The fork's `AGENTS.md` lists three UI patches that are "not in upstream":

1. **stderr_group** — amber accordion for MCP init noise in `RunTranscriptView.tsx`
2. **tool_group** — accordion for consecutive non-terminal tools (write, read, search, browser)
3. **Dashboard excerpt** — `LatestRunCard` strips markdown, shows first 3 lines/280 chars

**Evidence:**
- `stderr_group` exists in both local fork and upstream test worktree (grep confirmed). This suggests upstream may have merged the feature independently, or the patch was backported.
- `tool_group` and `Dashboard excerpt` were not explicitly grepped in the upstream test worktree.

**Evaluation:** When porting, verify whether these patches are already present in upstream. If upstream has them, no action needed. If not, they should be re-applied as discrete commits.

---

## 5. Recommendations

| UI | Recommendation |
|----|----------------|
| Canonical in-repo UI (`paperclip/ui`) | **Port selectively** to upstream-based branch |
| Upstream test worktree UI | **Archive / drop** — it's pristine upstream |
| `qsl/selarix-lab/ui` | **Light inspection required** — check if it contains unique work worth preserving |
| `qsl/timeline-ui` | **Light inspection required** — check if it contains unique work worth preserving |
| Fork QoL patches | **Verify presence in upstream** before re-applying |

---

## 6. Unknowns

- Contents of `C:\Users\mikeb\qsl\selarix-lab\ui` — not inspected
- Contents of `C:\Users\mikeb\qsl\timeline-ui` — not inspected
- Whether `tool_group` and `Dashboard excerpt` patches exist in upstream — only `stderr_group` was verified
- Whether any UI work exists in cloud/remote repositories not cloned locally

---
*Note generated 2026-07-16. No mutations performed.*
