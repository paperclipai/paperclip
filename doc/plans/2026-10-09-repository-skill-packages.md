# Repository skill packages

Outcome: GitHub imports can preserve a complete repository while independently selecting library entrypoints. Original authored files remain unchanged. Standalone skill-directory imports remain supported. Imports do not execute setup scripts.

Branch: `codex/skill-repository-packages`, based on `origin/master` at `7333e4eba8`.

Acceptance: evaluation prose is accepted; dynamic execution checks remain; repository snapshots preserve shared references, binaries, executable files and credits through runtime copying; shared-file updates produce coherent pinned versions; invalid shared content blocks the package; the existing import dialog explains selection, files and requirements and supports inspecting both.

Implementation: one immutable, company-scoped repository snapshot is referenced by each imported skill version. Runtime projections contain a generated discovery entrypoint and the untouched tree under `.paperclip-repository/`, so all existing adapters carry the dependencies without introducing host-only symlinks. Projections may duplicate package files for multiple enabled entrypoints; the database stores each package once. Optional `paperclip.skills.json` declares version 1, public `skills` entrypoint paths and `requirements` text. It never runs installation commands.

Verification: 55 focused scanner, delivery and UI tests pass. The full workspace typecheck, full build, and direct server/UI TypeScript checks pass. Design-token gates pass. Scanning the pinned example distribution accepts all 62 skills without changing their text. A real Codex discovery probe exposes only the selected entrypoint while retaining the complete repository as supporting files.

Follow-up verification: all 12 PostgreSQL lifecycle tests pass, including company deletion and both copy APIs. The alternate create-from-existing API copies the complete runtime projection and preserves its discovery wrapper. All 163 focused runner evidence, ownership, catalog and isolation tests pass, as does the runner E2E TypeScript check. The final full workspace build and typecheck pass.

Live qualification: the opt-in `repository-skills` suite imports the private Poteto repository through the production Sources UI, selects and assigns architect and bro, disables the source connection, then invokes those skills. Independent inspections of both delivered packages match all 234 Git blobs, sizes and executable modes at commit 37d2ddde97aaef8017ccef811e682948f421062d. Native Codex tasks complete successfully on local and Daytona. Both qualifying results have complete evidence, no credential leaks and successful resource cleanup. No test manually stages the skill repository. Local campaign: local-2026-10-09T22-27-38-635Z. Daytona campaign: local-2026-10-09T22-16-10-814Z.

The location oracle recognizes both provider-home copies and the immutable bundles supplied in the active runtime context. Local ownership includes the company, agent, workspace and session from the persisted, validated execution binding. Daytona ownership includes the active company/agent/task/run sandbox lease and its native-session directory. Earlier harness failures from missing report artifacts and incorrect location checks were corrected and rerun.

The first broad test attempt was stopped when PostgreSQL-dependent suites skipped on the exhausted host. The new full `pnpm test:run` was stopped after seven failures across six test files unchanged by this PR (native session recovery, agent conversations, workspace runtime exposure, workspace dispatch, connection removal, and skill utility locking), plus 21 skipped connection-intent database cases. The recovery assertion reproduces in isolation; the failing test files are unchanged from the starting commit and the recovery fixture omits skill runtime context. The broad suite remains incomplete and is not counted as passed. Live qualification verifies import, delivery and instruction access, not every Poteto workflow or adapter.

Review: [draft PR #15731](https://github.com/paperclipai/paperclip/pull/15731). The branch is based on master and has no unrelated checkout changes.
