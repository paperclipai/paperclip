# Test audit: remove unreferenced Paperclip Runner test fixtures

Date: 2026-10-16
Branch: `PAP-458-nightly-test-gardening`
Base: `78b833c4958465b5e345b0e337018011b00dab72` (origin/master)
Scope: focused sweep of test-support files under `packages/paperclip-runner/test/fixtures/`.

## Removed files

| Candidate | Decision and reason | Contract | Evidence | Benefit |
| --- | --- | --- | --- | --- |
| `test/fixtures/fake-native-resume-codex-app-server.mjs` (277 lines) | Delete: orphaned fake codex app-server fixture | Nothing loads or spawns it; resume coverage runs through `fake-final-burst-codex-app-server.mjs` (server `native-session-resume.test.ts:287`) and `fake-durable-codex-app-server.mjs` (`live-session.test.ts:2192`) | Repo-wide `git grep -i "fake-native-resume"` and `"native-resume-codex"` → zero tracked references in code, docs, workflows, or path templates; sibling `.mjs` fakes are all referenced | 277 test-support LOC |
| `test/fixtures/copilot-profile-v{3,4,5,6}-identity.json` (64 lines) | Delete: orphaned versioned identity declarations | Copilot profile tests and `native-backend-factory.test.ts` exercise v7–v19 by literal path; no dynamic `copilot-profile-v${...}` path exists (only `test-fixtures/pi-acp/profile-v${version}`) | Repo-wide `git grep` per exact filename stem → zero references; `generate-acpx-profiles.mjs` pins v19 only | 64 test-support LOC |

## Retention evidence

- Reference proof: `git grep` across all tracked file types (ts/tsx/mjs/js/json/yml/toml/rs/md) for each
  removed stem returns zero external references.
- Selection proof: `packages/paperclip-runner/vitest.config.ts` include list covers
  `src/**`, `devtools/**`, `examples/**`, and two named `scripts/*.test.mjs` — never
  `test/fixtures/**`. The root server project also selects `server/src/**` only. The
  `test:typescript:prep` `node --test` list names no fixture. No workflow step executes
  files under `test/fixtures/`; the `pr-trusted.yml`/`release-verify.yml`
  `hashFiles('packages/paperclip-runner/test/fixtures/**')` occurrences are Rust
  cache-key inputs, not execution selectors (deleting files only changes that hash).
- Rust tests use their own `fake-codex-app-server` binary (`runner/crates/runner-core`),
  not these `.mjs` fixtures.
- No open or merged PR references any removed file (`gh search prs` per filename: zero
  hits). `scripts/tests/native-*-codex.mjs` opt-in checks and the three other fake
  `.mjs` servers are documented/referenced and retained.

## Validation

- Deletion-only diff: 341 test/support LOC removed, 0 production LOC, 0 docs LOC,
  0 registered test cases removed (no case existed for these files).
- Repo-wide `pnpm -r typecheck`, `pnpm test:run`, and `pnpm build` were **not** run this
  session: the removed files are unreferenced, unselected by every vitest/node-test
  include pattern, and excluded from all tsconfigs, so no compiled or executed path
  changes. No runtime CI savings are claimed; the benefit is a smaller fixture
  maintenance surface.

Model: Zhipu `z-ai/glm-5.3` via OpenRouter (Test Gardener (GLM)); context window unavailable;
shell tooling and git/GitHub search only.

Delivery: PR #16543, retitled to the `refactor(runner):` prefix because the repository
quality gate requires a test file or a `refactor:` title for test-file-less PRs — no
registered case exists for the removed fixtures. The PR body also carries the in-PR
issue description using the literal enhancement-template labels
(`What existing behavior does this improve?`, `Subsystem affected`, `Current behavior`,
`Proposed behavior`, `Reason and benefit`, `Breaking changes`, `Additional context`)
required by the same gate when no linked issue is referenced.