# Worktree configuration fixture audit receipt

Date: 2026-10-13
Base: `origin/codex/test-audit-r17-agent-instructions-module-reuse` at `97e65c60b665123ca51941293c70b546a74e4476` (PR #16171).
Owner: `server/src/__tests__/worktree-config.test.ts`.

## Decision and scope

Replace five repeated configuration literals with local `buildLegacyConfig` results and explicit database/server port overrides. This is test setup de-duplication. No cases, assertions, persistence calls, file writes, or environment isolation are removed. Production files are unchanged. No runtime or CI speed improvement is claimed.

The original expression ranges are 396–417, 713–757, 776–797, 833–877, and 923–967. They protect sibling port avoidance, duplicate-port rebalancing, explicit-port auth URL updates, and no-port public auth URL preservation. Each fixture retains backups enabled. The first three keep the helper's default auth URL, including port 3100, while their server port remains 3101. The last two retain their explicit auth URLs. `buildIsolatedConfig` is unsuitable here because it disables backups and derives the auth port from the server port.

The transient-home expression at original lines 602–646 remains inline and byte-identical. Its path layout is intentionally different from the other fixtures.

## Evidence

Read the full owner suite, production `worktree-config.ts`, caller references in `config.ts`/`index.ts`, the shared Vitest setup, server Vitest configuration, stable test routing, and recent owner history. The production owner performs real config/env writes, worktree port reservations, and auth URL updates. Every owner regression remains in this suite; no replacement proof or test-only production seam is needed.

The five baseline and candidate expressions were evaluated using the unchanged helper and representative root values. Their actual `JSON.stringify(value, null, 2) + "\n"` outputs were byte-identical in all five comparisons. Backup flags, auth URLs, server ports, and database ports were preserved. Masking only the five expressions and removing their five new local declarations left all remaining source bytes identical. SHA-256 of that remaining source: `7e7c4299674671b032b2a6dd3242992bae8b5e695202769e1213c19e0132d40f`.

## Validation and cost

Existing dependency directories were linked into the isolated worktree without changing shared dependency installs. Baseline finished before candidate edits.

Command: `node_modules/.bin/vitest run --project @paperclipai/server server/src/__tests__/worktree-config.test.ts --silent=true`.

- Baseline: 1 file passed, 16/16 tests passed, duration 1.47s.
- Candidate: 1 file passed, 16/16 tests passed, duration 1.43s.
- Serialized fixture comparisons: 5/5 byte-identical.
- Remaining-source comparison: identical, including the transient-home fixture.
- `git diff --check`: passed.
- Final diff review: no behavior change found outside the audited setup.

One local observation per version does not establish a timing benefit. Repository-wide typecheck, test, and build were not run locally for this bounded test-only setup change; broad PR checks remain pending. No merge-readiness claim is made.

## Counts and retained proof

Production LOC: 0 added, 0 removed. Test LOC: 20 added, 139 removed, net 119 removed. Test file: 1111 → 992 lines. Cases: 16 → 16. The receipt is documentation, counted separately from test LOC.

- repairs legacy repo-local worktree config and env files into an isolated instance
- disables backups in an otherwise isolated existing worktree config
- preserves an externally supplied PORT while repairing worktree config
- never rewrites a main-instance env when ambient worktree flags leak into the process
- does not persist runtime ports into a main-instance config when ambient worktree flags leak in
- does not adopt a .paperclip config whose own env does not declare a worktree
- avoids sibling worktree ports when repairing legacy configs
- serializes and persists cross-repo worktree port reservations
- ignores stale migrated env paths when the dev runner resolved the local config
- does not persist transient runtime home overrides over repo-local worktree env
- rebalances duplicate ports for already isolated worktree configs
- persists runtime-selected worktree ports back into explicit-port auth URLs
- does not rewrite no-port public auth URLs when persisting runtime-selected ports
- preserves top-level and nested config extensions while persisting runtime ports
- can update the in-memory config when auth URL already includes a port
- does not rewrite the in-memory config when auth URL has no explicit port
