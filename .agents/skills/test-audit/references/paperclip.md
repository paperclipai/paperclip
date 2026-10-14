# Paperclip integration

This reference adapts the standalone workflow to this repository. Read root
and scoped `AGENTS.md` and their required product/development documents. Resolve
paths below from the repository root and inspect current contents; counts and
shard layouts evolve.

## Discovery and test selection

- `package.json`, `vitest.config.ts`, and package-local Vitest configurations
  describe the test projects and commands.
- `scripts/run-vitest-stable.mjs` selects and runs the default suites. Inspect
  its supported dry-run/mode/shard flags before constructing routing checks.
- `.github/workflows/pr.yml` identifies the PR workflow; follow its reusable
  workflow references to the actual lanes and shard matrix.
- `scripts/general-server-shard.mjs` and the general-server, serialized, and
  E2E duration JSON files under `scripts/` provide routing and historical cost
  clues. Read each manifest's provenance; a file's weight is not per-case time.
- Search tests colocated with production modules as well as `__tests__/`.
  Some acceptance files import other suites. Verify both direct selection and
  aliases, including package suites outside the default project list.

Example focused command, replacing the example path with the actual owner:

```sh
pnpm --filter @paperclipai/server exec vitest run src/services/OWNER.test.ts
```

`pnpm test` is the normal Vitest entry point. Browser and release-smoke suites
are opt-in; run them when affected or explicitly verifying those flows.
Follow repository requirements for a PR-ready handoff, including the full
typecheck/test/build checks when required; identify local versus CI execution
and report anything unrun. Do not rerun the entire repository on every audit
heartbeat. Test removals do not excuse required checks.

## Contracts deserving special care

Preserve company isolation, board/agent authorization, atomic checkout,
single-assignee rules, approval gates, budget hard stops, and mutation activity
logging. Persistence, idempotency, cancellation, concurrency, recovery, and
ordering often have separate owners even when test names look similar.

Distinguish first-party Telemetry, opt-in OpenTelemetry observability, and the
local run log by their paths as defined in `AGENTS.md`. A pruning task is not
permission to remove privacy, endpoint gating, or event-contract coverage.

## Environment and delivery

Database-backed tests may start real embedded Postgres even though development
can use PGlite. Check the actual fixture. An isolated install with scripts
disabled may need documented dependency setup before its binaries work.
Resource exhaustion must not be interpreted as a tested product failure or a
passing control. Coordinate heavy runs and clean up only owned resources.

Follow existing branch/worktree conventions and protect unrelated working-tree
edits. New repository audit plans/receipts belong in
`doc/plans/YYYY-MM-DD-<scope>-test-audit.md`. Prefer one concise receipt per
coherent batch or campaign. For Paperclip issue work, follow the issue's artifact
and work-product requirements rather than relying only on local paths.

When publishing is authorized, fill every section of
`.github/PULL_REQUEST_TEMPLATE.md`, including exact model information that is
actually known; do not fabricate context-window details. Use an accurate PR
title consistent with current repository policy. A deletion-only cleanup may
be a refactor and does not need a token added test to satisfy a title heuristic.

When merging is authorized, verify current-head CI and fresh repository review
results, inspect review threads and edited bot summaries, and resolve genuine
findings. After a stack merge, verify inclusion in the intended final branch
as described in [CAMPAIGN.md](../CAMPAIGN.md). No fixed check count or old
review score substitutes for inspecting the current requirements.
