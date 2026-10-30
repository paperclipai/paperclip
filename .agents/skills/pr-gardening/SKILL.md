---
name: pr-gardening
description: >
  Discover the pull requests this Paperclip instance opened (never community
  contributions), report what each is for and how confident we are that it is
  merge-ready, and automatically drive the non-ready ones back to green with
  /prepare-paperclip-pr — without ever merging.
compatibility: Requires Node.js 20+, gh authenticated for GitHub read access, and Paperclip run credentials.
allowed-tools: Bash(node:*) Bash(gh:*) Bash(curl:*)
---

# PR Gardening

Actively garden the pull requests **this Paperclip instance opened** that are referenced by Paperclip issues active in a recent window (default 14 days). Candidate discovery and readiness checking are scripts, not LLM analysis. GitHub access is read-only throughout this workflow.

## Scope — Our PRs Only

By default the workflow gardens only pull requests authored by this instance's GitHub identity (the `gh` authenticated login, e.g. `cryppadotta`). Community contributions and dependabot PRs are excluded mechanically by author login in Stage A and land in `droppedCommunityPullRequests`; never re-add them by hand, widen the scope only when the caller explicitly passes `--authors` or `--include-community`.

## Hard Guardrails

- **Never merge, approve, or close a pull request.**
- **Never instruct another person or agent to merge, approve, or close a pull request.**
- **Never garden, comment on, or run `/prepare-paperclip-pr` against a community PR.** Only PRs from the Stage A author allowlist are actionable.
- Never use mutating `gh` commands or mutating GitHub API requests. The scripts only use `gh pr view` and read-only `gh api` GET requests.
- Draft pull requests are report-only. Do not post gardening comments for drafts.
- Comment only on existing originating issues. Never create a gardening issue per pull request.
- `--dry-run` suppresses all Paperclip mutations, including gardening comments, prepare tasks, and inbox archives. Discovery and GitHub inspection remain read-only in every mode.

## Inputs

- `--days <N>`: activity window, default `14`. Applies to both mentioning-issue activity and the PR's own `updatedAt`; open PRs with no activity inside the window are dropped as stale.
- `--authors <logins>`: comma-separated GitHub logins whose PRs are in scope; default is the `gh` authenticated user.
- `--include-community`: disable the author filter entirely. Only on explicit caller request.
- `--repo <owner/repo>`: GitHub repository, default detected by `gh repo view`.
- `--dry-run`: discover, verify, and report without posting comments, creating prepare tasks, or archiving inbox entries.
- `--archive-inbox`: after GitHub confirms a candidate PR is merged at its current head, archive the originating issue from the responsible user's inbox in Stage D.
- `--cooldown-hours <N>`: repeat-gardening cooldown, default `48`.
- `--max-rounds <N>`: maximum gardening rounds per PR, default `3`.

Use a run-owned directory such as `$PAPERCLIP_RUN_SCRATCH_DIR/pr-gardening` for generated files.

## Stage A — Discover Candidates

Run the extract-search path. It scans every result page, normalizes PR URLs, deduplicates PR numbers, records every mentioning issue, checks issue work products to identify the origin, drops PRs that GitHub says are merged or closed, drops PRs whose author is outside the allowlist (community contributions) into `droppedCommunityPullRequests`, and drops open PRs whose own `updatedAt` is older than the window into `droppedStalePullRequests`. Issues that exceed the per-issue extract match cap (typically digest or QA issues that enumerate hundreds of PR URLs) are recorded in `source.truncatedIssues` and noted in the report instead of aborting the run.

```bash
node .agents/skills/pr-gardening/scripts/find-candidates.mjs \
  --days 14 \
  --dry-run \
  --output "$RUN_DIR/candidates.json"
```

The script calls `GET /api/companies/:companyId/search/extract` with `kind=url`, `scope=all`, and `updatedWithin=<N>d`, then resolves the author allowlist from `gh api user` unless `--authors` or `--include-community` overrides it. Do not replace it with full issue-list fetching or LLM scanning.

## Stage B — Verify Current-Head Readiness

```bash
node .agents/skills/pr-gardening/scripts/check-readiness.mjs \
  --input "$RUN_DIR/candidates.json" \
  --output "$RUN_DIR/readiness.json" \
  --dry-run
```

For every candidate, the script re-fetches the current head SHA and records:

- open/draft state and mergeability/conflicts;
- `statusCheckRollup` check-run and legacy status inventory;
- a completed Greptile check-run on the exact head, clean only for `success` or `neutral`;
- `reviewDecision`;
- commits behind the base branch.

Verdicts are `ready`, `needs_gardening`, or `report_only` for drafts. Always rerun this stage after any wake or claim that a PR was fixed. Never trust issue comments as proof of readiness.

## Follow-up Create-PR Task Deduplication

If gardening decides a branch needs a follow-up task to create a single pull request, deduplicate before creating anything.

For each branch, process one branch at a time and do this serially:

1. Search open Paperclip issues for the exact branch name with statuses `backlog`, `todo`, `in_progress`, `in_review`, and `blocked`.
2. Inspect matching issue titles, descriptions, and recent comments for an equivalent open "create PR from this branch" task for the same branch.
3. If an equivalent open task exists, reuse it: add a concise comment with the current PR/head/reason context and link it from the gardening issue or blocker list. Do not create another task.
4. Only if no equivalent open task exists, create exactly one follow-up task for that branch.

Never fan out follow-up task creation in parallel. Do not issue concurrent `POST /api/companies/:companyId/issues` calls for create-PR or prepare-PR tasks. After P1's issue-create idempotency support is available, every create-PR follow-up task creation must include `idempotencyKey: "pr-gardening:create-pr:{branch}"` and every prepare-PR task `idempotencyKey: "pr-gardening:prepare-pr:{owner/repo}#{number}"`.

## Stage C — Drive Our PRs to Ready with /prepare-paperclip-pr

Skip this stage in `--dry-run` mode and for `ready` or `report_only` entries.

Every `needs_gardening` PR here was opened by this instance (Stage A guarantees it), so do not just report — actively get it merge-ready by running the `/prepare-paperclip-pr` skill against it. Process PRs one at a time:

1. **Cooldown and rounds.** Locate the `originatingIssue` from `candidates.json` (selection priority: issue carrying the exact PR URL as a `pull_request` work product; then issue whose comment mentions the PR; then most recently active mentioning issue). Fetch its comments and search for the marker:

   ```text
   <!-- pr-gardening:<owner/repo>#<number> -->
   ```

   Skip the PR if the latest matching marker is newer than the cooldown. Track rounds from matching markers; after three rounds, stop and report `not converging; recommend close or human decision`. That is a recommendation for human disposition, not an instruction to close the PR.

2. **Deduplicate.** Search open Paperclip issues for the PR number/branch. If an equivalent open prepare-PR task already exists, reuse it with a concise status comment instead of creating another (see the deduplication section above).

3. **Run the prepare skill.** Create one focused child task per PR assigned to a coder agent (prefer CodexCoder) instructing it to run `/prepare-paperclip-pr` for that PR — include the PR URL, branch, current head SHA, and the exact machine-detected `reasons[]` from `readiness.json`. If you are the gardener and already have the PR's branch checked out in a worktree, you may run `/prepare-paperclip-pr` directly instead of delegating. Either way, the prepare work must never merge, approve, or close the PR.

4. **Leave the marker comment.** Comment on the originating issue with the marker above, the current head SHA, the copied `reasons[]`, the round counter, and a link to the prepare task. Use `POST /api/issues/:issueId/comments` with `X-Paperclip-Run-Id`. Include `resume: true` when the issue is terminal so the comment creates a live continuation.

Suggested body:

```markdown
<!-- pr-gardening:paperclipai/paperclip#1234 -->
Gardening: dispatched `/prepare-paperclip-pr` for https://github.com/paperclipai/paperclip/pull/1234 via PAP-XXXX.

Current-head verification at `abc123` found:
- failing check: test
- Greptile missing at current head

Gardening round 1/3. Re-verification is required after changes; do not merge based on this comment.
```

## Stage D — Optional Inbox Tidy-Up

Run this stage only when the caller explicitly supplied `--archive-inbox`. `--dry-run` always suppresses inbox mutations, even when `--archive-inbox` is also present. Without the flag, do not archive anything.

Stage D applies to a previously monitored candidate that transitions to merged. Rerun Stage B immediately before this stage and require GitHub to report `state: merged` for the same current head SHA recorded by that verification. Fresh Stage A discovery intentionally drops PRs that were already merged or closed.

For each qualifying candidate, archive its `originatingIssue` from the responsible user's inbox with `POST /api/issues/:issueId/inbox-archive` and an empty JSON body. Do not pass `userId`; the Paperclip API resolves the responsible user from the gardener's run context and enforces that user's inbox-agent policy. GitHub access remains read-only.

Do not archive PRs that are merely `ready`, closed without merging, draft, pending, or merged at an unverified or stale head. Never archive an originating issue while the user is still awaiting review, a decision, approval, or other action on it. If Paperclip denies the mutation because the responsible user is unresolved, inbox management is disabled, the gardener is not allowlisted, or a trust boundary applies, report the denial and continue without retrying around policy.

After a successful archive, leave a standard gardening marker comment on the originating issue that names the archived issue and merged PR:

```markdown
<!-- pr-gardening:paperclipai/paperclip#1234 -->
Inbox tidy-up: archived [PAP-310](/PAP/issues/PAP-310) from the responsible user's inbox after confirming https://github.com/paperclipai/paperclip/pull/1234 merged at current head `abc123`.

This archive is audited and reversible; later issue activity may resurface the item.
```

Use `POST /api/issues/:issueId/comments` and include `X-Paperclip-Run-Id` on both the archive and comment requests. In `--dry-run`, report the archive and marker comment that would have been written, but perform neither mutation.

## Stage E — Monitor to Termination

Set the gardening run issue's `blockedByIssueIds` to the non-terminal prepare tasks and originating issues engaged in Stage C so blocker resolution wakes the gardener. A scheduled or manual rerun is the fallback.

On every wake, rerun Stage B first. A PR terminates from active gardening only when one of these is mechanically observed:

- verified `ready` at the current head;
- merged or closed externally;
- maximum rounds reached, reported as not converging.

Do not leave the gardening issue blocked on terminal issues. Do not poll agents or long-running sessions.

## Stage F — Render and Publish the Report

```bash
node .agents/skills/pr-gardening/scripts/render-report.mjs \
  --input "$RUN_DIR/readiness.json" \
  --output "$RUN_DIR/gardening-report.md"
```

The report states the scope (authors + window), and for every open PR gives its author, a one-line purpose summary taken from the PR description, and a readiness confidence bucket:

- **High:** current-head checks green, no conflicts, Greptile clean, base fresh, originating issue terminal.
- **Medium:** otherwise green but base stale, review not complete, or originating issue active.
- **Low:** failing/pending checks, missing Greptile, draft/just-fixed-unverified state, or no identifiable origin.

If a PR's generated purpose line is empty or unhelpful, write a one-sentence description from the PR title and diff summary when publishing the report.

Upload `candidates.json`, `readiness.json`, and `gardening-report.md` to the gardening issue, create/update the `gardening-report` issue document with the Markdown body, and leave a summary comment linking the artifacts. The report is the deliverable; it is never authorization to merge.

## Verification

Run focused script tests:

```bash
node --test .agents/skills/pr-gardening/scripts/pr-gardening.test.mjs
```

For a live dry run, execute Stages A, B, and F with `--dry-run`, then sanity-check named PRs only if they are still open. Merged or closed examples should appear under `droppedClosedPullRequests`, not in readiness results, and community-authored PRs must appear only under `droppedCommunityPullRequests` — a candidate or report entry with an author outside the allowlist is a scope failure. If also exercising `--archive-inbox`, confirm the report describes the suppressed Stage D action and that no Paperclip archive or marker-comment mutation occurred.
