# Waiting and resuming: runtime ownership and evidence

## Finish line

Map the section 5 waiting/resume boundary, strengthen the existing continuation
oracle where it can accept broken state, and measure a small current-source
sample before proposing instruction removal. This change adds eval checks and
an ownership map. It does not remove agent instructions or change scheduling.

## Ownership map

| Operation | Authority and code | Instruction decision |
| --- | --- | --- |
| Ask a durable question | Native `request_human_input` persists an interaction with a mutation receipt in `server/src/services/native-runtime/paperclip-runner-tool-authority.ts`. `packages/paperclip-runner/src/native-session-runtime.ts` records a governed wait; `server/src/services/native-runtime/status-arbiter.ts` selects `in_review` for the yielded response wake. The finalizer and status committer apply the decision. | Keep the short native routing instruction and tool contract. No manual status PATCH is needed on this path. |
| Ask through legacy API/skill | `server/src/services/issue-thread-interactions.ts` creates the interaction; the legacy caller separately moves the task to `in_review`. `server/src/routes/issues.ts` checks the review path. `skills/paperclip/SKILL.md` describes those two operations. | Keep the legacy save-question, then set-waiting-state instructions. Interaction creation alone does not own that transition. |
| Deliver a human answer | `issue-thread-interactions.ts` validates the resolver and commits the answer plus `issueQuestionResponseDeliveries` in one transaction. `question-response-delivery.ts` owns delivery claims, replay fences and continuation wake receipts. Completed-task historical answers do not enqueue new work. | Agents must use the actual answer and respect the requested scope; they need not manufacture a wake or poll for it. |
| Resume a provider's built-in question | `server/src/services/native-runtime/native-question-bridge.ts` binds the persisted question to its source run and provider request. It tries the original paused request before a fresh-wake fallback. | Keep this distinct from a semantic question that yields a terminal run. A running run is valid only with the pending native request's identity. |
| Deliver approval/review outcomes | `queueResolvedInteractionContinuationWakeup` in `server/src/routes/issues.ts`, `native-interaction-bridge.ts`, and native review dispatch/participant services preserve authoritative targets and outcomes. | Clarification is not approval. Reviewer authority, exact plan revision and rejected-action boundaries remain necessary. |
| Keep dependencies blocked and waits healthy | Native status arbitration and `server/src/services/recovery/legacy-continuation.ts` retain governance, dependency, budget and ownership gates. `pre-dispatch-review-wait.ts` distinguishes a verified no-provider review wait from an executed cancellation. | Keep first-class blockers distinct from human questions/review. Prose alone cannot create an actionable wait or authorize recovery. |
| Finish after a response | Native completion goes through assessment/status commit; legacy completion uses the status/comment API (optionally the installed helper). Task documents and activity remain durable server records. | Runtime completion and legacy API bookkeeping are different contracts. This audit does not justify removing the latter. |

## Existing coverage and gaps

- `continuation`: real answer changes, clarification without approval, revised
  plans retaining approval, untrusted handoff text, child reuse after restart,
  native question documentation, and the provider-question bridge. These use
  existing browser/API/provider journeys, not a new harness.
- `everyday-workflows`: agent review handoff and service approval/decline cover
  additional reviewer and tool authorization paths.
- `context-integrity`: ordered comment continuation retains identical repeated
  user wording. It does not make every repeated agent comment a defect.
- `continuation-accounting` and the server question-response delivery tests:
  durable receipts, duplicate delivery, restart, late gates and bounded repair.
  These remain separate from task quality and instruction qualification.

The old lifecycle oracle could accept a pending question with a stale execution
lock, wrong waiting status, retry/recovery/monitor, a changed assignee, a lost
intermediate run, or a missing/replaced second answer. New mutation calibrations
reject those records even when the final task is done. Positive calibrations
retain both terminal semantic waits and a correctly bound paused provider run.
The existing content, approval and artifact checks still apply.

All waiting checkpoints now carry task activity from the public API. This is
successful persisted mutation evidence, not a failed-attempt counter. Final
output count already rejects duplicate deliverables; there is no blanket rule
that repeated comments or document revisions are invalid. A future instruction
comparison must inspect attributed writes and revisions, preserving legitimate
progress comments and actual failures. This slice does not prove that every
possible duplicate status write or premature effect is absent.

## Bounded live measurement

Use the existing trusted Product E2E workflow with the branch under test frozen
to its resolved source revision. Select exactly these four local cells, one
attempt each, with no automatic retries and verified 1,000-cent company/agent
hard stops before task creation:

- `continuation.legacy-codex.local.answer-updates-scope`
- `continuation.legacy-claude.local.answer-updates-scope`
- `continuation.runner-codex.local.question-tool-documentation`
- `continuation.runner-acpx-claude.local.question-tool-documentation`

This is a current-source canary of question waiting/resume and the stronger
oracle. It is not a candidate/baseline instruction comparison. The two native
cells ask two sequential questions; the legacy cells ask one scope question.
They cannot be pooled into a model ranking or a cost comparison. Record actual
runs, source/workflow/grader identities, original grades, cleanup and incomplete
billing coverage. Keep prior grades unchanged. Failed attempts need diagnosis,
not a reroll to produce a green total.

Approval/review, dependency unblock, provider-native paused questions, crash
races and remote execution are outside this four-cell sample. Their existing
deterministic/live suites are catalogued above, not newly qualified here.

## Next instruction decision

Retain the legacy waiting transition until the API owns it atomically (a separate
product change) or matched evidence supports another valid contract. Native
waiting is already runtime-owned. Any proposed native text reduction should
first measure the remaining prompt/tool bytes and run matched approval/question
cases; do not move legacy API instructions into native tool descriptions.
