# Upstream Comparison 2026-03-11

This document compares the current fork state in this repo against upstream `paperclipai/paperclip` so we can adopt upstream work selectively instead of merging blindly.

## Adoption Status

Implemented in this fork from the upstream comparison work:

- adopted directly:
  - `ad55af0` disable secure cookies for HTTP deployments
  - `9248881` strip nested Claude env vars from child processes
  - `d7b98a7` and `f4a9788` improve Windows/local adapter wrapper handling
- adopted as fork-local manual ports:
  - `f6f5fee` parent-aware issues list filtering
  - `d19ff3f` operator-facing heartbeat run summaries
  - startup/doctor ergonomics, but implemented in a fork-specific way that preserves dual-repo workflows
  - run transcript UX ideas, adapted into the existing agent detail surface
  - configuration-tab ideas, adapted while preserving explicit save semantics
  - issue-assignment QoL improvements:
    - `Me` and `No assignee` operator shortcuts
    - requester/current-user distinction in assignment menus
    - user-assignee aware new-issue dialog draft persistence and keyboard flow
  - privacy hardening ideas:
    - redact current-user identifiers and home paths in operator-visible transcript/log surfaces
    - quote generated `.env` values with special characters

Explicitly deferred:

- worktree/runtime migration train
- Gemini local adapter train
- release/e2e/smoke workflow train
- upstream inbox reshaping beyond the minimal run/transcript affordances

Explicitly rejected for now:

- wholesale upstream merge
- autosave-heavy config UX that weakens reviewability in this fork
- startup behavior that silently defaults to `~/.paperclip` when a checkout-specific runtime already exists

## Comparison Basis

- Local branch: `development` at `992342b` (`Plan full condense audit backlog`)
- Upstream branch: `upstream/master` at `6e7266e` (`Merge pull request #649 from paperclipai/fix/issue-runs-heartbeat-regressions`)
- Merge base: `c674462`

Divergence count:

- Local-only commits since merge base: `27`
- Upstream-only commits since merge base: `164`

This fork is not a clean fast-forward target. Upstream has shipped a large `0.3.0` feature train while this fork added local roadmap/health/briefings/docs work. A direct merge would overwrite or remove meaningful local work.

## Local-Only Areas We Must Preserve

These are the major fork-specific additions that do not exist upstream in their current form:

- `e1e5be5` Add roadmap governance and system health
- `6cf24ba` Add agent review handoff briefings
- `ed6764a` / `347aaef` Add executive briefings and results layer
- `28ed287` / `1761c61` / `6f079ad` workspace isolation flow in the current fork shape
- `81df213` heartbeat redaction/log-noise tuning
- `DEV-DOCS/` operating docs added in this fork

The fork also still contains app surfaces and contracts that upstream later removed or replaced:

- `records`, `knowledge`, and `briefings` routes and shared types
- roadmap aliasing and subsystem health UI/contracts
- current `start-local.mjs` wrapper

## High-Level Upstream Additions

Upstream `master` moved beyond the current fork in five broad areas:

1. Worktree and workspace-runtime support
2. Gemini local adapter support
3. Run transcript and inbox UX refinement
4. Release automation and smoke/e2e coverage
5. A long tail of bug fixes in startup, approvals, adapters, auth, issues, and UI behavior

## Recommended Adoption Strategy

Do not merge upstream wholesale.

Adopt in batches:

1. Cherry-pick low-risk bug fixes first
2. Cherry-pick release/test/tooling improvements
3. Evaluate adapter additions
4. Treat worktree/workspace-runtime as a design migration project
5. Treat transcript/inbox UI changes as a separate UI adoption project

## Batch 1: Low-Risk Fixes To Cherry-Pick First

These look high-value and relatively self-contained.

### Runtime, auth, and migration fixes

- `56aeddf` Fix dev migration prompt and embedded db:migrate
- `ad55af0` fix: disable secure cookies for HTTP deployments
- `8360b2e` fix: complete authenticated onboarding startup
- `3ec96fd` fix: complete authenticated docker onboard smoke
- `64f5c3f` Fix authenticated smoke bootstrap flow
- `01c5a6f` Unblock canary onboard smoke bootstrap
- `c672b71` Refresh bootstrap gate while setup is pending

Why it matters:

- The fork already has startup/path confusion. Migration and auth startup fixes reduce the chance of another broken local boot path.

Primary files:

- `cli/src/commands/doctor.ts`
- `cli/src/commands/run.ts`
- `packages/db/src/migrate.ts`
- `server/src/index.ts`
- `server/src/auth/better-auth.ts`
- `server/src/config.ts`

### Approvals and issue correctness

- `9c68c1b` server: make approval retries idempotent (#499)
- `a613435` Fix approvals service idempotency test
- `f6f5fee` fix: wire parentId query filter into issues list endpoint
- `d19ff3f` Fix issue run lookup and heartbeat run summaries

Why it matters:

- These are correctness fixes in core orchestration code. They are safer than the worktree train and directly improve governance reliability.

Primary files:

- `server/src/routes/issues.ts`
- `server/src/routes/approvals.ts`
- `server/src/services/approvals.ts`
- `server/src/services/heartbeat-run-summary.ts`

### Adapter hardening

- `9248881` fix(adapter-utils): strip Claude Code env vars from child processes
- `d7b98a7` fix: support Windows command wrappers for local adapters
- `f4a9788` fix: tighten Windows adapter command handling

Why it matters:

- These are platform-hardening changes with low conceptual risk.

Primary files:

- `packages/adapter-utils/src/server-utils.ts`
- local adapter execute/test files

### Asset and attachment fixes

- `dec0222` feat: make attachment content types configurable via env var
- `1959bad` fix: address review feedback — stale error message and * wildcard

Primary files:

- `server/src/routes/assets.ts`
- `server/src/attachment-types.ts`

### Logging and UI routing fixes

- `21eb904` fix(server): keep pretty logger metadata on one line
- `d62b89c` ui: add company-aware not found handling
- `b593534` Preserve issue breadcrumb source

Primary files:

- `server/src/middleware/logger.ts`
- `ui/src/pages/NotFound.tsx`
- `ui/src/lib/issueDetailBreadcrumb.ts`

## Batch 2: Release, CI, and Test Improvements

These are useful but should land after runtime correctness fixes.

### Release workflow

- `a7cfd9f` chore: formalize release workflow
- `df94c98` chore: add release preflight workflow
- `aa2b11d` feat: extend release preflight smoke options
- `30ee59c` chore: simplify release preflight workflow
- `422f57b` chore: use public-gh for manual release flow
- `632079a` chore: require frozen lockfile for releases
- `31c947b` fix: publish canaries in changesets pre mode
- `f5bf743` fix: support older git in release cleanup

### E2E and smoke coverage

- `ccd501e` feat: add Playwright e2e tests for onboarding wizard flow
- `a47ea34` feat: add committed-ref onboarding smoke script

Why it matters:

- This fork already suffered from startup-path confusion. Better smoke and e2e coverage would help catch exactly that class of issue.

## Batch 3: Adapter Expansion

### Gemini local adapter

Upstream added a full Gemini local adapter train:

- `af97259` feat(adapters): add Gemini CLI local adapter support
- `4e5f67e` feat(adapters/gemini-local): add auth detection, turn-limit handling, sandbox, and approval modes
- `ec445e4` fix(adapters/gemini-local): address PR review feedback for skills and formatting
- `8eb8b16` fix(adapters/gemini-local): downgrade missing API key to info level
- `e9fc403` fix(adapters/gemini-local): inject skills into ~/.gemini/ instead of tmpdir
- `6956dad` fix(adapters/gemini-local): address PR review feedback

Primary files:

- `packages/adapters/gemini-local/**`
- adapter registries in CLI, server, and UI

Recommendation:

- Cherry-pick as a dedicated feature batch.
- Expect conflicts in adapter registries and UI config forms, but not in the roadmap/briefings work.

## Batch 4: Worktree and Workspace Runtime

This is the biggest upstream feature area and the one most likely to conflict with the fork’s current workspace and briefing model.

### Upstream worktree train

- `0704854` Add worktree init CLI for isolated development instances
- `4a67db6` Add minimal worktree seed mode
- `83738b4` Fix worktree minimal clone startup
- `dfbb4f1` Add command-based worktree provisioning
- `deec68a` Copy seeded secrets key into worktree instances
- `93a8b55` Copy git hooks during worktree init
- `12216b5` Rebind seeded project workspaces to the current worktree
- `d9492f0` Add worktree start-point support
- `472322d` Install dependencies after creating worktree
- `80d87d3` Add paperclipai worktree:make command
- `c799fca` Add worktree-specific favicon branding

### Upstream workspace-runtime train

- `3120c72` Add worktree-aware workspace runtime support
- `b83a87f` Add project-first execution workspace policies
- `2efc3a3` Fix worktree JWT env persistence
- `f7cc292` Fix env-sensitive worktree and runtime config tests

Primary files:

- `cli/src/commands/worktree.ts`
- `cli/src/commands/worktree-lib.ts`
- `server/src/services/workspace-runtime.ts`
- `server/src/services/execution-workspace-policy.ts`
- `packages/db/src/runtime-config.ts`
- `packages/db/src/schema/workspace_runtime_services.ts`
- project and agent UI config files

Recommendation:

- Do not cherry-pick piecemeal without a short design pass.
- Upstream removed or reshaped some workspace-related models that this fork still relies on.
- This batch should be treated as an integration project, not a straight cherry-pick train.

## Batch 5: UI and Product Surface Changes

Upstream invested heavily in inbox, transcripts, configuration UX, and mobile layout.

### Runs and transcript UX

- `d3ac872` Add agent runs tab to detail page
- `87b8e21` Humanize run transcripts across run detail and live surfaces
- `6e46947` Add a run transcript UX fixture lab
- `ab2f9e9` Refine transcript chrome and labels
- `b3e71ca` Polish transcript event widgets
- `487c86f` Tighten command transcript rows and dashboard card
- `f594edd` Refine collapsed command failure styling
- `98ede67` Center collapsed command group rows
- `5e9c223` Tighten live run transcript streaming and stdout
- `e76adf6` Refine executed command row centering
- `8194132` Tighten transcript label styling

### Project and agent configuration UX

- `6186eba` Add configuration tabs to project and agent pages
- `e94ce47` Refine project and agent configuration UI
- `4b49efa` Smooth agent config save button state

### Inbox and mobile issue layout

- `d388255` Remove inbox New tab badge count
- `21d2b07` Fix inbox badge logic and landing view
- `a503d2c` Adjust inbox tab memory and badge counts
- `57dcdb5` ui: apply interface polish from design article review
- `96e03b4` Refine inbox tabs and layout
- `521b24d` Tighten recent inbox tab behavior
- `345c7f4` Remove inbox recent issues label
- `57d8d01` Align inbox badge with visible unread items
- `1f204e4` Fix issue description overflow with break-words and overflow-hidden
- `183d71e` Restore native mobile page scrolling
- `3273692` Fix markdown link dialog positioning
- `5f76d03` ui: smooth new issue submit state
- `31b5ff1` Add bottom padding to new issue description editor for iOS keyboard
- `2a7043d` GitHub-style mobile issue rows: status left column, hide priority, unread dot right
- `6e86f69` Unify issue rows with GitHub-style mobile layout across app
- `ce8fe38` Unify mobile issue row layout across issues, inbox, and dashboard
- `ba080cb` Fix stale work section overflowing on mobile in inbox

Recommendation:

- Cherry-pick only after deciding whether the fork wants upstream’s current UX direction.
- Expect conflicts in pages already changed locally (`Dashboard`, `Goals`, `AgentDetail`, `IssueDetail`, `ProjectDetail`, `Inbox`).

## What Upstream Does Not Give Us

Upstream `master` does not currently replace these fork-specific needs:

- your roadmap/governance/system-health additions
- your executive briefing/records/knowledge surfaces in their current form
- the startup safety needed for your two-repo runtime workflow
- the DEV-DOCS operating documentation added in this fork

That means the right move is not “merge upstream master.” The right move is “selectively adopt upstream commits while preserving the fork’s operating model.”

## Recommended Next Step

Start with a focused adoption branch and take only Batch 1.

Suggested first-pass cherry-pick set:

- `56aeddf`
- `9c68c1b`
- `d19ff3f`
- `f6f5fee`
- `9248881`
- `d7b98a7`
- `f4a9788`
- `dec0222`
- `ad55af0`
- `21eb904`

After the completed hardening/startup/transcript adoption work, evaluate whether to take:

- Batch 2 release/test tooling
- Batch 3 Gemini adapter
- Batch 4 worktree/runtime design migration
- Batch 5 UI polish/transcripts

## Immediate Fork-Specific Follow-Up

The fork-specific startup safety guard is now implemented and should be preserved.

Reason:

- Your actual runtime workflow depends on a pinned instance home (`PAPERCLIP_HOME=~/paperclip`).
- `pnpm start` / `pnpm dev` now preserve that invariant through `.paperclip/local-start.json`, explicit env precedence, and launch-history auditing.
- `paperclipai doctor --launch-history` is now the first diagnostic surface to use when the wrong local backend appears.

This should remain fork behavior whether or not any additional upstream commits are adopted.
