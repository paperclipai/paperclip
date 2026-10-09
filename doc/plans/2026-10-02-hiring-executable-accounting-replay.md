# Executable hiring lifecycle accounting repair

**Current TL;DR:** No new model calls were made. The original Codex and Claude pairs remain Fail → Fail. The stricter v3 executable replay verifies Codex accounting in both variants; Claude notification action attribution remains unresolved/uncomparable because provider and native request IDs cannot be exactly joined. No notification writes are observed in the retained native API receipts. Source-read coverage remains uncomparable for both profiles, independently of action attribution. Earlier sidecar-v1 and initial executable-v2 passes remain below with their limited task-only proof identified.

## Current stricter executable replay

Code revision: `e4077ade1818d98b9862ae79ee1d49a007dcf9c1`. Hiring grader: `paperclip.hiring-templates.v3`; turn accounting: `paperclip.hiring-template-turn-accounting.v2`. The separately versioned [v2 JSON receipt](2026-10-02-hiring-executable-accounting-replay.v2.json) pins exact source hashes and unchanged original inputs.

| Profile | Original machine grades | Limited sidecar v1 / initial executable v2 | Stricter executable accounting | Source-read coverage |
| --- | --- | --- | --- | --- |
| Codex | Fail → Fail | Pass → Pass | Verified / both new guards pass in each variant | Uncomparable both |
| ACPX Claude | Fail → Fail | Pass → Pass | Unresolved/uncomparable action attribution in each variant; guards fail closed | Uncomparable both; historical six-backtick exact-template mismatch remains |

The limited sidecar and initial executable check rejected notification-created tasks but could miss an unrelated document write during a notification. Their original results and hashes are preserved; they do not prove every notification was harmless. The stricter helper adds a twelfth predicate and an independent action-coverage check. It requires complete contiguous event streams, an accepted control-plane result and succeeded/completed terminal, exact canonical/native action IDs, successful known GET API receipts or verified reads/discovery, and attributed native chat finish. Document/task/agent mutations, failed mutation attempts, incomplete streams and unknown or unmatched actions cannot pass. A readonly hint alone cannot qualify a generic API call.

Codex verifies 10 candidate and 11 baseline notification tool executions, including five and seven exactly joined successful GET calls, with zero unresolved actions. ACPX's native request IDs and provider execution IDs use separate namespaces; names, ordering and counts cannot safely join them. All observed ACPX native API calls are successful GETs, but the stronger cross-ledger proof is missing (five candidate/four baseline unresolved observations). This is an evidence limitation, not a newly observed task failure or a prompt regression. No production carriers or source-read grading are changed.

The observation repair retries entire bracketed snapshots, waits both known Done task callbacks and attributed chat replies (including batching), checks untruncated pending-wake diagnostics, and requires two identical complete observations. It covers the quiet gap before pending outbox work enqueues a wake. Accounted coalesced wakes are admitted only with a linked terminal run and known callbacks. The final guard performs that same complete refresh rather than mixing a stale evidence snapshot with new runs. The generic five-work-turn helper still admits zero notifications when none are owed; this production delegated fixture owes two task completions.

All six non-count outcome checks and every original source/template coverage check remain byte-identical in all four replay projections. All 28 actual model runs remain counted; original input hashes and failed verdicts are unchanged. The stricter action check is separately classified as coverage when attribution is missing. No broad equivalence is established.

- 977 credential-free support tests pass across 64 files, including 144 focused helper/scorer/settlement integrations.
- E2E typecheck, exact two-cell discovery, canonical capability contract/inventory checks and diff checks pass.
- Two current-head review findings are fixed: racing observations and unchecked completion-turn writes. Fresh review/CI is required on this source.
- Initial-head CI retained two unrelated browser failures: exact agent-run denial feedback and touch-picker scroll position. Neither browser path imports the changed runner-e2e harness. They are preserved without a blind rerun; the necessary review-fix head runs normal CI.
- No providers, old campaign retries or extra paid scope are launched. Actual prior model charges remain unknown.

## Initial executable v2 replay (limited notification proof)

TL;DR: This repairs a grading defect; it does not change model instructions or rerun models. The original Codex and Claude pairs remain Fail → Fail. Provider-free replay through both corrected executable paths passes all four retained cells; source-read coverage remains uncomparable. This is a grading correction, not a new model-performance result.

The original fixture required exactly five total runs. Production adds legitimate server completion turns after delegated work. The corrected v2 contract requires exactly three distinct user-requested CEO turns and two coder executions. At most two additional completion turns must pass strict public identity/account/task/delivery/timing/reply attribution. One turn may batch both completed tasks. Unknown, duplicate, failed, retried runs, notification-created tasks and missing public observations fail. This initial version did not inspect unrelated document writes during notifications; see the stricter current assessment above.

Both executable count guards use the shared helper: the hiring scorer and the hiring-only final chat guard. The catalog declares five required / seven maximum total runs so timeout/cost planning includes notifications. Non-hiring count guards remain unchanged. Source-read and exact coder-body grading remain unchanged, including the historical Claude six-backtick mismatch. The grader version and full helper/chat/source digest change.

## Preserved measurement

The immutable [original and bounded sidecar report](https://github.com/paperclipai/paperclip/blob/8eb517ca1497687237163bdef4dfc4d3332ea916/doc/plans/2026-10-02-hiring-template-live-comparison.md) retains candidate `9f5404ad3aacbe76777952759414d34fd381e674` and historical `296a4df85e8bcc97a160fc78c291b17adb828196`, the identical original fixture digest, 28 actual successful runs, eight automatic completion turns, four successful cleanups and unknown actual charges. It calibrates sidecar v1 with 69 passing tests and records exact original input/grader hashes. The executable repair is a new source/grader revision; it cannot rewrite those measurements or prove performance equivalence.

## Provider-free verification

The executable code revision is `eef64009dc144b91b245a731ea9a1c3c07406a19`; report-only commits do not change its grader bytes. The [JSON receipt](2026-10-02-hiring-executable-accounting-replay.json) pins all five grader/flow/helper source hashes, v2 definition digest and original result/hiring/API input hashes.

| Profile | Original executable result | Corrected retained workflow outcome | Both new count guards | Source coverage |
| --- | --- | --- | --- | --- |
| Codex | Fail → Fail | Pass → Pass | Pass in both variants | Uncomparable both |
| ACPX Claude | Fail → Fail | Pass → Pass | Pass in both variants | Uncomparable both; historical exact coder body still fails |

All six other outcome checks and every coverage check are byte-identical in the replay's check projection. Original input files and failed grades remain unchanged. All 28 actual model runs remain counted. The new helper has 11 lifecycle predicates, factoring the sidecar's lifecycle rule without requiring an already-computed original result.

- All 946 credential-free E2E support tests pass across 64 files, including 99 helper calibrations and the four added scorer/final-guard integrations.
- Fifteen focused hiring/run-count tests pass. The integrations admit five core turns, six with batching and seven with distinct notifications; reject an arbitrary wake despite the same total count; require public observations; retain source/template coverage failures; and preserve non-hiring count guards.
- E2E typecheck, normal plugin SDK/Runner TypeScript dependency builds, canonical capability contract/inventory checks and existing two-cell discovery pass.
- Retained replay executes the actual new scorer and final chat guard in each of the four original cells, using the unchanged saved API observations. Both guards pass 4/4; coverage and the six non-count outcomes stay unchanged 4/4.
- Full repository CI and fresh review are pending on the separate draft PR. Local general repository typecheck/test/build were not repeated; exact-head CI must supply those gates before handoff.

Initial development calibration caught mismatched synthetic account data and a deliberately changed template not preserved across reuse. The fixture data was corrected; assertions were kept. Initial cold typecheck lacked built Runner declarations; normal dependency builds resolved it. A temporary replay script's CommonJS extension rejected top-level await; the same script executed as ESM. These provider-free setup/development attempts remain private and are not live model results. No provider runs, old campaign retries or paid scope expansion are authorized for this repair. Public replay receipts will include only grader/input hashes, counts, predicate/check results and original verdicts; credentials, provider session IDs and hidden reasoning remain private.

The branch was safely replayed on master `59c07ede7` before PR creation. The intervening master changes touch only two agent-provider UI files; all eval source bytes are unchanged. The four-cell provider-free replay was repeated against the final reachable code revision, with the same input hashes, checks and zero providers.
