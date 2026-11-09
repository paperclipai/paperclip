# Native connection baseline repair — 2026-10-07

The original baseline remains **0 PASS / 15 FAIL**. It did not exercise the intended user decisions and does not qualify a production instruction reduction. This repair makes a new baseline possible; it does not change the old grades.

## Original evidence

- [Campaign 37562577199, attempt 1](https://github.com/paperclipai/paperclip/actions/runs/37562577199).
- [Original public report](https://d1p6rlowie26tp.cloudfront.net/runner-e2e/campaigns/gha-37562577199-1/index.html).
- Source and trusted workflow: `caf120105c487532db769670fcd39249483e1d99`.
- Suite hash: `d7bd6c177fe97e9cba28497555d475b545824796d33178fd0372ae21dbb06429`.
- Definition digest: `e2298d2e190448aa112167e8f2989b8d087766482af145007d86a36f8ab29830`.
- Five cases on native Codex `gpt-5.6-sol`, ACPX Claude `claude-sonnet-5`, and OpenCode `openrouter/deepseek/deepseek-v4-flash-0731`.
- One attempt per cell, 15 actual run records: 14 succeeded and one failed. No harness retries. All 15 cleanup and budget readbacks passed. A succeeded run record is not a passing behavioral grade.
- Recorded LLM cost subtotal: $0.01824843. Positive costs were reported only by the five OpenCode cells. Twelve of 15 runs had token coverage. Zero or missing Codex/Claude billing is unknown, not free; actual charges and local/hosted runtime cost are unknown.

| Cells | Observed failure | Supported diagnosis |
| --- | --- | --- |
| 10 | Browser could not find the creation-time title; renamed title and pending interaction were visible | Stale-title harness assertion, before any intended user decision |
| 2 Codex provider-choice cells | Native `request_human_input` schema denial before Paperclip execution | Rejected input; retained diagnostics omit the invalid field. Four rejections in the positive cell are calls within one run, not four paid harness attempts |
| 2 OpenCode provider-choice cells | Used the preinstalled HubSpot tool once without a choice card | Fixture had already granted real tool access. This does not prove a consent violation or disregard of a decline; no decline was sent |
| 1 Claude provider-decline cell | `native_finalization_missing: session returned no semantic result` | Native session failed before choice; retained evidence does not establish the underlying cause |

The schema accepts both canonical and legacy question forms. Conflicting native/legacy guidance is observable, but is not proven to have caused the old Codex denials. Do not infer that a corrected run explains the old Claude failure.

## Repair contract

1. Match the requested browser route and visible task identifier, then wait for the loaded conversation. Agent title changes are allowed; the wrong task still fails.
2. Configure the deterministic company Arcade gateway with zero agent installs and zero allowed tool entries. Verify public effective-access records before task creation.
3. The positive provider case requires the saved Arcade choice, followed by one real access card for the same agent, connection, selected interaction and exact HubSpot read tool. The browser grants access. The oracle requires the accepted result, exactly one provider call, and the independently observed fixture marker. The expected run count is three. Declines still require one decision, no tool calls and an attributed explanation.
4. Return a canonical `providerQuestionSet` alongside the legacy `providerQuestion`. Native guidance uses the canonical form. Both forms preserve the exact prompt and option IDs that validate saved consent.
5. Invalid native question input remains rejected before execution. Bounded feedback identifies authorized schema locations and required fields, without echoing submitted values or arbitrary keys. No schema or authorization gate is relaxed.

The historical Everyday fixture and prompts remain unchanged. The new fixture and production correctness fixes change the measured contract. Results from the new source must be reported separately; they cannot be treated as a matched comparison with the invalid original baseline.

## Validation and remaining gate

Credential-free checks pass: eval typecheck; 1,801 support tests plus 128 Node tests (one intentional support skip); 51 connection/schema tests; one real-server fixture test; one focused Rust feedback test; and local browser wrong-task/title calibration. Repository typecheck and build pass. The full local repository test run was stopped after five failures outside the changed paths; those five passed in a separate focused invocation. The full run is incomplete, not passing, and the original failures remain retained. Exact-head normal CI at `162cc90fdabe7f505b88ae095044531b82784c92` passed (52 successful checks, four intentional skips, separate Snyk success); its fresh review completed 5/5.

The corrected Codex provider-choice canary passed before the other 14 distinct cells were dispatched. The completed corrected baseline is **10 PASS / 5 FAIL**, with further continuation defects described below. It is not ready to qualify an instruction reduction. Preserve every attempt, decision, actual run, cost gap and failure. No instruction reduction or general integration quality claim is qualified yet.

## Initial corrected campaign stopped before provider execution

[Campaign 37574251834](https://github.com/paperclipai/paperclip/actions/runs/37574251834) resolved source `cbf1c4fba8eabbf779435f550c455f6a66c5aae5` on trusted master workflow `99a9de9940bf5974352d9dbfbb2f21e62e89689f`. It was cancelled during the shared build after review identified another browser precondition defect. The matrix job has no steps and no runner execution; no provider cell or behavioral grade occurred. Preserve this cancelled campaign separately.

The initial stable-ID check assumed whitespace around the identifier. The real breadcrumb uses adjacent title/identifier spans. A regression reproduces the failure with `Renamed taskRUN-1`; the corrected check targets the visible identifier element under the current breadcrumb and matches its text exactly. All five browser checks now pass, including wrong route, wrong/partial identifier and an identifier present only in the mutable title or elsewhere on the page. Seven focused suite checks and eval typecheck pass. This review correction changes only browser support and this report; production logic is unchanged.


## Continuation failures exposed by the corrected baseline

Frozen measured source: `162cc90fdabe7f505b88ae095044531b82784c92`; trusted workflow: `99a9de9940bf5974352d9dbfbb2f21e62e89689f`. These results do not retroactively change the original baseline.

- [Codex provider-second canary 37575158761](https://github.com/paperclipai/paperclip/actions/runs/37575158761): PASS, 17/17 checks, three actual succeeded runs. The saved Arcade choice, separate exact HubSpot access approval, one authorized provider call, persisted Ada Fixture response and actual verification marker all pass. No harness retry. Cleanup and both budget readbacks pass.
- [Remaining 14 distinct cells, campaign 37576261807](https://github.com/paperclipai/paperclip/actions/runs/37576261807): preserve every first-attempt original grade. Claude provider-decline and provider-second fail after the saved choice on `run.attach`: their run-scoped instruction working-copy path changes while runtime content identity is unchanged. This is not evidence for the unrelated old missing-final failure.
- Claude service-approve executes the approved service call, then the evaluator fails fast in the gap between the first blocked run finalizing and its continuation appearing. The final ledger retains a second run that starts and is cancelled by cleanup. The earlier workflow snapshot misses it; count both records and do not claim the continuation behavior passed.
- Codex service-approve executes the approved call, but a yielded result requests another human approval for the same referenced card. Finalization materializes a redundant completion-review card. The original FAIL is retained.

The corrected fifteen-cell result is:

| Profile | Connection decline | Provider decline | Provider second | Service approve | Service decline |
| --- | --- | --- | --- | --- | --- |
| Codex | PASS | PASS | PASS (separate canary) | FAIL | PASS |
| ACPX Claude | PASS | FAIL | FAIL | FAIL | PASS |
| OpenCode | PASS | PASS | FAIL | PASS | PASS |

OpenCode provider-second saved both the Arcade choice and the exact access grant. Gateway discovery occurred twice, but the fixture observed zero HubSpot calls. The third run reached the existing deadline without a final answer. The facade was dropping canonical tool events, so retained outer logs cannot establish the exact tool-rejection cause. This is a real incomplete workflow; do not infer its cause from the model's self-diagnosis or treat a larger timeout as a fix.

The final ledgers contain **31 actual runs: 27 succeeded, two failed, two cancelled during cleanup**. Earlier polling counted 30; the final Claude service-approve ledger adds a late continuation absent from its workflow snapshot. Its API snapshot has that run queued, and its final ledger records start and cancellation. OpenCode's third run is running in the failure snapshot and cancelled in the final ledger. Preserve these capture-time differences. All result/API/final-ledger run-ID sets agree; Claude service-approve's earlier workflow run set does not. All fifteen cleanup and 1,000-cent company/agent readbacks pass, and all attempts are first attempts with no harness retries. The independent local audit retains 279 evidence-file hashes, source/suite/model/attempt identities and original grades. The [remaining campaign's original public report](https://d1p6rlowie26tp.cloudfront.net/runner-e2e/campaigns/gha-37576261807-1/index.html) is accessible (HTTP 200).

Recorded LLM subtotal for the corrected fifteen cells is **$0.04553787**, with incomplete token/cost coverage. Only OpenCode reports positive amounts. Codex/Claude zeros have unknown billing type, invoices are unknown, and local/hosted runtime is unmetered. Count the cancelled continuations as actual executions; do not describe zero reports as free.

The next source correction admits only Claude's authenticated registered-copy path rotation while preserving prompt/custom-entry bytes, content identities, model, permissions, session and lifecycle guards. TypeScript/Rust shared fixtures bind the exact canonical asset suffix. It rejects stale paths and changed custom text instead of replacing arbitrary path strings. Cursor's separate authenticated run-grant policy is unchanged.

Completion feedback rejects a duplicate human-approval request when a response-wake result references this exact run/agent/task's tool-action card. A resolved reference plus a repeated human approval request is rejected when no different pending interaction or approval exists. General evidence of a completed action does not prevent a valid wait on a new question; waiting without any real pending condition still fails. Unrelated reviews and other runs' cards are not silently dismissed. The evaluator waits for the specifically recorded executed-action continuation within its existing deadline; a consumed response followed by another blocker still fails. No expected outcome, service-call limit, approval requirement, overall deadline, automatic retry policy or paid prompt is relaxed.

Provider-free regression evidence: the original Claude reattachment error and duplicate approval acceptance both reproduce before their fixes. Nine Rust attachment checks (including cross-language suffix parity), 127 ACPX runtime/adapter checks, 33 completion/control-plane tests, 1,802 evaluator support tests plus 128 Node tests pass; one support skip is intentional. New live qualification is still required for these source changes. Recorded zero costs do not establish free calls or complete billing; runtime and actual invoices remain unknown.

The OpenCode repair forwards bounded tool start/progress/completion events through the existing provider facade, retaining the actual execution-part identity, tool name, status and provider-visible result. It does not invent a host-call-ID join, expose tool arguments, or change the model prompt, permissions, tool catalog, timeouts or grading. A real bundled-proxy regression emits an invalid-tool failure: the old forwarding path drops all three events, and the repaired path retains all three. Runnerd normalizes builtin tool activity and preserves the error while redacting secret patterns. The output digest describes the bounded forwarded result, not an unretained full provider payload. This closes an evidence gap; it does not establish the old OpenCode failure's cause or claim its behavior fixed.

New local verification also passes repository typecheck and build, nine continuation deadline tests, 59 OpenCode driver/proxy checks and the focused Rust tool-error/redaction check. The earlier interrupted full repository suite remains incomplete; current-source full CI and live canaries remain required. The next paid selection is bounded to Claude provider-decline (restart repair), Codex service-approve (duplicate approval repair), and OpenCode provider-second (one diagnostic attempt with repaired evidence). Other failed cells wait for usable canary evidence. Preserve all old outcomes, frozen aliases and costs.


## Bounded continuation canaries and retained-evidence correction

[Campaign 37581023494](https://github.com/paperclipai/paperclip/actions/runs/37581023494), on measured source `a704a0b9128ab54c1707c1a7ce04c6f969d3a8cb` and trusted master workflow `03cf6a6ecb0caf5e6f9c4e6af87dc723e5e3bca2`, completed **2 PASS / 1 FAIL** on the first and only attempts. Its [original public report](https://d1p6rlowie26tp.cloudfront.net/runner-e2e/campaigns/gha-37581023494-1/index.html) is accessible (HTTP 200). Suite hash `246bcce46091a96be43340213467adc4412f1031836191fc224158322ebff576`; definition digest `7f0b96fd202e68170e30acc10221c6fe012413adb33f932f1a845b13b8109e4c`.

- **Codex service-approve: PASS**, 17/17 checks. Two succeeded runs, exactly one approved service call, a saved briefing with both returned titles and the actual verification code, no extra pending approval.
- **OpenCode provider-second: PASS**, 17/17 checks. Three succeeded runs, saved Arcade choice, separate accepted access grant, exactly one `Hubspot_ListContacts`, and a run-attributed final reply containing Ada Fixture and the independently observed marker. The repaired evidence carrier does not establish why the earlier source timed out; a single later pass does not prove the old cause fixed.
- **Claude provider-decline: original FAIL**, 18/20 checks (the explanation check and resulting workflow-completed check fail). Both actual runs succeed, including attachment after the controller restart. The saved, run-attributed reply states that HubSpot “isn't connected” because the user selected None, and explains why contacts cannot be fetched. The old matcher omits this contraction. All decision, no-use, task completion, identity, and cleanup checks pass. This is a demonstrated grader false negative, not missing agent output.

The matcher correction recognizes contracted negative connection/retrieval statements, with positive and unrelated negative controls. Replaying the exact retained Claude input against old and corrected functions reproduces the old explanation FAIL and corrected explanation PASS, with **zero provider runs**. The original live grade stays FAIL. The unchanged no-use replay uses the original retained connection-identity PASS receipt and independently counts zero tool calls in the gateway snapshot; it does not invent a new connection snapshot. No attribution, timestamp, successful-run join, decision, no-use, or marker gate is removed. This is a separately labeled grader correction, not a new live pass or a rewritten campaign.

Seven actual runs are retained across these canaries, all succeeded, with no harness retry or recovery. All result, workflow, API and final-ledger run-ID sets agree. All three cleanup checks and both 1,000-cent budget readbacks pass; 59 retained evidence-file hashes are audited. Reported LLM subtotal is $0.006246754, entirely from OpenCode. Codex/Claude zero reports have unknown billing type; invoices and local/hosted runtime remain unknown.

Review also exposed an overbroad resolved-approval guard: completed action A could block a valid new question B. A real database regression fails before the correction for both accepted and rejected A, then passes after narrowing the check. The stale-wait and duplicate-approval regressions remain passing. The formatting-only follow-up `cac06f9259daee24beeee7d6b65bbc7c39ca82dd` changes one Rust regression test (wrapping and a trailing argument comma); it is distinct from the measured source. The subsequent guard and matcher corrections are also not relabeled as the frozen canary source.

Current local validation: seven completion-feedback database checks, 1,805 evaluator support checks plus 128 Node checks (one intentional support skip), and repository/evaluator typechecks pass. Repository build and fresh-head CI/review remain separate readiness gates. The only remaining authorized paid selection is the two previously held Claude cases, provider-second and service-approve, on a newly frozen corrected source. Instruction reductions remain held pending a usable, consistently measured baseline.
