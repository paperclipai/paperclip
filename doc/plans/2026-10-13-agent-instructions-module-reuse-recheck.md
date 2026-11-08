# Agent instruction route graph reuse recheck (2026-10-13)

Owner: `server/src/__tests__/agent-instructions-routes.test.ts`. Rechecked in `/private/tmp/paperclip-test-audit-pr-stack` at `9b4d0cd872ca1fc897f320cb181fc060f0bd5bf1` without changing its branch. The owner blob is identical to both `codex/test-audit-r15-onboarding-duplicates` at `568ba003a5` and the parent of prior candidate `0e5043c65513ac470208152dd90e0e74b6dcd022`: `4f7a65449b3d5ed70539bec18b1865e18c7648b7`.

The earlier 34-line candidate removes duplicated module setup, not duplicated endpoint executions. Applied its exact owner patch after the parent explicitly authorized this setup reduction. Test source changes by +16/-50 lines, 853 to 819 lines, net -34. Registered and expanded cases remain 24; removed executions and assertions: zero. Production files changed: zero.

`registerModuleMocks` duplicated the existing hoisted mock registrations. The existing `hoistModuleGraph` helper loads route and middleware exports once; every test still constructs a fresh app/router and HTTP server. `vi.resetAllMocks` clears implementations and once queues as well as call histories; each test's defaults are rearmed, including the secret normalization implementation formerly preserved by `clearAllMocks`. The route's hire lock map is not used by these fixtures because their actor has no run ID. The existing helper inherits the server's 30-second hook timeout, replacing the previous explicit 60-second per-case preload timeout.

The complete section from the first test declaration through the final lifecycle mock is byte-identical before and after, SHA256 `6b0b031908125729e8a135878a5d5245fa7a4137520df79ddf295c25ffcd2353`. JSON reports contain identical ordered names for all 24 expanded cases. Retained regressions cover external-root and mislabeled-managed-root instance-admin restrictions; generic patch, hire, direct creation and compatibility endpoints; own/peer read authorization; canonical revisions and forged identity/base-revision rejection; binary and empty downloads; candidate resolution scope; history/diff/restore; adapter merge/replacement and skill-selection preservation.

Full owner command, with authorized local loopback access:

```sh
node node_modules/vitest/vitest.mjs run --project @paperclipai/server server/src/__tests__/agent-instructions-routes.test.ts --reporter=json --outputFile=/private/tmp/agent-instructions-current-ARM.json
```

| Arm | Passed | Report start-to-suite-end duration |
| --- | --- | --- |
| Baseline | 24/24 | 20.816 s |
| Candidate | 24/24 | 7.268 s |
| Candidate repeat | 24/24 | 7.445 s |

These are local observations on a concurrently used host, with one baseline and no reverse-order control. They support stable candidate behavior, not a quantified performance or CI speedup claim. Two sandboxed attempts stalled at HTTP fixtures and were cancelled (exit 130); they are excluded. Existing provider-trace cleanup warnings also appeared in passing baseline and candidate runs.

Exact PR-branch rerun also passed 24/24 in 8.06 seconds with `node_modules/.bin/vitest run --project @paperclipai/server server/src/__tests__/agent-instructions-routes.test.ts --silent=true`. `git diff --check` passed. Reports: `/private/tmp/agent-instructions-current-baseline.json`, `/private/tmp/agent-instructions-current-candidate.json`, and `/private/tmp/agent-instructions-current-candidate-repeat.json`. No staging, commit, push, branch switch, or edits to other owners were performed. Repo-wide checks were not run for this narrow test-only worker handoff.
