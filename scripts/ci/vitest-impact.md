# Vitest dependency selection experiment

The production selector is documented in `doc/DEVELOPING.md`. This probe remains
a diagnostic for the raw import graph, without the production retention rules.

This probe measures Vitest's real import graph against the current checkout.
It does not change the CI matrix or authorize skipping tests. It loads Vitest
configurations and Vite plugins, so run it in a normal test environment, never
in the trusted metadata-only routing job.

Install the workspace dependencies and prepare the same shared build outputs
used by CI:

```sh
pnpm install --frozen-lockfile
node scripts/ensure-plugin-build-deps.mjs
node --test scripts/ci/vitest-impact-report.integration.test.mjs
```

Probe a hypothetical change (the file need not actually be modified):

```sh
node scripts/ci/vitest-impact-report.mjs \
  --project @paperclipai/ui --file ui/src/pages/Inbox.tsx \
  --output /tmp/inbox-impact.json
```

Or compare a base revision with the checked-out HEAD. This requires a clean
tracked working tree. For a PR, check out the tested merge commit and supply
the event's base SHA, as the existing CI planner does:

```sh
node scripts/ci/vitest-impact-report.mjs \
  --project @paperclipai/ui --project @paperclipai/server \
  --base BASE_SHA --output /tmp/pr-impact.json
```

Every requested project is analyzed separately to bound memory usage. Imports
across package boundaries are followed within each graph, but unrequested
projects are **not assessed**. Runner's separate Vitest configurations, browser
E2E, Rust, typechecking, and builds are outside this experiment. The JSON records
selected and omitted test files, project inventory, startup and graph times,
and the comparison revisions. A failed or timed-out probe is not an empty plan.

## Initial observations

Measured on `5c807d11fa` with Vitest 5.0.3, macOS, and Node 26.4.0. These are
hypothetical single-file changes against that revision, not replays of historical
PR checkouts. CI uses Node 24 and different hardware.

| Changed file | Assessed project | Selected / total test files |
| --- | --- | ---: |
| `ui/src/pages/Inbox.tsx` | UI | 6 / 844 |
| `ui/src/components/MarkdownBody.tsx` | UI | 135 / 844 |
| `server/src/middleware/auth.ts` | Server | 45 / 1,428 |
| `server/src/services/run-failure-report.ts` | Server | 787 / 1,428 |
| `packages/shared/src/issue-references.ts` | Shared only | 5 / 96 |
| `docs/api/issues.md` | Server | 0 / 1,428 — known false negative |

Cold graph construction took 27.43 seconds for UI, 25.68 seconds for server,
and 2.79 seconds for shared. Subsequent queries on the same graph took about
0.05 seconds; fresh CI jobs must budget for cold construction. The six Inbox
files ran 81 assertions successfully in 20.92 seconds with four workers.
These figures exclude dependency installation and shared package builds.

For a local execution comparison, the complete UI project passed all 10,043
assertions in 844 files in 361.50 seconds with the same four-worker setting.
The initial Inbox graph plus selected execution took about 48 seconds, versus
six minutes for the full project. This is a local experiment, not a measured
change in GitHub CI latency. Later runs benefit from filesystem/transform caches.

The CLI's Git-diff path was also exercised against the actual `HEAD^..HEAD`
change for PR #18321. Across its eleven changed files, the server graph selected
1,138 / 1,428 files and the shared graph selected 3 / 96. Other projects were
not assessed. Broad shared/service imports can therefore preserve most of a
suite; the Inbox reduction should not be generalized to every PR.

## Why the raw graph is not yet a safe execution plan

There are concrete missing edges in this repository:

- `ui/src/pages/apps/chat/chat-ui-contract.test.ts` reads `Inbox.tsx` through
  `readFileSync`. It is absent from the six-file selection even though changes
  to Inbox can break its assertions.
- `server/src/__tests__/paperclip-skill-utils.test.ts` reads `docs/api/issues.md`
  through `fs.readFile`. Changing that document selects zero server tests.

A deliberate negative control confirmed the first missing edge: temporarily
append a comment containing `reason: "retry_failed_run"` to `Inbox.tsx`, which
violates the contract test's source assertion without changing runtime behavior.
The fresh graph still selected six files. Running those six plus the omitted
contract produced six passing files and exactly one failing assertion, in
`chat-ui-contract.test.ts` (92 assertions passed, one failed). The original source
was restored immediately afterward. The full baseline had passed this contract.

The integration test uses actual Vitest graph traversal to verify transitive
imports, aliases, literal dynamic imports, direct test edits, and the missing
filesystem edge. Test modules deliberately throw if executed: graph discovery
must not execute the tests. Passing this test documents the limitation; it does
not prove that skipped repository tests are irrelevant.

A production rollout needs explicit dependencies or an always-run lane for
filesystem/subprocess contract tests; broad fallbacks for configuration, setup,
lockfiles, deleted files, unknown inputs, and selector failures; and comparison
against full-suite failures. Source-only changes also need those protections:
the Inbox example is not a documentation-only edge case. Once qualified, compute
the selected test list before constructing the matrix and partition that list,
preserving the existing serialized, chat, and native-runner ownership rules.

Verification for this experiment covers the real-graph integration test, CLI
probes, the complete UI project, and the deliberate negative control. Repository
wide typechecking, build, server execution, and the complete `test:run` suite
were not run; this is a report-only experiment, not a production CI rollout.
