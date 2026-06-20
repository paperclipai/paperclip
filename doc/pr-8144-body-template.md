## Thinking Path

> - Paperclip is the open source control plane for managing AI agent companies and their heartbeat execution runs.
> - Run execution guardrails (CODA-2509) address leaked checkout locks, git index races, and lost work when agents are SIGTERM-killed during deploys.
> - Guardrails 1–4 were implemented on this branch but CI blocked merge: TS2741 on required `runReconciler` config and a stale-checkout 409 regression in `issues-service.test.ts`.
> - The `runReconciler` field was added to `PaperclipConfig` as required without updating all construction sites; making it optional with defaults fixes TS2741 without weakening runtime behavior.
> - Stale-checkout adoption must remain allowed when the prior run is terminal, while live-run concurrency protection stays intact.
> - This pull request rebases onto upstream master, resolves merge conflicts, and completes the PR template gates so CI can go green.

## Linked Issues or Issue Description

No public GitHub issue — inline bug description for run-execution guardrails (CODA-2509 internal):

### What happened

Concurrent agent runs on a shared git checkout caused index races, leaked checkout locks after SIGTERM, and lost uncommitted work when agents were killed during deploys.

### Expected behavior

Each run should have isolated workspace state (or a single active run lock), stale terminal runs should release checkout locks, and dirty working trees should be autosaved before detach.

### Steps to reproduce

1. Start two concurrent heartbeat runs on the same execution workspace checkout.
2. SIGTERM one run before it commits.
3. Observe duplicate resume child issues, 409 checkout conflicts, or lost edits.

### Paperclip version

Branch `fix/coda-2526-guardrails-1-4` rebased onto upstream master.

## What Changed

- **Guardrail 1:** Stop resume spawner on SIGTERM/detach-before-commit (`run-liveness-continuations.ts`).
- **Guardrail 2:** Run-scoped worktrees + active-run lock to prevent git index races (`workspace-realization.ts`, `issues.ts`).
- **Guardrail 3:** WIP autosave commit on SIGTERM within grace period (`adapter-utils/server-utils.ts`, `claude-local/execute.ts`).
- **Guardrail 4:** JDK8/Maven auto-provision for pom.xml workspaces (`scripts/provision-jdk8-maven.sh`).
- **CODA-2555 CI fixes:** Make `runReconciler` optional in `PaperclipConfig`; fix stale-checkout adoption in `clearExecutionRunIfTerminal` without weakening live-run lock.
- **Review fixes:** Greptile P1 timeout reduction, timing-safe metrics token comparison, Prometheus metric family grouping.
- **Rebase:** Resolved merge conflicts with upstream `master` (heartbeat imports + shared execution semantics).

## Verification

- `runReconciler` optional typing verified — no TS2741 at configure/onboard/worktree-lib construction sites.
- `issues-service.test.ts` stale-checkout adoption test passes with guardrail-2 live-run protection preserved.
- PR template gates validated locally: `check-pr-template.mjs`, `check-pr-dedup-search.mjs`, `check-pr-linked-issue.mjs`.
- Upstream CI will re-run on push (typecheck, serialized server suites, commitperclip review).

## Risks

- Worktree fallback requires git ≥ 2.5 (all supported runners satisfy this).
- JDK8 provisioning adds ~60s to first run on pom.xml workspaces (SDKMAN install; skipped when already present).
- Rebase touched shared execution paths — merge conflict resolution reviewed for import/API compatibility with upstream master.

## Model Used

Claude Sonnet 4.6 (auto) via Paperclip Cursor adapter — agent Raju, CODA-2555 heartbeat.

## Checklist

- [x] I have included a thinking path that traces from project context to this change
- [x] I have specified the model used (with version and capability details)
- [x] I have checked ROADMAP.md and confirmed this PR does not duplicate planned core work
- [x] I searched the GitHub PR list (open + recently closed) for similar PRs and confirmed this is not a duplicate
- [x] I have either (a) linked existing issues with `Fixes: #` / `Closes: #` / `Refs #` OR (b) described the issue in-PR following the relevant issue template
- [x] I have run tests locally and they pass
- [x] I have added or updated tests where applicable
- [x] I have considered and documented any risks above
- [ ] All Paperclip CI gates are green (pending re-run after this push)
- [ ] Greptile is 5/5 with no open P2s, recommendations, or follow-ups
- [ ] I will address all Greptile and reviewer comments before requesting merge
