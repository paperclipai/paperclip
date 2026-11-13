# Incremental PR CI

Goal: select existing PR suites from their inputs before allocating runners,
and reuse successful deterministic task results across pushes. Keep the current
test partitions, trusted runner admission, required checks, and full post-merge
verification.

Delivery: a reviewable PR on `codex/incremental-ci`. The planner supports
report-only, enabled, and forced-full execution. Source/configuration uncertainty
selects the full suite. Task definitions and GitHub orchestration belong to the
CI subsystem; application behavior is outside scope.

Acceptance:

| Case | Required evidence |
| --- | --- |
| UI component change | UI/browser/build coverage selected; independent Rust and server suites omitted |
| UI source read by server tests | Server suites selected |
| Shared contract, fixture, or shipped prompt | Every consuming suite selected |
| Rename or deletion | Both sides of renames and deleted inputs accounted for |
| Stack, profile request, unknown path, failed/truncated diff | Existing stack policy or full verification preserved |
| Repeated identical task inputs | Real Turbo execution restores the successful task result |
| Changed source, toolchain, environment, or command | Cache miss; failed tasks never reused |
| Required checks | Selected failures/cancellations and unexpected skips reject the PR |
| Candidate workflow | GitHub-hosted qualification runs candidate planner/cache tests before trusted master adopts it |

First feedback loop: dependency-free Node tests against real Git diffs and the
planner, then a small real Turbo cache fixture. Full required repository checks
and remote CI follow once the wiring is stable. Current server tests read select
UI files; Runner static and final Vitest lanes also execute server integration
tests. These are explicit task inputs, not inferred from package names.

Implementation: the trusted routing workflow downloads a pinned task graph and
selects matrices before runner allocation. General and serialized Vitest suites
and standalone Runner Rust tests use PR-scoped Turbo result caches. Stable
required checks validate selected and skipped jobs. Full build and
external-registry smoke tasks remain uncached because their results depend on
revision stamps or external state.

Local evidence: repository typechecking and build passed. Planner tests cover
real Git renames, missing/truncated comparisons, cross-package source reads,
trusted definition downloads, full-suite overrides, and required-check failures.
A real Turbo fixture proves execution through the existing package scripts,
result reuse and restoration, source and argument invalidation, environment
invalidation, and failed-task retries. The execution adapter keeps task aliases
out of package manifests.
The real server partition also passed through the adapter: Turbo reported
20.022 seconds for execution and 151 milliseconds for the repeated cache hit.
These are task timings, excluding wrapper and GitHub setup overhead.

The planner selects 18 jobs for `ui/src/components/Sidebar.tsx`, compared with the
existing 48. This is a job-count reduction; remote wall-clock savings have not
yet been measured. The serial local full-suite attempt was stopped after more
than 30 minutes in favor of the complete parallel GitHub suite. Remote PR checks
remain the final qualification gate. Activation follows merge because trusted PR execution
loads workflow and planner definitions from master.
