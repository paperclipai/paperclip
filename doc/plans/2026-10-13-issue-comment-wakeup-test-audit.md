# Issue update/comment wake-up test audit — 2026-10-13

## Scope and baseline

Owned file: `server/src/__tests__/issue-update-comment-wakeup-routes.test.ts`.
Worktree: `/private/tmp/paperclip-test-audit-pr-stack`.
Baseline HEAD: `9b4d0cd872ca1fc897f320cb181fc060f0bd5bf1` on
`codex/test-audit-r13-db-migration-passes`. The owned file is byte-identical
at `codex/test-audit-r15-onboarding-duplicates` (`568ba003a559f6a3527c36b715bbf521648518d0`).
The coordinator authorized proceeding on the shared checkout without switching branches.

## Candidate and retained owners

Delete the standalone own-run top-level comment no-wake case. The retained
`keeps $method mentions as context for $scenario` matrix's POST
`assignee_comment` case has the same run-authenticated actor, running source
run, agent assignee, and in-progress status, plus an explicitly mentioned
second agent. It checks successful comment persistence and zero wake-ups;
the PATCH counterpart preserves the other route boundary.

Delete the standalone plain-text agent-name human-owned comment no-wake case.
The matrix's POST/PATCH `human_owned` cases preserve the null agent assignee,
board user owner, in-progress status, successful comment persistence, and zero
wake-ups with a stronger explicit agent mention. The route no longer calls
`findMentionedAgents`; the plain-text fixture cannot select a distinct
mention-dispatch branch. The matrix also checks updates stay on the original issue.

No other assertions or fixtures are removed. Retained boundaries include
POST/PATCH inherited pause rejection before mutations; done/cancelled assignment
suppression; reopening with/without reassignment; normal/external assignment and
comment wake context; shared transaction identity and rollback; interrupt agent
handoff versus human handoff; structured-goal deferral and invalid status change;
PATCH comment-only wakes; Slack session preservation across reopen; explicit resume
from a completed run; review-path consumption; self/board/human/unassigned/blocked/
done/closing mention scenarios. Response-before-wake waits remain unchanged.

## Exact reduction

- Test declarations: 17 → 15.
- Expanded cases: 36 → 34 (the 15-case mention matrix stays intact).
- Test file lines: 898 → 841.
- Test diff: 0 additions, 57 deletions, net −57 lines.
- The prior approximate 61-line estimate was not used as a reduction target.

## Verification

Owner suite: **34/34 passed**, one file, 27.93 seconds (start 08:37:13). Exact PR-branch command from the repository root:
`node_modules/.bin/vitest run --project @paperclipai/server server/src/__tests__/issue-update-comment-wakeup-routes.test.ts --silent=true`.
`git diff --check` passed. Mock-backed external sync/sandbox cleanup warnings remain
non-failing; no warning-related fixture edits were made.

Sandbox execution reached all 34 cases but
could not bind Supertest's TCP listener (`listen EPERM`); this is an environment
failure before route assertions. Rerun outside the sandbox uses the existing
installed Vitest directly because pnpm's version switch could not fetch registry
signatures. No production source, other tests, staging, commits, or branch changes.
