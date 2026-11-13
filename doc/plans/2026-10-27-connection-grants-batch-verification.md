# Connection-grants batch verification

Date: 2026-10-27. Implements the
[selected design](2026-10-27-connection-grants-capability-batch.md).

## Change and authority boundary

`connectionManagementService.describeAgentInstallCapabilities` prepares a direct
saved connection once, checks its retained installation targets once, and checks
each additional candidate in order. It uses the same private target evaluator as
ordinary authorization. The grants GET replaces only its editable-agent loop.

The optimized shape is board actors, non-AI saved connections, canonical retained
and candidate IDs, and no contextual or proposed-resource selectors. Delegated
agents and
complex resources finish the first already prepared evaluation and then use the
ordinary evaluator. Preparation is not restarted. Configure/use capabilities,
grant identity filtering, audience disclosure, writes, and human continuations
retain their existing authority paths.

Reuse lasts one descriptive call. It is not an atomic snapshot: a retained
permission or target removed mid-call can leave a stale displayed choice. The
next description and actual authorization must read fresh authority. No context,
mutation authority, or reusable cache escapes the batch.

## Reproduction and measurements

Pinned baseline: `f6bc653f7f745adaafa26393852fb2f5a99256a4`.
Treatment service SHA-256:
`f5fca127e8a669d343b61455187e102dc6705d87389544ff4edfa5a066185656`.
The benchmark loads the actual baseline service from Git, verifies that its other
runtime dependencies and lockfile match, and compares it with the new production
batch. Every positional capability, reason, and operation must match.

```sh
node --import ./server/node_modules/tsx/dist/esm/index.mjs \
  scripts/benchmark-connection-install-capabilities.ts \
  --baseline-ref=f6bc653f7f745adaafa26393852fb2f5a99256a4
```

The fixture is a Cloud board member who is not the creator, with a target-scoped
grant covering the synthetic roster. Company installs retain the whole roster;
partial installs retain one quarter, with at least one retained agent. Each arm
has two warmups and five measured samples in alternating order. Counts below are
per invocation. Full positional equality passed in every iteration. Individual
SQL shapes are unchanged; the benchmark saves statement counts, parameters, rows,
and treatment `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` outside timed samples.

| Agents / installation | Old median ms (range) | Batch median ms (range) | SQL calls old → batch | Target lookups old → batch |
| --- | ---: | ---: | ---: | ---: |
| 1 / company | 5.13 (4.53–7.45) | 4.82 (4.38–5.08) | 8 → 8 | 1 → 1 |
| 1 / partial | 5.16 (4.01–5.54) | 5.26 (4.83–6.13) | 7 → 7 | 1 → 1 |
| 8 / company | 231.79 (221.63–238.96) | 31.11 (24.79–35.86) | 344 → 43 | 64 → 8 |
| 8 / partial | 128.84 (114.42–160.09) | 43.07 (39.36–45.69) | 126 → 42 | 22 → 8 |
| 32 / company | 2,804.04 (2,516.50–4,928.42) | 77.19 (75.56–132.76) | 5,216 → 163 | 1,024 → 32 |
| 32 / partial | 697.51 (676.38–732.57) | 73.92 (73.21–77.78) | 1,464 → 162 | 280 → 32 |
| 100 / company | 24,753.29 (23,849.21–25,019.72) | 246.39 (234.94–278.72) | 50,300 → 503 | 10,000 → 100 |
| 100 / partial | 6,338.58 (6,239.68–6,526.36) | 236.37 (228.40–288.54) | 13,075 → 502 | 2,575 → 100 |

At 100 agents, returned Drizzle rows fell from 60,200 to 602 for company installs
and from 15,475 to 526 for partial installs. The one-agent controls are neutral,
including a small overlapping timing regression for the partial case. The table
retains every sample range; do not extrapolate a latency curve from these medians.

The host could not start native PostgreSQL because SysV semaphore allocation
failed, including an unsandboxed low-resource initdb attempt. Local proof used
the existing test constructor seam with a scratch Docker provider: PostgreSQL
18.6 Debian/aarch64 Linux, Node 26.4.0, loopback-only networking, tmpfs storage,
and no simulated database delay. Each provider instance removed only its own
container. Existing database creation, migrations, clients, service code and
cleanup remained in use. The normal embedded package targets Darwin PostgreSQL
18.1; minor version, platform, networking, and compute differ. Defaults included
128 MiB shared buffers, 4 MiB work memory, and JIT enabled.

## Correctness evidence and limits

- Focused real-policy regressions cover scoped grants without installs, retained
  missing/denied targets, mixed and duplicate candidates, 403 versus reached
  409/500 faults, earlier denial masking an unreachable fault, forced mutation
  mode, fresh calls and reauthorization, actor/company isolation,
  deliberate within-call staleness, and ordinary fallback preparation counts.
- Real PostgreSQL differential coverage includes company and partial installs,
  empty/duplicate candidates, foreign targets, uppercase UUID comparisons,
  profile/proposed-provider fallback, and an injected SQL division-by-zero fault
  that must escape only when reached.
- The assembled grants GET compares complete old-loop and batch responses across
  creator, manager, member, viewer, inactive, and administrator fixtures. It
  verifies personal identity filtering, audience disclosure, ordered editable
  IDs, and an actual allowed install PUT followed by revocation, fresh denied
  capabilities, and a denied PUT with saved installs unchanged.
- Independent review compared the pinned and extracted ordinary evaluator in
  18 context/query/lock-order cases and 18 complete batch cases. Additional
  checks covered delegated fallback, recursive profiles/gateways/AI pools, run
  capture reuse, a succeeded-run continuation, and fresh revocation. This
  supplemental proof uses synthetic database transport, not real lock contention.

Initial test failures were incorrect fixture expectations: inactive access hides
the resource with 404, database roster order is not insertion order, and the
existing final install mutation gate requires an unscoped agent-configuration
grant. These were corrected in tests. Complete old/new GET equality passed before
these extra assertions. No product behavior was changed to satisfy them.

Final guard review also found a real defect before merge: saved target IDs are
text, and an empty saved target makes the legacy check depend on the current
candidate. An executable regression returned `[false, true]` in the original
service and `[false, false]` in the first batch. Real PostgreSQL reproduced it.
The guard now requires canonical, nonempty retained IDs as well as candidates;
unusual saved selectors keep ordinary evaluation. The fixed path matches both
the complete capabilities and a later reached infrastructure fault. No stored
target is dropped or normalized, and legacy selector semantics stay unchanged.

The bound is retained-plus-candidate target evaluations, not total CPU, SQL rows,
or endpoint latency. Scoped grant arrays and company hierarchy reads can still
grow inside each policy decision. Recursive and delegated fallback retain their
existing costs. The benchmark measures the descriptive service component;
hosted request attribution and production latency improvement remain unverified.

Local coverage contains 33 batch regressions and 83 connection-management
integration cases, using disposable Docker PostgreSQL.
The required workspace typecheck and build passed using pinned pnpm 9.15.4.
The standard full Vitest workflow was attempted, then stopped after native
database fixtures failed to initialize. A separately isolated failing native
runner case reproduced the same PostgreSQL startup failure. This is not a full
local test pass; the critical connection suites use the disposable Docker
provider described above, and the complete CI suite remains a separate gate.
Final test/CI outcomes are recorded in [PR #17945](https://github.com/paperclipai/paperclip/pull/17945); this document does not
substitute for a final-head check or deployed acceptance.
