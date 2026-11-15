# Test audit, Round 6 — preservation report

Round 6 removes **2,831 net test lines and 12 redundant executions**, repairs two false proofs, and changes **zero production lines**. Complete owner/sibling baselines passed **2,060/2,060**; candidates passed **2,048/2,048** across the same **39 complete files**, with no failures or skips. These counts establish preserved selected-suite coverage, not a wall-time speed improvement.

Audit baseline: `a090035cafb29c06f6fca2dbe43561ad866b7c1b` includes the prior cleanup and current master. Audit code commit: `d8de9422f0703d4508a9dc880b67a07f13e0f110`. The initial delivery replayed only this round's identical test changes on stacked base `58c5c4aa241c85f4665a3159c192888bbb2a5cfa`. After the parent squash merge, the same round's changes were replayed onto merged master `dabb8c5daf430a1987af611e2e7ca4c7b23ef7d4`. This report records preservation evidence; workspace checks and current delivery/CI status belong in the PR.

The audit followed OpenClaw's [test-audit skill](https://github.com/openclaw/openclaw/blob/main/.agents/skills/test-audit/SKILL.md) and [campaign process](https://github.com/openclaw/openclaw/blob/main/.agents/skills/test-audit/CAMPAIGN.md): baseline complete files, read owners/callers/siblings, classify each declaration, nominate exact keepers, independently review, then run candidates and deliberate production regressions.

## Exact scope

Only these ten existing test files change; no application, API, workflow, lockfile, telemetry, style or token contract changes.

| Test file | Net lines removed |
|---|---:|
| `packages/adapter-utils/src/execution-target-sandbox.test.ts` | 191 |
| `packages/adapter-utils/src/sandbox-managed-runtime.test.ts` | 470 |
| `packages/adapter-utils/src/sandbox-callback-bridge.test.ts` | 214 |
| `server/src/__tests__/heartbeat-process-recovery.test.ts` | 684 |
| `server/src/__tests__/heartbeat-comment-wake-batching.test.ts` | 688 |
| `server/src/__tests__/environment-execution-target-capabilities.test.ts` | 22 |
| `ui/src/components/TaskChatThread.test.tsx` | 250 |
| `ui/src/components/task-chat/TaskChatComposer.test.tsx` | 92 |
| `ui/src/components/IssueProperties.test.tsx` | 26 |
| `ui/src/pages/apps/AppsConnect.test.tsx` | 194 |

Totals: sandbox **875**, heartbeat **1,372**, UI **562**, capabilities **22**. The final sandbox total includes removal of one duplicate blank import line during indentation cleanup; the other savings include helper costs and repaired expectations.

All **995 original declarations** have decisions: **R619** retained, **F2** repaired, **C370** consolidated, **D4** deleted as duplicate or test-owned proof. C includes fixture/query/render consolidation and case migrations; it does not mean 370 executions were removed. Every remaining table, timeout, retry and distinct security/ownership/transport/platform/lifecycle contract remains.

## All twelve retired executions and their keepers

Owner labels below refer to the exact files in the scope table. Each row is one execution, including the two declarations retired from the handwritten latch group.

| Owner | Retired case | Retained keeper and preserved observation |
|---|---|---|
| execution-target-sandbox | `marks the orderly completion and reports a success for a healthy channel` | `test_close_after_orderly_completion_keeps_the_run_result`: actual bridge settle/read around provider exit, success and no loss event/counter. Retired case exercised only a handwritten fake. |
| execution-target-sandbox | `reports the failure and does not mark for a latched loss` | `fails a clean CLI completion closed when the bridge channel was lost mid-turn`, alongside retained actual bridge loss cases: typed failure translation remains; retired latch assertion exercised only the fake. |
| execution-target-sandbox | `cannot clear the loss latch with a later completion` | Same clean-CLI failure keeper: identical failed injected disposition, exitCode and typed error, plus provider_exit stderr. Extra mark affected only the handwritten fake. |
| execution-target-sandbox | `test_a_missing_preface_aborts_the_open_and_falls_back_to_queue_v1` | `test_fallback_to_queue_v1_happens_at_most_once_per_run`: same READY-without-preface path; migrated provider close/stop receipt **before finally**, one open and one queue fallback. |
| execution-target-sandbox | `encodes the READY frame to the exact byte-for-byte wire format` | callback-bridge `test_http2_gateway_writes_no_frame_between_ready_and_the_preface`: real generated gateway, literal version/key order/newline/preface, plus migrated host-encoder compatibility. |
| sandbox-managed-runtime | `the workspace wipe command preserves in-flight sync scratch tarballs (.paperclip-upload-*)` | `the workspace wipe keeps an in-flight scratch tarball at the root but removes a stale sibling`: executes the real shell wipe and checks independently seeded bytes and stale-file absence. |
| sandbox-callback-bridge | `maps an indeterminate host outcome to a non-retryable 409 in the in-sandbox bridge server` | execution-target-sandbox `forwards the host indeterminate-outcome header so the sandbox server maps the 504 to a non-retryable 409`: actual request/status/header/body. Separate actual HTTP/2 mapping remains. |
| heartbeat-comment-wake-batching | `cancels a deferred wake containing only a comment authored by the closing run` | `cancels a deferred comment wake when its only queued comment was authored by the finishing run`: exact persisted wake cancellation/error, migrated total-run count, and restored exact first-run succeeded receipt. |
| AppsConnect | `shows an in-flight state while Paperclip prepares Notion sign-in` | `keeps the same steps when Notion sign-in takes over the wizard`: identical pending setup/actions; all four original assertions retained, with three migrated, plus no-stepper checks. |
| AppsConnect | `uses the gallery app name automatically` | `leaving the default name connects with the app name`: identical GitHub/key/submit inputs and both original assertions, plus navigation. |
| environment-execution-target-capabilities | `omits the snapshot when the resolution rejects` | `never forces the persistent session when the resolution rejects`: identical rejected target; migrated undefined-snapshot assertion before actual runner delegation, then forceSession=false. |
| environment-execution-target-capabilities | `carries no snapshot for session-output streaming when the resolution rejects` | Same rejection keeper and identical setup; separate positive streaming, native-sync rejection and concurrent-sync controls remain. |

One additional assertion-only cut removes a literal test-owned `push("provisioned")`/equality in the generic asset round-trip. Real provisioned/helper bytes and the restore callback's actual remote-file receipt remain. A restore-diagnostic title was corrected; its assertions and ordering behavior remain unchanged.

## Two false proofs repaired

| Keeper | Original weakness | Repaired public observation |
|---|---|---|
| `keeps sentinel route, query, body, and tokens off the http2 telemetry and logs` | Negative sentinel inventory omitted the actual generated bridge token. | After real HTTP/2 readiness/request success, require the issued token to be nonempty and exclude those actual bytes from both recorder JSON and onLog chunks. Host token/route/query/body/forwarded Authorization checks remain. |
| `renders the same PostHog method choices in page and task-dialog hosts` | Compared subject-derived optional button states; real controls are collapsed radios with aria-checked, so missing controls could equal missing controls. | Open Change in both actual hosts; fixed selected/unselected radio expectations, required-key Connect gate, real typed key, and original dialog primary-action receipt. |

For each repair, the pinned original weak case **passed the same production regression** that made the repaired keeper fail at its intended assertion. No fabricated token, receipt, copied expected inventory or subject-derived expectation supplies the repaired oracle.

## Independent review and expansion

Independent reviewers expanded **625 calls from actual candidate helper bodies**: sandbox **134**, heartbeat **282**, UI **209**. Complete ordered runtime programs equal the originals outside the specifically recorded retirements, migrations and F bodies. Review separately checked lexical callee/free-reference bindings, immutable arguments, callback captures, field/JSX spread order, fresh nested allocations, genuine DB/process receipts, all outer awaits, timer/wait budgets, transaction/action ordering and cleanup. No expected assertions are generated by fixture helpers. No added helper comments or sub-1,000-to-over-1,000 file crossings occur.

**Review caught and restored a real heartbeat preservation gap:** the first proposal migrated cancellation and total-run counts but omitted the retired case's exact first-run `succeeded` receipt. The final keeper copies the original DB read, waits for real queue release and a settled row, then directly asserts `{ id: firstRun!.id, status: "succeeded" }` before cleanup. Waiting only for success would hide a failed receipt behind a timeout; the final settled-state wait permits the direct guard to fail. The correction was independently approved before integration.

The sandbox files were tidied **after** runtime controls. The candidate runs used the earlier bytes; final hashes differ only by leading indentation and one blank import line. `tidy-proof.json` proves complete AST identity including literal raw text and exact string/template/regex source bytes, and all 134 helper expansions were rechecked. The durable controls record connects each executed hash to its final hash; it does not claim the final formatting bytes were separately runtime-tested.

## Accepted regression evidence

All eight deliberate production regressions failed at their intended retained guard, with no setup/worker/timeout failure:

| Regression | Observed guard |
|---|---|
| Actual issued bridge token added to ready log | Actual-token exclusion from logDump. |
| Missing-preface close bypassed | Provider close/stop count before finally received zero. |
| Host READY encoder adds a newline | Host encoder versus independently literal-pinned generated gateway bytes. |
| Scratch exclusion removed from real wipe | Independently seeded scratch read failed with ENOENT at its resolves-byte assertion. |
| Self-authored deferred input kept live | Exact wake cancellation error differed. |
| PostHog authentication choices removed | Fixed OAuth aria-checked assertion received undefined after Change. |
| First-run success receipt corrupted after real drain | Exact persisted first-run matcher received failed instead of succeeded. |
| Rejected capability resolution fabricates a snapshot | Undefined-snapshot assertion received an object before runner execution. |

Seven unmutated positive keeper controls passed, and both original weak controls passed under their respective regressions. All production owner bytes were restored. **One earlier receipt mutation was rejected and excluded:** changing success before queue drain timed out before the intended assertion. The accepted replacement alters the persisted receipt atomically after real drain in the existing release transaction and reaches the direct status guard.

## Durable provenance

[Controls and source/packet digests](2026-10-12-test-audit-round6-controls.json) retain the complete-file run JSON digests, final/executed source hashes, accepted mutation JSON/log digests, restoration receipt and formatting identity digest. Packet manifest / expansion SHA256 values are:

| Packet | Manifest SHA256 | Expansion SHA256 |
|---|---|---|
| Sandbox | `cb6f36fa4b836b7c16e23ce6f62326a15e27eed407742b0e09d4779f40f7c7b1` | `8b3883f723147d2bcd53e0288d76fbf47b817d187a8fd79e4f85b258a840ad16` |
| Heartbeat | `85934e19feb6aed9247c09ff2057ab4acd1b9d5951e534047c597cbcc936417b` | `56e5b59358099059bc48204f74509a2bff8256ae91deeeea0f960575b0d221c1` |
| UI | `0dd858bc5b8b2c3c23a6772ae0fea5087191af9a549a36d9db8f23be8e539127` | `8bd16e860d15f25defa34dd49b6d7e48ac7bf1e0dccaa4c6bae5979562d60ad4` |
| Capabilities | `72fdcb9282dd7875bbc6df559fa8896c856151e60843657cdfe70054cd8b8924` | No helper expansion; exact semantic preservation review. |

Full source ledgers, verifiers and raw logs were temporary audit packets. This report and its adjacent controls JSON retain compact accepted decisions and provenance; digests identify those packets but do not retain their full payloads. Broad workspace and latest delivery-head checks remain separate PR evidence.
