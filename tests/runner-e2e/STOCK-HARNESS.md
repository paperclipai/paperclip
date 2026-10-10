# Stock harness with Paperclip

This suite covers the instruction reductions tracked in the
[working checklist](../../doc/plans/2026-10-02-stock-harness-paperclip-checklist.md).
Existing context-integrity and chat evals supplied a custom QA instruction
bundle. Their passing results therefore did not qualify a hire with the tiny
production default. The new suite omits that fixture bundle and lets the public
agent-creation route materialize the shipped default.

The 2026-10-03 legacy ACP Claude repair compares only the original
`assigned-skill-explicit-invocation` cell on matched current-master sources.
Both variants carry identical bounded skill-description/staged-path delivery
and env-free session persistence. Only the historical versus reduced default
manual/shared prompts and their declared structural unit expectations differ.
The public bundle/procedure observations derive from exact admitted source
bytes (eight-word identity or the independently pinned 4,249-byte historical
manual), never a branch/environment label. Candidate absence assertions stay
intact. Independent document/task and exact-credential guards are unchanged.
All stock tasks enforce `single_attempt` in the hosted launcher; automatic
product disposition recovery still counts as actual usage. This is not a new
24-cell campaign or qualification of the frozen native-completion context.

## Coverage contract

| Change | Required deterministic evidence | Product E2E evidence |
| --- | --- | --- |
| SH-1: native Codex preserves vendor base instructions | Serialized start/resume requests from the TypeScript driver, recovery paths, runnerd transport, Runner Lab/live sessions, and Rust provider use additive developer instructions. | Real new native Codex hires execute the three journeys below. Task success alone cannot prove vendor base preservation. |
| SH-2: identity-only default hire manual | Existing public agent-creation and onboarding-asset tests cover default, custom, and CEO exceptions. | The public bundle is exactly one `AGENTS.md` containing the eight-word shipped identity, checked before provider execution and again during cleanup. |
| SH-3: reduced shared legacy task/chat defaults and resume delta | Shared prompt tests and ACPX, Codex, OpenCode, Pi, Hermes, and Cursor Cloud adapter regressions retain runtime context and exclude removed generic procedures. | Actual legacy `adapter.invoke` prompts retain fresh identity/connection guidance, omit the removed procedures, and have complete receipts for every observed run. |

`pnpm test:e2e:runner:stock-harness` runs these credential-free prerequisites,
including the Rust test. It writes JSON reports, the source SHA, a working-source
fingerprint, selected checks, test counts, and `providerCalls: 0` under
`results/stock-harness-preflight-<UTC>/`. Missing reports or required skipped
assertions fail. Unrelated native tests filtered by the name selector remain
explicitly skipped; they are not counted as executed coverage. The live launcher
runs the prerequisites automatically before loading local credentials or starting
an isolated provider instance. Its subprocess receives only allowlisted toolchain
and operating-system variables. Disposable GitHub runners may resolve Cargo
dependencies; local prerequisites retain offline Cargo execution.
The ordinary server SDK dependency builder prepares the shared/SDK outputs
needed by route tests on a cold install with lifecycle scripts disabled.

The direct Playwright path also requires the retained prerequisite receipt. It
verifies the exact checkout SHA, evaluated-source fingerprint, all requested
Vitest reports and required assertions, and the Rust result before creating a
company. Missing, stale, partial, or failed prerequisites cannot qualify a cell.
Oracle/admission calibration is itself included in the prerequisite gate.

## Checkout observations

Legacy context-integrity journeys retain `checkout-activity.json` from the public
issue activity API. Each receipt must match the exact company, issue, agent and
run. An idempotent agent checkout still records a successful route call; the
server's pre-dispatch checkout does not. Missing or mismatched evidence is
unavailable or uncomparable, never a zero. This observation leaves the original
outcome grades unchanged. It counts successful HTTP checkouts only; inspect
retained executed commands/results for failed attempts before claiming no calls.

## Live matrix

There are 24 explicit local cells: these eight existing profiles each run three
existing journeys with independently calibrated graders.

- Legacy: `legacy-codex`, `legacy-claude`, `legacy-opencode`,
  `legacy-acp-codex`, `legacy-acp-claude`.
- Native: `runner-codex`, `runner-acpx-claude`, `runner-opencode`.

| Journey | Expected provider turns | Observable outcome | Cell deadline |
| --- | --- | --- | --- |
| `assigned-skill-explicit-invocation` | 1 | Public skill creation/pinning, an explicit skill request, and saved output containing the marker available only in the skill body. | 12 minutes |
| `ordered-comment-continuation` | 2 | Initial report followed by three ordered public comments, including repeated wording and a changed scope; final saved report preserves the ledger and requested scope. | 12 minutes |
| `continuity-restart` | 3 | Task-backed chat retains the requested context across a server restart and subsequent replies. | 15 minutes |

A full matrix expects 48 provider turns. Models, credentials, effort,
permissions, assigned skills, environment, and managed secret references are
inherited from the existing profile; only its QA manual is omitted. Both company
and agent receive a 1,000-cent monthly hard stop before provider execution,
verified through public records. These limits do not predict final spend:
attempts, retries, partial runs, unknown billing, and cleanup remain in the
existing campaign accounting and qualification rules.

`stock-harness` is excluded from `--all`; select it explicitly. It has no Daytona
cells. Pending or unrepresented harnesses are not live-qualified by this matrix.
Pi/Hermes/Cursor Cloud rendering coverage is deterministic here. The separate
Codex-through-ACP base-instruction patch is still an open checklist item: its
legacy cells qualify the common prompt reduction, not vendor base preservation.

## Run and inspect

```sh
# No credentials or paid providers:
pnpm test:e2e:runner:stock-harness --list
pnpm test:e2e:runner:stock-harness
pnpm test:e2e:runner:typecheck
pnpm test:e2e:runner:unit
pnpm test:e2e:runner -- --list --suite stock-harness

# With authorization and the selected profile's required provider credential:
pnpm test:e2e:runner -- --id stock-harness.runner-codex.local.assigned-skill-explicit-invocation
```

Use an exact cell first, then expand profile/journey selections when its evidence
is understood. The ordinary launcher, isolated instance, fixture cleanup,
screenshots, attempt history, usage/cost reporting, and dashboard publisher are
unchanged. `snapshots/stock-harness-hire.json` captures the public bundle and
budgets before paid execution. `snapshots/stock-harness.json` captures the final
bundle, budgets, run IDs, actual legacy prompts, and matcher verdicts. Evidence
API failures retain an error snapshot and cannot pass. All snapshots use the
existing secret sanitizer; screenshots remain the original captured pixels.

The oracle's identity is independent of the implementation constant, so changing
the shipped manual cannot silently change the expected result. The suite
definition digest incorporates the evaluated default manual, shared prompt
implementation and connection guidance, fixture, journeys, grader, prerequisite, and execution integration
sources. Positive and plausible-negative support tests exercise
missing/malformed receipts, manual regrowth, removed startup/resume procedures,
absent connection guidance, and budget drift. Existing calibrated lifecycle
graders still own task/chat success.

The skill oracle proves the requested pinned skill's output marker reached the
saved result without appearing in the task request or follow-up comments. Skill
tool/read event detection is retained as supporting evidence; it is not a
required cross-provider tool-trace assertion.

## Qualification status

Setup was validated locally on 2026-10-02 with the deterministic prerequisites,
Product E2E support tests, typecheck, and discovery: 478 executed prerequisite
tests passed (477 TypeScript plus one Rust), along with 860 support tests and
discovery of all 24 cells. The 313 unrelated native tests filtered by the gate
are not counted as passing coverage. Local evidence is retained under
`results/stock-harness-preflight-2026-10-02T16-15-39.064Z/preflight.json`.
Earlier interrupted, discovery-failure, and setup/test-timeout attempts remain
retained; the final unchanged-assertion retry passed. No live cells or paid
providers were run during that initial setup. This establishes executable coverage, not a live reliability
result or improved coding quality. A quality claim needs comparable tasks,
models, effort, tools, and independently graded before/after results.

The suite exercises fresh isolated hires and their continuations. Existing saved
manuals and old Codex sessions are not automatically migrated. The latter still
need a provider-session reset to restore a previously replaced vendor base.
Private Runner protocol definitions remain separate: they use mock control-plane
operations and cannot substitute for this public hiring and assembled-prompt
coverage.

## GitHub qualification and matched comparison

The instruction reductions and coverage are under review in
[PR #14948](https://github.com/paperclipai/paperclip/pull/14948).
The first diagnostic native Codex skill cell
[passed on GitHub](https://github.com/paperclipai/paperclip/actions/runs/37034213743)
at `a63437069de58d22ee5adbcb6a6202c007dcf037`. All seven independent skill/task
checks passed; the provider run lasted 34.745 seconds and the cell 56.660 seconds.
Its tiny public hire bundle and budget receipts passed, and cleanup passed.
This diagnostic predates enforced prerequisite admission and the expanded source
digest, so it is retained separately from the final qualification matrix.

The first full candidate attempt at `36e987246b649927e96ce1184cd616c4e490106e`
[was cancelled during prerequisites](https://github.com/paperclipai/paperclip/actions/runs/37037105491).
Cold protected installs disable lifecycle scripts, leaving the plugin SDK unbuilt;
SH-2/SH-3 could not import it. Provider admission was not reached. This setup
failure is retained separately from behavioral results. The prerequisite now runs
the ordinary server dependency builder first, retains its output and exit status,
and refuses admission when setup fails. A cold legacy pilot must pass before the
full matrix retry.

The [fixed legacy pilot](https://github.com/paperclipai/paperclip/actions/runs/37039240025)
at `4163dbfd0fd4d145bfa52b4d7f80eb59a362ee36` passed SDK setup, hire/shared
prompt/oracle checks and the Rust additive test. It stopped before providers:
the real daemon-frame test lacked the cold `paperclip-runnerd` binary. Setup now
builds that daemon from the locked Rust source before TypeScript gates, retains
`runnerd-build.txt`, and requires both setup exits in the admission receipt.
The required daemon-frame test selects that built debug binary explicitly,
without replacing staged product binaries. The receipt records its SHA-256;
verification rejects a changed binary before provider admission.
The [next cold pilot](https://github.com/paperclipai/paperclip/actions/runs/37040493183)
at `ac6ddefb589c18fa9c30946db40e58499e9fb0e0` then found the required fake Codex
protocol fixture absent. It also stopped before paid providers. Setup uses the
package's ordinary locked workspace `--bins` build, covering both the daemon
and its fixture; verification binds both binaries to the retained receipt.

That final cold pilot passed all 537 prerequisites on GitHub and reached Claude
Sonnet 4.6. It saved a workspace `task-output.md` and completed the issue, while
the independent durable-document oracle found no Paperclip issue document.
The pinned skill's phrase "task document" does not explicitly name storage in
Paperclip; matched historical results must precede any regression attribution.
The task, instruction delivery, budget, and cleanup receipts remain retained.

Its trusted merged report rejected the prerequisite folder alongside the campaign
root and synthesized a missing-result infrastructure error. Raw packaged cell
results were uploaded and remain inspectable. Prerequisites now live under the
exact campaign root; the unchanged trusted selector contract is calibrated in
the mandatory gate. The initial full matched campaigns at `f02d8d0df` and
`12c5433c6` retain their original raw results and publication outcomes. Any
reconstructed comparison must declare directory-layout recovery and preserve
every result, hash, original failure, and assertion.

Dispatch the trusted workflow from `master`, with `target_branch` naming the
same-repository candidate and an exact cell selector first. The workflow resolves
that target once to an immutable SHA. Never dispatch target-controlled workflow
definitions with protected credentials. Protected environments, scoped provider
keys, frozen target dependencies, report sanitization, publication, and existing
bounded retry/cleanup policies retain their existing owners.

A temporary `codex/stock-harness-previous-instructions` branch compares the same
24 cells with the previous default manual and shared startup/resume prompts.
It holds merged native Codex fix #14920 constant. Only those two production
instruction sources differ. Its explicit historical structural oracle expects
the old manual and records old generic procedures; the candidate's reduction
assertions remain mandatory. Historical tests verify that prior contract.
The independent skill/context/chat journeys, behavioral graders, fixtures,
models, effort, tools, permissions, and credentials are identical. The retained
comparison manifest records their hashes and the restored instruction revision.

One full campaign per variant initially expects 48 provider turns, plus any
existing bounded automatic retries; the earlier one-cell diagnostic remains
separate. Compare behavioral results by profile and journey, with missing
evidence unqualified. Keep structural instruction differences separate from task
success. Report every attempt, failure attribution, provider timing, token usage,
reported costs and unknown spend. A reported zero subtotal is not proof of zero
provider spending. This small single-trial matrix cannot establish general coding
quality or broad performance equivalence, and does not compare #14920 before/after.

## Measured comparison and unresolved delivery

The [dated live report](../../doc/plans/2026-10-02-stock-harness-live-comparison.md)
and its safe JSON projection contain the per-profile/case comparison, exact
source hashes, all campaign and recovery links, timing/usage, cost coverage,
security failures, clipping limits and publication-layout recovery. Candidate
`f02d8d0df` has 24 retained results: 15 pass and nine fail. Historical
`12c5433c6` also has 24 retained results: 15 pass and nine fail. Its single
AWS-runner recovery timed out; original missing evidence remains recorded. Classic Claude/OpenCode skill runs save no Paperclip task document
where historical runs save one; the original oracle remains failed.

The merged native Codex change is held constant. Same aggregate success counts
would not establish equivalence: case outcomes differ, fixture storage wording
is ambiguous, ACP credential guards fail, and some public prompt receipts are
clipped. Native finish/block tool guidance belongs to native runners; legacy
document-delivery guidance must use the actual Paperclip skill/API path. No
production or skill instructions have been changed to turn the measured failures
into passes. PR #14948 remains draft.

The corrected packaging pilot at `1eb5ba420` passes on GitHub with valid
evidence and cleanup. It validates prerequisite nesting under the exact campaign
root using the unchanged trusted selector. Its current prerequisite runs 557
checks (556 TypeScript plus one Rust); all 895 E2E support tests pass. The 313
filtered native tests are not counted. Original failed/partial attempts and
publication failures remain retained; local reconstructed copies move folders
without editing results, graders or usage. Never dispatch a second development
campaign for an active target branch: workflow concurrency supersedes the older
run. Use a separate frozen-source branch when independent campaigns must overlap.

## Focused legacy delivery repair

The original 24 cells and original assigned-skill request/procedure remain unchanged. Two added explicit Paperclip-document cells apply only to classic Claude and OpenCode, making 26 catalog cells (50 expected turns if every cell is selected). The repair campaign selects only the original skill case and new document case for those two profiles: four cells per variant, eight expected turns total. No full matrix rerun is planned.

Both skill sources are recorded in definition/admission digests. The pre-fix baseline restores the old SKILL.md and records the new reference as absent, without copying the new recipe into that baseline. It holds the tiny manual/shared prompts and all fixture/model/auth/effort inputs fixed. The explicit document oracle checks actual public content/revision and an exact same-app document link, with plausible-negative calibrations.
