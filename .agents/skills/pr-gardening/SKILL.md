---
name: pr-gardening
description: >
  Discover recently referenced Paperclip pull requests, mechanically verify
  their current-head readiness, drive non-draft PRs back to green through their
  originating issues, and publish a merge-confidence report without merging.
compatibility: Requires Node.js 20+, gh authenticated for GitHub read access, and Paperclip run credentials.
allowed-tools: Bash(node:*) Bash(gh:*) Bash(curl:*)
---

# PR Gardening

Actively garden pull requests referenced by Paperclip issues active in a recent window. Candidate discovery and readiness checking are scripts, not LLM analysis. GitHub access is read-only throughout this workflow.

## Hard Guardrails

- **Never merge, approve, or close a pull request.**
- **Never instruct another person or agent to merge, approve, or close a pull request.**
- Never use mutating `gh` commands or mutating GitHub API requests. The scripts only use `gh pr view` and read-only `gh api` GET requests.
- Draft pull requests are report-only. Do not post gardening comments for drafts.
- Comment only on existing originating issues. Never create a gardening issue per pull request.
- `--dry-run` suppresses all Paperclip gardening comments. Discovery and GitHub inspection remain read-only in every mode.

## Inputs

- `--days <N>`: issue activity window, default `30`.
- `--repo <owner/repo>`: GitHub repository, default detected by `gh repo view`.
- `--dry-run`: discover, verify, and report without posting Stage C comments.
- `--cooldown-hours <N>`: repeat-comment cooldown, default `48`.
- `--max-rounds <N>`: maximum gardening rounds per PR, default `3`.

Use a run-owned directory such as `$PAPERCLIP_RUN_SCRATCH_DIR/pr-gardening` for generated files.

## Stage A — Discover Candidates

Run the extract-search path. It scans every result page, rejects truncated match sets, normalizes PR URLs, deduplicates PR numbers, records every mentioning issue, checks issue work products to identify the origin, and drops PRs that GitHub says are merged or closed.

```bash
node .agents/skills/pr-gardening/scripts/find-candidates.mjs \
  --days 30 \
  --dry-run \
  --output "$RUN_DIR/candidates.json"
```

The script calls `GET /api/companies/:companyId/search/extract` with `kind=url`, `scope=all`, and `updatedWithin=<N>d`. Do not replace it with full issue-list fetching or LLM scanning.

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

## Stage C — Comment on Originating Issues

Skip this stage in `--dry-run` mode and for `ready` or `report_only` entries.

For each `needs_gardening` PR, use `originatingIssue` from `candidates.json`. Selection priority is:

1. issue carrying the exact PR URL as a `pull_request` work product;
2. issue whose comment mentions the PR;
3. most recently active mentioning issue.

Before commenting, fetch the issue comments and search for this marker:

```text
<!-- pr-gardening:<owner/repo>#<number> -->
```

Do not comment if the latest matching marker is newer than the cooldown. Track rounds from matching markers; after three rounds, stop nagging and report `not converging; recommend close or human decision`. This is a recommendation for human disposition, not an instruction to close the PR.

When a comment is allowed, mention the originating issue assignee, instruct them to run `/prepare-pr`, include the current head SHA, and copy the exact machine-detected `reasons[]`. Use `POST /api/issues/:issueId/comments` with `X-Paperclip-Run-Id`. Include `resume: true` when the issue is terminal so the comment creates a live continuation.

Suggested body:

```markdown
<!-- pr-gardening:paperclipai/paperclip#1234 -->
@Assignee please run `/prepare-pr` for https://github.com/paperclipai/paperclip/pull/1234.

Current-head verification at `abc123` found:
- failing check: test
- Greptile missing at current head

Gardening round 1/3. Re-verification is required after changes; do not merge based on this comment.
```

## Stage D — Monitor to Termination

Set the gardening run issue's `blockedByIssueIds` to the non-terminal issues commented in Stage C so blocker resolution wakes the gardener. A scheduled or manual rerun is the fallback.

On every wake, rerun Stage B first. A PR terminates from active gardening only when one of these is mechanically observed:

- verified `ready` at the current head;
- merged or closed externally;
- maximum rounds reached, reported as not converging.

Do not leave the gardening issue blocked on terminal issues. Do not poll agents or long-running sessions.

## Stage E — Render and Publish the Report

```bash
node .agents/skills/pr-gardening/scripts/render-report.mjs \
  --input "$RUN_DIR/readiness.json" \
  --output "$RUN_DIR/gardening-report.md"
```

The report groups open PRs by confidence:

- **High:** current-head checks green, no conflicts, Greptile clean, base fresh, originating issue terminal.
- **Medium:** otherwise green but base stale, review not complete, or originating issue active.
- **Low:** failing/pending checks, missing Greptile, draft/just-fixed-unverified state, or no identifiable origin.

Upload `candidates.json`, `readiness.json`, and `gardening-report.md` to the gardening issue, create/update the `gardening-report` issue document with the Markdown body, and leave a summary comment linking the artifacts. The report is the deliverable; it is never authorization to merge.

## Verification

Run focused script tests:

```bash
node --test .agents/skills/pr-gardening/scripts/pr-gardening.test.mjs
```

For a live dry run, execute Stages A, B, and E with `--dry-run`, then sanity-check named PRs only if they are still open. Merged or closed examples should appear under `droppedClosedPullRequests`, not in readiness results.
