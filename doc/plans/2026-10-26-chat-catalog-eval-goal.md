# Chat catalog Product E2E evaluation goal

Date: 2026-10-26

## Refreshed user steering — 2026-10-28 UTC

The user merged credential-custody PR #17949 and asked to resume meaningful human chat feature journeys on the freshly verified merged production baseline. Prioritize sensible evals and a small passing pilot before wider runs, then continue toward broad passing coverage. Exercise real human commands, actual agent execution and independently verified product outcomes; fixture setup must not perform the tested action. No new numerical success threshold or blanket retry budget is introduced by this update.

The proposed pilot uses two previous genuine passes as explicitly requested new-baseline controls, plus three unused useful project/task journeys. Preserve all earlier attempts and correction limits. The prior production50b measurements are historical evidence for this refreshed baseline, not new proof: no old pass silently carries into the new rate. Record the exact new production/eval-source/model identity and actual results before crediting anything. Unmerged core dependencies remain blocked; the summarizer predicate correction remains unaccepted.

GitHub Actions on the existing AWS fleet and the requested OpenCode/OpenRouter model remain the execution lane. Use the existing Evals history and renderer. The original goal and earlier steering below remain preserved where not superseded.

## Authoritative user steering — 2026-10-27

The existing Evals website and family renderer/history are the primary delivery surface: [Evals hub](https://pages.paperclip.ing/evals/) and [Product E2E history](https://d1p6rlowie26tp.cloudfront.net/runner-e2e/). Retire the separate custom local HTML as the delivery approach; retain it only as historical evidence. The [published historical partial Codex campaign](https://d1p6rlowie26tp.cloudfront.net/runner-e2e/campaigns/historical-local-codex-chat-catalog-20261027-158measured-86unrun/) contains158 actually measured IDs,17 original initial passes,141 first-attempt failures and159 retained measurements;86 IDs remain unrun in that historical lane. These are original one-time local outcomes, not current-source/OpenCode qualification. There are238 callback implementations without declared gaps and six incomplete or blocked journeys. All244 are registered, but registration and prerequisite probes do not establish complete intended E2E coverage or verified behavior.

The [published OpenCode setup result](https://d1p6rlowie26tp.cloudfront.net/runner-e2e/campaigns/gha-40530790741-1/) records actual framework attempt 40530790741: tasks.create-backlog initial 1 failed setup before the canonical query. 243 remote initials remain; no canonical chat or feature grading completed. The report was verified rendered in the browser using the existing Product history renderer. Automatic setup hello provider usage/cost is unknown, not zero. The same maximum-one coherent correction budget remains. Two earlier host-only qualification operations consumed no case ordinal.

All new local eval admissions are stopped. Already-active local children may finish their existing work and cleanup; no further local initial, final-B, infrastructure-health or provider qualification launches are authorized. Preserve the complete local measurement/ordinal histories and original evidence as a historical lane.

All future eval execution must run in GitHub Actions on the existing AWS fleet, allowing its normal Spot or On-Demand fallback as directly authorized by the user on2026-10-27 at15:21UTC, using the new Paperclip runner **OpenCode** provider through **OpenRouter**, model **`deepseek/deepseek-v4.1-flash-1017`**. Record and verify the actual AWS host lifecycle; unknown hosts still fail closed. The earlier strict-Spot intents and refused operations remain unchanged and do not become retroactive case admissions. No local eval execution is authorized. The remote campaign requires a separately named execution/product/database/model identity and separately reported rate across all244 scenarios. Do not carry local passes into the remote rate, and do not execute obsolete local source merely to preserve the previous queue.

Carry the audited coherent harness corrections into the remote source. Preserve prior ordinal histories. The manager approved one new remote initial measurement for every scenario and at most one coherent correction measurement per scenario. The representative remote smoke counts as its scenario’s remote initial. A host qualification refusal before evaluation is a retained infrastructure operation, not a case measurement or consumed initial ordinal; the first such operation40519322850 left all244 remote initials unrun. Preserve all prior local ordinals separately; this is not an unlimited repair or unchanged rerun policy. Production/core fixes remain isolated and unmerged unless separately authorized.

Immediate deliverables are an inspectable safe results page, an exact closed local checkpoint, and evidence-based accounting of elapsed wall time, stages reached, harness/product/model/prerequisite outcomes, actual usage and operational duplicate/reconciliation history. The original goal below remains historical context where superseded by this section.

> Execution state: This file preserves the requested goal; it is not completion evidence. Before execution, reconcile the actual state of PR #17794 rather than assuming it merged.

Turn the complete Paperclip chat-scenario catalog into executable Product E2E evals, run every scenario, give each failing scenario one fix-and-rerun cycle, and ship according to the rules below.

Use the current agent/Astra only as the manager for planning, architecture, integration decisions, evidence review, and delegation. Delegate implementation, investigation, testing, and PR work to subagents explicitly using gpt-6.1-sol. Use up to six Sol subagents, within the runtime’s actual concurrency limit; use waves when fewer slots are available. Give workers distinct file ownership and tell them not to revert others’ work.

1. Establish the inventory and baseline.

Read repository instructions and the paperclip-evals, add-product-e2e-eval, and PR workflow skills. Inspect PR #17794 and reconcile its actual state before branching; do not assume it merged or duplicate its work.

Freeze the scenario IDs in tests/runner-e2e/chat-scenarios/ as the denominator. The current inventory is 244 scenarios across 35 areas and 191 capabilities. Verify those numbers and preserve every scenario’s intended request, context, and outcome. Maintain one concise progress record with owners, implementation status, attempts, results, and PR links.

2. Implement real evals for the entire inventory.

Extend the existing Product E2E framework, fixtures, selectors, independent grading, evidence packaging, cleanup, and reports. Reuse the two working chat evals and shared infrastructure.

Each scenario needs executable setup, the real human query through Agent Chat, any explicit user follow-up or approval steps, and assertions appropriate to its expected outcome. Cover the specified conditionals: connected/disconnected, permitted/denied, unique/ambiguous, fresh/existing state, and recovery.

Exercise the real browser, server, database, runner, and model. Use disposable, isolated test data and authorized integration environments. Fixture setup must not perform the action being evaluated or pre-populate its result. Simulated integrations must be labeled and must not count as live proof of the corresponding external integration.

Verify saved state, attribution, permissions, usable results, and persistence where relevant. Calibrate each distinct oracle against a valid result and a plausible wrong result. A plausible reply, generic model judge, registration-only test, skipped test, or missing evidence is not a pass.

3. Run a controlled campaign.

Use one coordinator for live execution and shared resources. Start with a small harness-health check, then run bounded batches; parallel coding does not mean every worker launches databases or full test suites simultaneously.

Record the exact scenario, source revision, definition/grader fingerprint, model/profile, environment, timing, usage, cleanup, and evidence for every attempt. Keep credentials and private data out of tracked files and public reports.

Run every scenario initially with automatic retries disabled. Preserve failures, including setup and infrastructure failures. Missing credentials or unavailable services are explicit blockers, never passing coverage. Continue independent work when one scenario is blocked.

4. Allow one fix cycle per failing scenario.

After its initial failure, diagnose the evidence, make one coherent correction, and rerun that scenario once. A shared root-cause correction may cover several affected scenarios. Preserve both measurements.

Distinguish eval defects, product defects, model behavior, and infrastructure failures. Do not weaken assertions, rewrite the intended outcome, silently extend deadlines, add hidden nudges, or repeatedly rerun unchanged failures to obtain a pass.

After the allowed cycle, retain any remaining failure or blocker and move on. Required CI and review repairs may continue, but do not use them to disguise additional live fix cycles.

5. Separate core fixes from eval work.

If a demonstrated fix changes production behavior outside the eval harness, create a separate focused core PR with regression coverage. Get its required checks and review requirements satisfied, but DO NOT merge it or enable auto-merge.

Keep production fixes out of the eval PR. You may validate them in isolated candidate worktrees, but report those results separately. Passes requiring an unmerged core fix do not count toward the eval PR’s merge threshold.

6. Apply an honest 80% merge gate.

Calculate the final pass rate across the entire frozen inventory, using each scenario’s final allowed result on the eval PR’s code and declared production baseline. Keep failed, blocked, unrun, and unsupported scenarios in the denominator. Report first-attempt and post-fix rates separately.

For 244 scenarios, at least 196 must pass. Do not stop implementing or running the remaining scenarios once 196 passes are reached.

If the full inventory has been implemented and processed and the final rate is at least 80%, create the eval PR, resolve applicable reviews, pass required checks on its latest head, and merge through the normal protected workflow. Preserve and document the remaining failures; do not skip them to manufacture green checks.

If the rate remains below 80% after the allowed cycles, preserve the work and report the results without merging or starting an unlimited repair campaign.

7. Finish with evidence and accurate PR states.

Deliver the complete runnable catalog, per-scenario results, campaign report, initial and final pass rates, remaining failures and blockers, and links to all PRs.

Core-fix PRs must remain unmerged. The qualifying eval PR should actually merge. If a human-only approval or another external gate prevents that, prepare everything possible, enable ordinary auto-merge only for the qualifying eval PR when appropriate, and identify the exact remaining gate. Never bypass protections or report queued auto-merge as completed.

Proceed autonomously without routine approval pauses. Keep the manager focused on coordination and higher-level decisions, and use Sol 6.1 workers for execution.