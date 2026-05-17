# EAOS worktree / PR audit checklist

This checklist is the operational anti-orphan guard implemented in LET-335
(decision from LET-333). It exists because LET-181 stranded a full `/eaos`
shell in a local worktree with no PR while the issue was marked `done`. The
project policy already requires `executionWorkspacePolicy.branchPolicy.requirePullRequest`,
but that policy alone did not prevent the incident — humans need to actually
*run the audit* before claiming work is complete.

The audit is a read-only script: it scans worktrees, reports state, and
never deletes, resets, pushes, or modifies anything.

## When to run

Run the audit **before** any of the following claims is published:

- An implementation issue is marked `done`.
- A release branch is declared release-ready.
- Release Manager signs off on a non-deploy squash merge.
- CEO / orchestrator claims a sprint or roadmap milestone complete.
- QA Validator marks PR-ready or "all green".
- Any agent says "merged" / "live" / "on master" / "in production" for a
  user-facing route (`/eaos`, `/agent-os`, …).

If running before each of those is impractical, run it at least:

- On every CEO loop iteration that reports a `done` transition.
- Hourly during active sprint work.
- Before each daily Telegram status digest.

## How to run

```bash
# Default: scans /opt/paperclip and /opt/paperclip-worktrees, base=fork/master,
# uses `gh` and Paperclip API enrichment when the relevant tools / env vars
# are available. Pass --no-gh and/or --no-paperclip to disable them
# explicitly (e.g. when running offline or under a strict no-API policy).
node scripts/audit-worktrees.mjs

# JSON output (for ingestion into Paperclip routines / dashboards):
node scripts/audit-worktrees.mjs --json

# With Paperclip issue-status enrichment (requires a read-scope token):
# Base URL — first non-empty wins, accepted in this priority order:
#   PAPERCLIP_API_BASE_URL, PAPERCLIP_API_URL, PAPERCLIP_RUNTIME_API_URL, PAPERCLIP_BASE_URL
# Both origin-style values (https://host) and api-base values (https://host/api)
# are accepted; the script normalizes them to a single `/api/issues/:id` call.
# Token — first non-empty wins, accepted in this priority order:
#   PAPERCLIP_API_KEY, PAPERCLIP_API_TOKEN, PAPERCLIP_BEARER_TOKEN
# The token is sent only as a Bearer header — its value is never printed.
PAPERCLIP_API_BASE_URL=https://your-paperclip \
PAPERCLIP_API_KEY=<bearer> \
  node scripts/audit-worktrees.mjs

# On a Paperclip runtime host the standard injected vars work directly:
PAPERCLIP_API_URL=$PAPERCLIP_API_URL PAPERCLIP_API_KEY=$PAPERCLIP_API_KEY \
  node scripts/audit-worktrees.mjs

# Offline / no gh:
node scripts/audit-worktrees.mjs --no-gh --no-paperclip
```

Exit codes:

- `0` — all OK, or only WARN findings.
- `2` — one or more `BLOCK` findings: **stop** and reconcile before claiming
  completion / release-ready / green status.
- `1` — unexpected error.

Filenames, branches, short SHAs, and commit subjects are printed. Diffs,
file contents, secrets, tokens, and proxy strings are **never** printed.

## What the levels mean

- **OK** — one of:
  - clean worktree with an **OPEN** PR (the open PR is the current
    reconciliation path regardless of ahead/behind counts), or
  - clean worktree with a **MERGED** PR **only when fully reconciled**
    with base — i.e. `ahead=0` AND `localCommitCount=0`. A historical
    MERGED PR covers only the commits it merged; new commits added on
    top of the branch afterwards are not in master, so a clean branch
    with post-merge local commits is **not** OK (it surfaces as WARN
    or BLOCK depending on path / issue status), or
  - protected canonical worktrees (`/opt/paperclip` on `master` /
    `fork/master`) with no dirty files.
- **WARN** — dirty / ahead / no-active-PR worktree attached to an
  **active** non-final issue (in_progress / todo / in_review / blocked),
  or an issue whose status is `unknown` (no Paperclip API enrichment,
  or enrichment lookup failed). MERGED with post-merge ahead/local
  commits on a non-canonical active-issue branch also lands here:
  the merged PR is a historical reconciliation path only, and the
  post-merge advance still needs a current PR. Acceptable as
  in-flight work; not acceptable as a completion claim.
- **BLOCK** — one of:
  - dirty / ahead / no-PR worktree attached to a `done` / `cancelled`
    issue (the classic LET-181 shape) — this includes ahead-only
    post-merge divergence on a final-status issue even when the PR
    state is `MERGED`, because the historical merge did not reconcile
    the new commits, or
  - canonical `/opt/paperclip` checkout on a **non-master** branch
    ahead of `fork/master` with no **open** PR — this includes the
    `MERGED` case (post-merge divergence on the canonical live
    checkout), because a historical merged PR is not a current
    reconciliation path for commits added after the merge.

A `BLOCK` finding means useful work is stranded off the canonical branch
with no PR/merge path, or the canonical checkout itself has diverged from
master without an open PR. Either way, stop and reconcile before any
completion / release-ready / green status claim.

## Audience-specific checklists

### CEO loop (`EAOS CEO`, LET-161 loop)

- [ ] Run `node scripts/audit-worktrees.mjs` at the start of every loop
      iteration that touches `done`/release claims.
- [ ] If exit code is `2`, do **not** mark the corresponding implementation
      issue `done`. Open a reconciliation issue (or comment on the source
      issue) naming: the worktree path, branch, short HEAD, ahead/behind,
      and inferred issue id, then request the assignee to either open a
      PR or explicitly archive the worktree with a recorded reason.
- [ ] Do not include any audit output (raw or summarized) in Telegram or
      external channels without confirming it carries no secrets — the
      script emits filenames and short SHAs only, but always re-read
      before sending.

### Release Manager

- [ ] Before approving any non-deploy squash merge, run the audit and
      confirm exit code `0` (or that all WARN findings are unrelated to
      the PR under review).
- [ ] Before declaring a release branch release-ready, confirm the
      release branch worktree is `OK`, and that `master`/`fork/master`
      is not flagged with dirty files.
- [ ] If `master` and any active release branch diverge, ensure a tracked
      reconciliation issue exists with a named owner.

### QA Validator

- [ ] Before marking PR-ready or "all green" on an EAOS task, run the
      audit and attach the human-readable output (filenames only) as
      evidence on the PR.
- [ ] For user-facing routes (`/eaos`, `/agent-os`, …), additionally
      require route-helper / build smoke evidence. **Local preview click
      tests are not sufficient.** A PR claiming `/eaos` is shipped must
      show:
  - the route is in `master` (`git log fork/master -- ui/src/eaos`),
  - a build artifact / static smoke check exercises it,
  - the audit shows no BLOCK on the source branch.

### Reviewer (Claude Reviewer / human)

- [ ] Pull the PR branch into a fresh worktree, run the audit, and
      confirm the PR branch is the canonical home for the work.
- [ ] If the audit shows additional worktrees ahead of base on related
      branches with no PR, raise it in review — that is exactly the
      LET-181 shape.

## Route / product smoke evidence for user-facing routes

The LET-181 incident also exposed a related failure mode: a route was
clickable locally on a worktree but never reached `master`, and nobody
noticed because "I clicked it" was treated as canonical evidence.

For any user-facing route (anything under `ui/src/{eaos,agent-os,…}/`),
"done" requires **all** of:

1. Source files exist on `fork/master` (`git log fork/master -- <path>`
   shows the relevant commits).
2. Route handler / helper test or build-time check covers the route id.
3. A PR is merged (or explicitly tracked as superseded).
4. `scripts/audit-worktrees.mjs` exits **`0`** on the source branch
   (exit `2` is a BLOCK; exit `1` is a script error and must invalidate
   the claim — re-run the audit until you have a clean exit `0`). Any
   WARN findings on the source branch must be explicitly reviewed and
   noted as unrelated/in-flight in the completion evidence.
5. Optional but recommended: a route smoke (`scripts/smoke/…` or
   Playwright release-smoke) for the route id.

Local preview / click-test in a worktree is **never** by itself sufficient
to mark the issue `done`.

## Limits

- The script only sees worktrees git already knows about. Detached
  directories that are not git worktrees (e.g. `cp -r` snapshots) are
  invisible.
- `--root <path>` only narrows the **scan scope**. It never redefines
  canonicality: only `/opt/paperclip` is treated as the canonical
  checkout. Passing `--root /opt/paperclip-worktrees/<issue>` to audit a
  single PR worktree will report that worktree as non-canonical (WARN
  ceiling without issue-status enrichment), which is the intended
  behavior — scoping the audit must not let a child worktree masquerade
  as the live checkout.
- `gh` PR lookup uses the head branch name. If a PR was opened with a
  renamed branch, the lookup may return `NONE` — confirm manually before
  treating that as a BLOCK signal.
- Issue-status enrichment is optional and requires both an API base URL
  and a read-scope bearer token.
  - Base URL — first non-empty wins: `PAPERCLIP_API_BASE_URL`,
    `PAPERCLIP_API_URL`, `PAPERCLIP_RUNTIME_API_URL`, `PAPERCLIP_BASE_URL`.
    Both origin (`https://host`) and api-base (`https://host/api`) forms
    are accepted; the script normalizes the trailing `/api` so the issue
    URL is always exactly `/api/issues/:id` (never `/api/api/issues/:id`).
  - Token — first non-empty wins: `PAPERCLIP_API_KEY`,
    `PAPERCLIP_API_TOKEN`, `PAPERCLIP_BEARER_TOKEN`.
  Without these, issue status is `unknown`, all non-canonical findings
  cap at WARN, and the audit relies on git/PR signals plus the
  canonical-divergence rule to surface BLOCK conditions. To make the
  LET-181 shape (work on a branch attached to a `done` issue) escalate
  to BLOCK on this host, configure one of the supported base + token
  env vars so the script can read the issue status.

## Related

- LET-333 — decision: prevent stranded EAOS worktrees from bypassing
  `master`/live.
- LET-181 — original incident.
- `scripts/audit-worktrees.mjs` — implementation.
- `scripts/audit-worktrees.test.mjs` — classification tests including
  the LET-181 fixture.
