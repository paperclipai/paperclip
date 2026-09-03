# plugin-paperclip-github v0.1 — Acceptance Evidence

Status: LANDED (2026-05-14)
Auditable by: Audit Lead (`compliance-first-ai-company`)
Hard-rule source: `doc/company-packages/compliance-first-ai-company/README.md`
Plugin source: `packages/plugins/plugin-paperclip-github/`
Design intent: `doc/plans/2026-05-14-plugin-paperclip-github-design.md`

This document is the merge-evidence checklist for v0.1. Every box is
verifiable by re-running the listed command or re-reading the listed file.

## Build evidence

- [x] `pnpm --filter @paperclipai/plugin-paperclip-github test` — 44/44
      tests pass across 7 test files (manifest, config, audit,
      tools-pr, tools-checks, tools-merge, tools-issues).
- [x] `pnpm --filter @paperclipai/plugin-paperclip-github typecheck` —
      clean, no `error TS` lines.
- [x] `pnpm --filter @paperclipai/plugin-paperclip-github build` —
      produces `dist/manifest.js` (~5 KB) and `dist/worker.js` (~540 KB
      including bundled `@octokit/*`), exit 0.
- [x] `paperclipPlugin` block in `package.json` points to those bundles,
      matching the contract `plugin-llm-wiki` uses.

## Tool surface evidence (six v0.1 tools)

| Tool | Refusal rules encoded | Source |
|------|----------------------|--------|
| `github_open_pr` | Auto-appends `Fixes #<issueId>` when body lacks issue ref; rejects missing `issueId`/`branch`/`title`/`body` | `src/tools/pr.ts:31-50` |
| `github_get_pr` | None (read-only); single GraphQL round-trip aggregates state, mergeable, mergeStateStatus, requiredChecks, failingChecks, passingChecks, reviewDecision | `src/tools/pr.ts:79-176` |
| `github_get_check_runs` | None (read-only); resolves head SHA via REST then lists checks | `src/tools/checks.ts:20-45` |
| `github_create_check_run` | `evidence_too_thin` (<200 chars details on `completed`), `missing_conclusion` (`completed` without conclusion) | `src/tools/checks.ts:58-88` |
| `github_enqueue_merge` | `merge_queue_disabled`, `pr_is_draft`, `pr_not_open`, `failing_checks`, `review_not_approved`, `enqueue_no_entry` | `src/tools/merge.ts:48-95` |
| `github_list_issues` | None (read-only); filters PRs out via `pull_request` field; caps `per_page` at 100 | `src/tools/issues.ts:24-49` |

## Audit + identity evidence

- [x] Every tool handler is wrapped by `wrapTool` (`src/audit.ts:30-69`)
      which writes one `ctx.activity.log` entry per success and per
      failure, stamped with `entityType: "github.tool"`.
- [x] `RefusalError` carries both `code` and `reason` and produces a
      `code: reason` message string (verified in `tests/audit.test.ts`).
- [x] Token authentication uses `@octokit/auth-app` with a stable
      installation strategy (`src/auth.ts:18-29`) — no PAT path exists.
- [x] All three GitHub App credentials are referenced through
      `ctx.secrets.resolve()` and never logged or persisted
      (`src/config.ts:52-71`).

## Compliance-rule integration evidence

All 12 agent definition files were updated to reference the typed tools
and to forbid shell `gh` usage:

| Agent | File | Anchor |
|-------|------|--------|
| Merge Director | `agents/merge-director/AGENTS.md:14-30` | Hard rules + Tools |
| Build Verifier | `agents/build-verifier/AGENTS.md:13-29` | Hard rules + Tools |
| Delivery Lead | `agents/delivery-lead/AGENTS.md:13-27` | Hard rules + Tools |
| Workspace Director | `agents/workspace-director/AGENTS.md:30-37` | Tools (manager — verifies `issueId` propagation only) |
| Core Engineer 1 / 2 | `agents/core-engineer-{1,2}/AGENTS.md:13-25` | Hard rules + Tools |
| Desktop Engineer 1 / 2 | `agents/desktop-engineer-{1,2}/AGENTS.md:13-25` | Hard rules + Tools |
| DJ Engineer 1 / 2 | `agents/dj-engineer-{1,2}/AGENTS.md:13-25` | Hard rules + Tools |
| Integration Engineer 1 / 2 | `agents/integration-engineer-{1,2}/AGENTS.md:13-25` | Hard rules + Tools |

The Workspace Operator + Runner Coordinator hard rules were updated
earlier in this branch with worktree-isolation + cgroup rules (see
`doc/plans/2026-05-14-wsl2-cross-compile-migration.md`).

## Operator-facing evidence

- [x] `packages/plugins/plugin-paperclip-github/README.md` documents
      the six tools, refusal codes, instance config schema, GitHub App
      provisioning steps, and build commands.
- [x] `doc/company-packages/compliance-first-ai-company/PLUGIN-GITHUB-SETUP.md`
      walks the company operator through registering the App, storing
      secrets, installing the plugin, and configuring the instance.

## What is intentionally out of v0.1

(See `2026-05-14-plugin-paperclip-github-design.md` § "Out of scope for
v0.1" for the full rationale.)

- Webhook receiver (`POST /api/plugins/.../webhook`) — Merge Director
  still polls `github_get_pr`; push-style events deferred to v0.2.
- GitHub Projects v2 / Discussions / Issue Forms parsing.
- `github_squash_merge` emergency path — refused unconditionally in v0.1.
- Code signing of plugin-opened commits — pending App-id verification.

## Sign-off

Audit Lead reviewing this file plus the four anchored sections above is
the source-of-truth audit for v0.1 acceptance. Any future change to a
hard rule (e.g. adding a new refusal code, dropping the 200-char
evidence floor) is a `paperclipai.plugin-paperclip-github` PR, not a
documentation edit.
