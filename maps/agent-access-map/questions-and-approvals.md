# Questions and approvals — agent access

Product map: [Questions and approvals](../feature-map/questions-and-approvals.md).

Feature ID: `questions-and-approvals`.

Source revision: `3bbc2104b65caf9f7763938a01260a5673e12f7a`.

Review depth and executed proof are separate. The operation records enumerate the named behavior and access boundaries. Their evidence states describe the reviewed sources; run results and environment limits belong in the PR or verification artifacts. A listed API or source test does not establish a live authorized journey. Follow the [map contract](../README.md).

Source review of meaningful operations at `3bbc2104b65caf9f7763938a01260a5673e12f7a`. Operation review records contract depth; evidence remains source-only and proposed live checks remain not-run. Native REST, dedicated native tools, legacy/CLI clients, human sessions and public assistant MCP have distinct authority. Preserve existing host/provider caveats and link actual executed proof separately.

## `questions`

Capability ID: `questions-and-approvals/questions`.

Review: `operation-reviewed`.

Read/create questions, record permitted answers, and distinguish cancellation/withdrawal from presentation dismissal.

### `read`

API: `present` — GET /api/issues/{id}/interactions.

Agent access: `available` — agent REST, CLI issue interactions, native get_task_context or admitted call_api reads; each actual runtime needs its binding.

Policy: Company/issue read authorization, private-task and responsible-user visibility. GET does not persist lifecycle expiration.

Evidence: `source-only` — [interaction routes](../../server/src/routes/issues.ts), [interaction service](../../server/src/services/issue-thread-interactions.ts); reviewed at `3bbc2104b65caf9f7763938a01260a5673e12f7a`. No live proof.

Verification: `not-run` — Read as permitted human/agent; deny foreign/private issue; compare pending and terminal saved receipts after reload.

Gaps: Run context read is not provider receipt or live answer delivery proof.

### `create`

API: `present` — POST /api/issues/{id}/interactions, kind ask_user_questions.

Agent access: `available` — native request_human_input(interactionKind=questions) in standard/planning/ask/skill_test when advertised; permitted legacy REST/CLI interaction:create. Muse closed native profile omits this tool.

Policy: Agent mutation requires authenticated source run and low-trust/issue boundaries; sourceRunId is server-stamped. Chat addressee defaults to immutable owner. User/agent addressee mutually exclusive; agent cannot address self, foreign or uninvokable agent. Company kind governance clamps policy. Native dedicated input does not expose arbitrary addressee/policy fields.

Evidence: `source-only` — [interaction routes](../../server/src/routes/issues.ts), [interaction service](../../server/src/services/issue-thread-interactions.ts), [native authority](../../server/src/services/native-runtime/paperclip-runner-tool-authority.ts); reviewed at `3bbc2104b65caf9f7763938a01260a5673e12f7a`. No live proof.

Verification: `not-run` — Create complete canonical mixed form; same idempotency key/payload returns same card; changed payload conflicts. Reload exact IDs/audience; deny spoofed source/governed metadata/foreign addressee.

Gaps: Legacy wrappers and native dedicated tool have different fields; source availability does not establish every harness.

Provider question cards retain the creation summary and each question's prompt
and help text when the answer needs a modal. This changes presentation only;
answer authorization and the private terminal receipt remain unchanged.

### `answer`

API: `present` — POST /api/issues/{id}/interactions/{interactionId}/respond.

Agent access: `partial` — eligible responder REST; CLI interaction:respond; admitted native call_api standard/skill_test; request_human_input creates requests rather than answers.

Policy: Same company/readable issue and current effective audience; agents need matching authenticated run/company/agent/responsible user, issue mutation or admitted watchdog containment, no low-trust boundary violation and cross-issue influence allowance. Current review policy can narrow audience; service rechecks cancellation/write authority under lock. Board chat responder must own the conversation. Only pending ask_user_questions; normalize/validate question and option IDs, required single/multi/custom/text constraints. Save answer/actor/run and durable outbox atomically. Human-only does not permit agent resolution.

Evidence: `source-only` — [interaction routes](../../server/src/routes/issues.ts), [interaction service](../../server/src/services/issue-thread-interactions.ts), [answer delivery](../../server/src/services/question-response-delivery.ts); reviewed at `3bbc2104b65caf9f7763938a01260a5673e12f7a`. No live proof.

Verification: `not-run` — Submit paged edited answers; invalid IDs/limits leave pending. Reload exact saved answers/actor and one eligible continuation. Competing response loses without second delivery; denied audience/run leaves card unchanged.

Gaps: Provider/runtime delivery requires its own actual waiting input or continuation evidence.

### `cancel`

API: `present` — POST /api/issues/{id}/interactions/{interactionId}/cancel.

Agent access: `restricted` — board-only cancellation, including the CLI interaction:cancel client. An ordinary agent cannot use this route.

Policy: Only a pending question on an eligible task can be cancelled. Record cancellation and empty answers with attribution. Persist any waiting native-run cancellation intent before attempting shutdown; a deferred shutdown remains recoverable.

Evidence: `source-only` — [interaction routes](../../server/src/routes/issues.ts), [interaction service](../../server/src/services/issue-thread-interactions.ts); reviewed at `3bbc2104b65caf9f7763938a01260a5673e12f7a`. No live proof.

Verification: `not-run` — Cancel a disposable question, reload the cancelled receipt and cancellation intent, and reject an agent or repeated terminal decision. Confirm no answer was invented; cancellation intent alone does not prove provider termination.

Gaps: No dedicated CLI withdraw command found. Cancellation request is not confirmed provider termination.

### `withdraw`

API: `present` — POST /api/issues/{id}/interactions/{interactionId}/withdraw.

Agent access: `partial` — board or permitted creator/current-assignee agent with valid authenticated run and containment. No dedicated CLI withdraw command.

Policy: Validate task visibility, creator/current-assignee authority, run context and current review restrictions. Reject an executing linked tool request. Persist native-question cancellation intent before shutdown. Withdrawal by the current assignee does not self-wake; other callers retain ordinary eligible continuation rules.

Evidence: `source-only` — [interaction routes](../../server/src/routes/issues.ts), [interaction service](../../server/src/services/issue-thread-interactions.ts); reviewed at `3bbc2104b65caf9f7763938a01260a5673e12f7a`. No live proof.

Verification: `not-run` — Withdraw as creator/current assignee and board in separate fixtures. Reject unrelated agent, forged/missing run, executing linked action and repeated terminal resolution. Reload receipt and verify cancellation/continuation without losing a stop obligation.

Gaps: No dedicated CLI withdraw command found. Cancellation request is not confirmed provider termination.

### `historical-answer`

API: `present` — POST /api/issues/{id}/interactions/{interactionId}/respond for recognized historical pending question on Done task.

Agent access: `restricted` — pure human responder only; ordinary agent/native responder cannot use the terminal-history exception.

Policy: Only service-recognized historical question, Done task and human actor without agent/run/system identity; record conversation history only, no response outbox/new work. Other terminal task paths remain denied.

Evidence: `source-only` — [interaction service](../../server/src/services/issue-thread-interactions.ts); reviewed at `3bbc2104b65caf9f7763938a01260a5673e12f7a`. No live proof.

Verification: `not-run` — Answer eligible historical Done question, reload history and verify no task reopen/run/outbox. Reject cancelled task/nonhistorical/agent cases.

Gaps: Special historical compatibility path is not permission to reopen completed work.

## `dismiss-and-reopen`

Capability ID: `questions-and-approvals/dismiss-and-reopen`.

Review: `operation-reviewed`.

Saved dismissal, local drafts, and response decisions are distinct states.

### `read-pending`

API: `present` — GET /api/issues/{id}/interactions.

Agent access: `available` — permitted REST/native API/CLI interaction reads under current task/company/privacy authority.

Policy: Shared interaction reads retain domain authorization. Reading a pending question does not answer it or change its stored status.

Evidence: `source-only` — [dismissal state](../../ui/src/hooks/useDismissedTaskQuestions.ts), [task thread](../../ui/src/components/TaskChatThread.tsx), [interaction service](../../server/src/services/issue-thread-interactions.ts); reviewed at `3bbc2104b65caf9f7763938a01260a5673e12f7a`. No live proof.

Verification: `not-run` — Read the same pending question before and after browser dismissal; compare its ID, pending status and absence of a response-delivery record. Reject inaccessible task/company reads.

Gaps: Drafts and raw runtime dismissal remain browser-local.

### `dismiss`

API: `present` — POST /api/issues/{id}/interactions/{interactionId}/dismiss.

Agent access: `restricted` — board-only; an agent cannot dismiss its own pending request. Authorized agents can read dismissal in interaction/task context.

Policy: Task/company read access and resolver audience apply. Current issue review policy is rechecked under the task lock; an excluded review requester cannot defer the review. Saves dismissal under task/interaction locks without resolving, executing, or waking. Ordinary requests stop gating completion. Tool/secret/connection/document/company-policy and configured review gates retain authority, with no repeated reminder. Raw runtime dismissal remains a browser preference.

Evidence: `source-only` — [route](../../server/src/routes/issues.ts), [service](../../server/src/services/issue-thread-interactions.ts), [completion predicate](../../server/src/services/issue-question-context.ts), and [task thread](../../ui/src/components/TaskChatThread.tsx).

Verification: `not-run` — Dismiss, reload, reopen the original request; verify persisted dismissal with no answer, approval, or wake. Reject agents, foreign or unreadable private tasks, wrong audiences, and review requesters excluded by current policy. Check ordinary completion review and protected tool action separately.

Gaps: Browser drafts and raw runtime request dismissal do not synchronize across devices.

### `reopen-draft`

API: `not-applicable` — browser history and QuestionForm draft storage keyed to the request; submission uses the separate response API.

Agent access: `not-applicable` — local page, answer and custom-text drafts are browser presentation. There is no agent draft-control API.

Policy: QuestionForm saves page/answers/custom state by draftKey and clears on successful submit/cancel. Settled card from competing tab is authoritative; local draft cannot revive it. Explicit supersession is lifecycle rather than dismissal.

Evidence: `source-only` — [question drafts](../../ui/src/components/task-chat/QuestionForm.tsx), [reopening](../../ui/src/components/TaskChatThread.tsx); reviewed at `3bbc2104b65caf9f7763938a01260a5673e12f7a`. No live proof.

Verification: `not-run` — Reopen an edited paged draft after reload, verify its own saved selections/text, and ensure a new request cannot inherit another request’s draft. Clear the draft only after the supported successful submission/cancellation path.

Gaps: Cross-browser drafts and every alternate host remain separate verification scope.

### `observe-resolution`

API: `present` — GET /api/issues/{id}/interactions.

Agent access: `available` — permitted shared receipt reads; the browser reconciles its stale form with that record.

Policy: The persisted terminal receipt wins over local draft state. Explicit supersession is a server lifecycle decision, separate from browser dismissal.

Evidence: `source-only` — [question drafts](../../ui/src/components/task-chat/QuestionForm.tsx), [reopening](../../ui/src/components/TaskChatThread.tsx); reviewed at `3bbc2104b65caf9f7763938a01260a5673e12f7a`. No live proof.

Verification: `not-run` — Resolve in another tab and refresh/reopen the old form. Show the saved receipt, preserve attribution, and offer no second answer or revived pending request.

Gaps: Cross-browser drafts and every alternate host remain separate verification scope.
## `confirmations`

Capability ID: `questions-and-approvals/confirmations`.

Review: `operation-reviewed`.

Resolve ordinary confirmations, selections and partial item verdicts with explicit policy and retry semantics.

### `create-and-read`

API: `present` — GET /api/issues/{id}/interactions; POST /api/issues/{id}/interactions for ordinary confirmation, checkbox, suggested-task or item-verdict requests.

Agent access: `available` — permitted REST/CLI create/read; native request_human_input supports corresponding kinds under its actual mode/profile.

Policy: Creation authority/source/audience as questions. Server-owned governed metadata cannot be forged. Target-bound request validates exact document revision atomically; same create key changed content conflicts.

Evidence: `source-only` — [interaction routes](../../server/src/routes/issues.ts), [interaction service](../../server/src/services/issue-thread-interactions.ts), [native authority](../../server/src/services/native-runtime/paperclip-runner-tool-authority.ts); reviewed at `3bbc2104b65caf9f7763938a01260a5673e12f7a`. No live proof.

Verification: `not-run` — Create/read each relevant kind with exact target; repeat key unchanged/changed; deny forged toolAction/secretProposal and stale document target.

Gaps: Native dedicated field set is narrower than direct REST.

### `accept-or-reject`

API: `present` — POST /api/issues/{id}/interactions/{interactionId}/accept or /reject.

Agent access: `partial` — eligible human/agent resolver REST, CLI interaction:accept/reject and native call_api in standard/skill_test; board-only governed callback remains separate.

Policy: Same company/readable issue and current effective audience; agents need matching authenticated run/company/agent/responsible user, issue mutation or admitted watchdog containment, no low-trust boundary violation and cross-issue influence allowance. Current review policy can narrow audience; service rechecks cancellation/write authority under lock. Board chat responder must own the conversation. Pending/open/current target required; request-confirmation acceptance checks source workspace readiness. Reject reason follows payload requirement. Generic repeated terminal resolution conflicts rather than universally deduplicating.

Evidence: `source-only` — [interaction routes](../../server/src/routes/issues.ts), [interaction service](../../server/src/services/issue-thread-interactions.ts); reviewed at `3bbc2104b65caf9f7763938a01260a5673e12f7a`. No live proof.

Verification: `not-run` — Fresh accept/reject records exact actor/result. Competing opposite decisions yield one winner. Stale/closed/expired/withdrawn target, missing reason and human-only agent fail without repeated task/provider/wake.

Gaps: Tool/secret/connection authorization uses dedicated governed controls; ordinary confirmation is not equivalent.

### `checkbox-and-suggested-task-selection`

API: `present` — POST /api/issues/{id}/interactions/{interactionId}/accept with selectedOptionIds or selectedClientKeys.

Agent access: `partial` — permitted resolver REST/CLI/native call_api; agent task effects require independent task creation/assignment authority.

Policy: Same company/readable issue and current effective audience; agents need matching authenticated run/company/agent/responsible user, issue mutation or admitted watchdog containment, no low-trust boundary violation and cross-issue influence allowance. Current review policy can narrow audience; service rechecks cancellation/write authority under lock. Board chat responder must own the conversation. Checkbox IDs/min/max validated; direct accept may use documented defaults if field absent. Suggested tasks require rooted selected tree, same-company parent/project and independent task-bridge/assignment checks for every created task. Persist selected/skipped/created IDs.

Evidence: `source-only` — [interaction routes](../../server/src/routes/issues.ts), [interaction service](../../server/src/services/issue-thread-interactions.ts); reviewed at `3bbc2104b65caf9f7763938a01260a5673e12f7a`. No live proof.

Verification: `not-run` — Accept subset and explicit empty checkbox selection; reload exact result. Reject unknown/bounded IDs and selected child missing selected parent; verify no partial child creation on denial and no duplicates.

Gaps: Task-tree details also belong to task-coordination; default selection is not conversational user provenance.

### `item-verdicts`

API: `present` — POST /api/issues/{id}/interactions/{interactionId}/verdicts.

Agent access: `partial` — authorized REST/native call_api standard/skill_test; no dedicated CLI verdict wrapper found.

Policy: Same company/readable issue and current effective audience; agents need matching authenticated run/company/agent/responsible user, issue mutation or admitted watchdog containment, no low-trust boundary violation and cross-issue influence allowance. Current review policy can narrow audience; service rechecks cancellation/write authority under lock. Board chat responder must own the conversation. Only request_item_verdicts; enabled verdicts/IDs/required reason checked. First decision retained for repeated item IDs; partial result persists, complete after all items. New item IDs trigger continuation; replay same items does not.

Evidence: `source-only` — [interaction routes](../../server/src/routes/issues.ts), [interaction service](../../server/src/services/issue-thread-interactions.ts); reviewed at `3bbc2104b65caf9f7763938a01260a5673e12f7a`. No live proof.

Verification: `not-run` — Submit partial/repeated/final subsets; reload retained first verdicts. Invalid IDs/verdict/reasons leave state unchanged; later expiry preserves already resolved items.

Gaps: Live partial-verdict continuation remains separate evidence.

### `resolve-from-comment`

API: `present` — POST /api/issues/{id}/interactions/{interactionId}/resolve-from-comment.

Agent access: `partial` — active responding agent REST or native call_api standard/planning/skill_test; denied in Ask; no dedicated CLI wrapper.

Policy: Agent's authority retained. Exact running source task assignment/executionRunId, valid write/run/responsible-user identity and resolver policy. Latest nondeleted unquarantined human comment after card from expected user, no /new or prior session boundary. Only confirmation/checkbox; governed metadata denied. Checkbox accept needs explicit selectedOptionIds. Same comment/decision/selection/reason replay deduplicates; conflicting replay fails; no self-wake.

Evidence: `source-only` — [comment provenance](../../server/src/services/confirmation-comment-resolution.ts), [interaction routes](../../server/src/routes/issues.ts), [native REST modes](../../server/src/services/native-runtime/runner-api-catalog.ts); reviewed at `3bbc2104b65caf9f7763938a01260a5673e12f7a`. No live proof.

Verification: `not-run` — Record legitimate reply, repeat -> deduplicated and one activity. Reject foreign/older/newer-superseded message, wrong user/session/run, human-only/governed card, missing explicit selection and Ask-mode invocation.

Gaps: Server validates provenance and authority, not semantic certainty of arbitrary human text.

### `withdraw`

API: `present` — POST /api/issues/{id}/interactions/{interactionId}/withdraw.

Agent access: `partial` — board or permitted creator/current-assignee agent with valid run, containment and review authority.

Policy: Withdrawal is a stored lifecycle change, separate from local dismissal. Validate current pending task/card and creator/assignee authority; an executing linked tool request cannot be withdrawn.

Evidence: `source-only` — [interaction routes](../../server/src/routes/issues.ts), [interaction service](../../server/src/services/issue-thread-interactions.ts); reviewed at `3bbc2104b65caf9f7763938a01260a5673e12f7a`. No live proof.

Verification: `not-run` — Withdraw through each permitted actor, reload terminal state, and reject unrelated agent, stale/closed card, invalid run or executing tool. Repeated withdrawal must not cause another effect.

Gaps: No agent skip authority or generic manual expiry API.

### `skip`

API: `present` — POST /api/issues/{id}/interactions/{interactionId}/skip.

Agent access: `restricted` — board-only; no agent skip authority.

Policy: Require an eligible open task and pending interaction. Save cancelled status with the skipped result and retain any partial item verdicts. Linked pending/approved requests follow their cancellation/withdrawal rules; executing tool work cannot be skipped. This route deliberately queues no continuation.

Evidence: `source-only` — [interaction routes](../../server/src/routes/issues.ts), [interaction service](../../server/src/services/issue-thread-interactions.ts); reviewed at `3bbc2104b65caf9f7763938a01260a5673e12f7a`. No live proof.

Verification: `not-run` — Skip a pending disposable request and inspect the saved skipped receipt, retained partial verdicts, linked request state and unchanged run count. Reject agent, repeated decision and already-executing tool. A later ordinary message is separate steering.

Gaps: No agent skip authority or generic manual expiry API.

### `observe-expiry`

API: `present` — GET /api/issues/{id}/interactions; lifecycle writes are server-owned.

Agent access: `partial` — permitted receipt reads only; no generic agent manual-expiry endpoint.

Policy: Closed tasks, stale target revisions, a newer same-creator/kind request or explicit opt-in comment supersession invalidate the applicable pending request. Default ordinary comments do not. GET can derive legacy expiration without a persistence write.

Evidence: `source-only` — [interaction routes](../../server/src/routes/issues.ts), [interaction service](../../server/src/services/issue-thread-interactions.ts); reviewed at `3bbc2104b65caf9f7763938a01260a5673e12f7a`. No live proof.

Verification: `not-run` — Compare default pending-after-comment, opt-in supersession, stale revision and independent sibling cases. Expired cards reject later decisions; the read must not invent activity, a wake or repeated side effects.

Gaps: No agent skip authority or generic manual expiry API.
## `plan-review`

Capability ID: `questions-and-approvals/plan-review`.

Review: `operation-reviewed`.

Review exact saved plan, then distinguish ordinary execution from Agent Chat handoff.

### `publish-and-revise`

API: `present` — GET /api/issues/{id}/documents/plan; PUT /api/issues/{id}/documents/plan with the current base revision; POST /api/issues/{id}/interactions with the exact saved plan revision.

Agent access: `available` — native list/read/write_document + request_human_input when actual mode/profile admits; direct REST/CLI supported fields.

Policy: Document ACL/version gates; request insert validates current target revision atomically. Native supplied targetRevisionId infers own plan target only for planning confirmation; otherwise full target required. Stable revision-specific key. Product Chat Ask discussion does not authorize plan/task writes.

Evidence: `source-only` — [interaction service](../../server/src/services/issue-thread-interactions.ts), [native authority](../../server/src/services/native-runtime/paperclip-runner-tool-authority.ts), [chat directive](../../server/src/services/agent-conversations.ts); reviewed at `3bbc2104b65caf9f7763938a01260a5673e12f7a`. No live proof.

Verification: `not-run` — Save plan and request exact returned revision; reload, edit and reject old base/card. No project/execution tasks merely from drafting. Ask discussion must not become handoff.

Gaps: Historical revision/view/edit races need explicit proof; dedicated native schema is not arbitrary REST.

### `accept-current-or-request-changes`

API: `present` — POST /api/issues/{id}/interactions/{interactionId}/accept; POST /api/issues/{id}/interactions/{interactionId}/reject. Agent conversational resolution has its own operation below.

Agent access: `partial` — eligible human or agent resolver under the ordinary audience, run and readiness policy; server-bound native completion review is a separate operation below.

Policy: Locks revalidate current target, reviewer and eligible task. Own-plan acceptance can change planning to standard and return the exact creator ownership; non-plan/checkbox acceptance cannot. Rejection retains planning and carries the reason. Live-source finalization readiness can block acceptance; failed/stale finalization after an ended source has different rules. Accepted-plan continuation retains the exact revision and fresh workspace-aware session.

Evidence: `source-only` — [interaction routes](../../server/src/routes/issues.ts), [interaction service](../../server/src/services/issue-thread-interactions.ts), [native authority](../../server/src/services/native-runtime/paperclip-runner-tool-authority.ts); reviewed at `3bbc2104b65caf9f7763938a01260a5673e12f7a`. No live proof.

Verification: `not-run` — Accept a current plan and reject a separate request; inspect mode, owner, reason, accepted revision and useful continuation. Reject stale/foreign revision or excluded resolver. Compare repeated/conflicting generic decisions without assuming native-review deduplication.

Gaps: Acceptance alone is not linked task creation or provider execution.

### `resolve-assigned-native-review`

API: `present` — production resolve_review calls POST /api/issues/{id}/interactions/{interactionId}/accept or POST /api/issues/{id}/interactions/{interactionId}/reject for its one server-bound review.

Agent access: `available` — the actual bound native completion-review run exposes resolve_review. It cannot choose an arbitrary issue/review or take over the worker task.

Policy: Recheck the current server-issued review assignment and independent reviewer policy. Reject requires a reason. Same decision already resolved by the admitted review run returns a deduplicated receipt; a different or stale decision fails. Record the verdict without changing task ownership; task completion still waits for every required reviewer.

Evidence: `source-only` — [interaction routes](../../server/src/routes/issues.ts), [interaction service](../../server/src/services/issue-thread-interactions.ts), [native authority](../../server/src/services/native-runtime/paperclip-runner-tool-authority.ts); reviewed at `3bbc2104b65caf9f7763938a01260a5673e12f7a`. No live proof.

Verification: `not-run` — Inspect submitted work through a real bound reviewer, accept or reject with a reason, replay the exact decision, and reject retargeting, missing/stale binding, creator exclusion and conflicting verdict. Compare reviewer receipt, task ownership and all required review outcomes.

Gaps: A declared scenario review tool is not an admitted review run. Review verdict and the reviewer’s own paperclip_finish report are separate obligations.

### `resolve-chat-plan-continuation`

API: `present` — POST /api/issues/{id}/interactions/{interactionId}/accept or POST /api/issues/{id}/interactions/{interactionId}/reject; eligible agent-only POST /api/issues/{id}/interactions/{interactionId}/resolve-from-comment. Subsequent continuation is server-owned.

Agent access: `partial` — conversation owner human controls; responding agent must retain its own resolver authority. No separate chat-plan approval API.

Policy: Immutable conversation owner, exact accepted/rejected request context and acceptedTargetRevision. Chat directive authorizes handoff only when person requested approval and current accepted plan continuation has no newer wake comment; unrelated/history/new-session card cannot become fresh approval. Accept doesn't create project/tasks itself.

Evidence: `source-only` — [chat workflow](../../server/src/services/agent-conversations.ts), [review context](../../server/src/services/heartbeat/run-preparation.ts), [continuation prompts](../../server/src/services/heartbeat/task-markdown.ts); reviewed at `3bbc2104b65caf9f7763938a01260a5673e12f7a`. No live proof.

Verification: `not-run` — Owner accepts/rejects; inspect fresh and resumed prompt identity/revision/reason. Reject wrong owner, newer-comment or unrelated historical context; chat remains reusable.

Gaps: Prompt/source contract requires actual agent handoff outcome; scripted browser fixture is not real model proof.

### `chat-project-and-task-handoff`

API: `present` — GET /api/companies/{companyId}/projects; GET /api/companies/{companyId}/project-repositories; POST /api/companies/{companyId}/projects; POST /api/companies/{companyId}/issues with the intended project, assignee, initialPlan and stable creation key.

Agent access: `partial` — advertised native list_projects/list_project_repositories/create_project/create_task; admitted legacy project-MCP wrapper or direct REST. Actual client binding required.

Policy: After accepted scope, reauthorize run/task/generation/standard-or-skill_test project write, same-company project/repository, responsible user and assignment/trust. Native conversation create_task fixes parentId null/standard mode and persists initialPlan atomically before wake. Project/task receipts prevent duplicates and compare fingerprints. Legacy wrapper fixes todo/blocked, omits person-assignee/status parity. Generic schema does not guarantee suitable project/copied plan; verify result.

Evidence: `source-only` — [legacy wrappers](../../server/src/services/project-tools.ts), [project authority](../../server/src/services/project-tool-context.ts), [native authority](../../server/src/services/native-runtime/paperclip-runner-tool-authority.ts), [project receipts](../../server/src/routes/projects.ts); reviewed at `3bbc2104b65caf9f7763938a01260a5673e12f7a`. No live proof.

Verification: `not-run` — Inspect suitable project, standalone assigned tasks and relevant persisted plan before first execution; source plan unchanged. Replay/concurrent exact key -> one task/project, changed payload conflicts. Deny stale generation/project/repository/assignee/company and restricted mode.

Gaps: Native/legacy field differences persist. Real model choosing project/plan subset remains live gap; cross-link agent-chat/handoff.

### `source-plan-approval-evidence`

API: `present` — GET /api/issues/{id}/interactions and GET /api/issues/{id}/documents/plan are source reads under their own visibility. GET /api/issues/{id}/documents/plan/revisions returns saved revision bodies; the unsuffixed document route returns the current body. Neither computes sourcePlanApproval. Native get_task_context exposes sourcePlanApproval; there is no standalone handoff-approval REST endpoint.

Agent access: `partial` — bound native task context; legacy description/context may carry explicit source IDs. No universal source browsing guarantee.

Policy: Same-company originRunId points to conversation; newest eligible accepted plan resolved before task creation joins exact stored revision with source privacy. Pending/later/foreign/nonconversation gives no approval; Muse additionally filters trust. This informs source scope, not approval of new task plan/changed work. No atomic copied-plan equality or current-generation guarantee.

Evidence: `source-only` — [source approval selector](../../server/src/services/native-runtime/handoff-plan-context.ts), [native authority](../../server/src/services/native-runtime/paperclip-runner-tool-authority.ts); reviewed at `3bbc2104b65caf9f7763938a01260a5673e12f7a`. No live proof.

Verification: `not-run` — Read worker source approval after newer unapproved draft; exact historical accepted revision only. Foreign/private/no-origin/pending/later evidence absent; new plan has no fabricated own acceptance.

Gaps: Historical selection/generation and edit-race limitations remain explicit; actual useful worker execution not proven by context alone.

## `audience`

Capability ID: `questions-and-approvals/audience`.

Review: `operation-reviewed`.

Persisted audience and current authority govern every operation, including permitted agent reviewers.

### `requested-and-effective-policy`

API: `present` — GET /api/issues/{id}/interactions; POST /api/issues/{id}/interactions accepts permitted policy/addressee fields. There is no independent audience-override endpoint.

Agent access: `partial` — permitted REST create/read; native dedicated producer lacks arbitrary audience fields.

Policy: Company kind cap/default, server-owned governed clamp, immutable chat user and valid same-company addressee. human_only and not_creator independent constraints; legacy provenance preserves creator/source-run exclusion. Binding review policy may narrow, never widen persisted audience.

Evidence: `source-only` — [resolver audience](../../server/src/services/issue-thread-interaction-resolution.ts), [interaction service](../../server/src/services/issue-thread-interactions.ts); reviewed at `3bbc2104b65caf9f7763938a01260a5673e12f7a`. No live proof.

Verification: `not-run` — Compare requested/effective/source provenance; attempt self/foreign/both addressees, forged governed policy or legacy widening -> deny/retain restriction.

Gaps: No resolution-time permission grant can be inferred from a displayed label.

### `eligible-human-or-agent-resolution`

API: `present` — POST /api/issues/{id}/interactions/{interactionId}/respond, POST /api/issues/{id}/interactions/{interactionId}/accept, POST /api/issues/{id}/interactions/{interactionId}/reject and POST /api/issues/{id}/interactions/{interactionId}/verdicts. Assigned native review resolves through its bound route.

Agent access: `partial` — eligible human or authenticated agent resolver; native resolve_review only server-bound exact completion review, no arbitrary target.

Policy: Shared read/mutation/run/responsible-user/containment/cross-issue gates plus named addressee, creator/source-run and independent requester exclusion. Authorized human may override agent addressee, never another named user or creator exclusion. Board chat owner restriction. Missing independent requester fails closed. Governed tool/secret approval always human.

Evidence: `source-only` — [interaction routes](../../server/src/routes/issues.ts), [resolver audience](../../server/src/services/issue-thread-interaction-resolution.ts), [native authority](../../server/src/services/native-runtime/paperclip-runner-tool-authority.ts); reviewed at `3bbc2104b65caf9f7763938a01260a5673e12f7a`. No live proof.

Verification: `not-run` — Run matrix named user/agent, different actor, creator/source run, no/mismatched run, human-only+not_creator, unknown review requester, low-trust/watchdog/private/foreign. Denial leaves pending/no downstream effect.

Gaps: Permitted agent answer is attributed agent decision, not impersonation of human. Host/provider live matrix remains not-run.

## `governance`

Capability ID: `questions-and-approvals/governance`.

Review: `operation-reviewed`.

Formal approval request/read/revision/decision operations retain independent board authority.

### `read-and-context`

API: `present` — GET /api/companies/{companyId}/approvals; GET /api/approvals/{id}; GET /api/approvals/{id}/issues; GET /api/approvals/{id}/comments.

Agent access: `available` — agent REST/CLI approval list/get; native list_approvals/get_approval/get_approval_context; public MCP paperclip_pending_approvals returns links only.

Policy: Company_scope:read where route requires; every ID route hides approval unless all linked/payload tasks readable, including responsible-user/private scope. Native context filters linked tasks. Read capability doesn't grant decisions.

Evidence: `source-only` — [approval routes](../../server/src/routes/approvals.ts), [approval privacy](../../server/src/services/authorization.ts), [native authority](../../server/src/services/native-runtime/paperclip-runner-tool-authority.ts), [assistant pending links](../../server/src/services/public-mcp/capabilities.ts); reviewed at `3bbc2104b65caf9f7763938a01260a5673e12f7a`. No live proof.

Verification: `not-run` — Read visible approvals/history/context; foreign/private-linked/payload task hidden and no secret values; pending link alone can't decide.

Gaps: Different read routes have different company-scope checks; live native/MCP identity separately qualify.

### `request-and-comment`

API: `present` — POST /api/companies/{companyId}/approvals; POST /api/approvals/{id}/comments.

Agent access: `available` — permitted agent REST/CLI approval create/comment, native call_api standard/skill_test; human REST.

Policy: Company/source visibility; creation resets pending/actor attribution and deduplicates linked IDs; hire payload secret normalization/redaction. Explicit status-only recovery agent cannot create/comment. Legacy route does not require universal active run when absent.

Evidence: `source-only` — [approval routes](../../server/src/routes/approvals.ts), [linking](../../server/src/services/issue-approvals.ts); reviewed at `3bbc2104b65caf9f7763938a01260a5673e12f7a`. No live proof.

Verification: `not-run` — Agent requests/comments with readable source, reload author/link/pending; status-only/foreign/private denies, secrets redacted.

Gaps: Creation/linking/each payload-specific governed effect needs separate evidence; no agent decision granted.

### `approve-reject-or-request-revision`

API: `present` — POST /api/approvals/{id}/approve, /reject, /request-revision.

Agent access: `restricted` — board/company/approval visibility; CLI only with board context. Agent REST/native call_api and personal assistant cannot decide.

Policy: Auth actor supplies decidedByUserId; body cannot spoof. Approve/reject pending or revision_requested with conditional update; repeated same terminal verdict no-op/no repeated effect, opposing verdict 422. requestRevision only pending; no equal replay guarantee. Newly applied decision alone triggers reviewed lifecycle/adapter/linked continuation.

Evidence: `source-only` — [approval routes](../../server/src/routes/approvals.ts), [conditional records](../../server/src/lib/approval-records.ts), [governed effects](../../server/src/services/approvals.ts); reviewed at `3bbc2104b65caf9f7763938a01260a5673e12f7a`. No live proof.

Verification: `not-run` — Board decisions and revision request, reload audit + actual governed effect. Duplicate same decision one effect; concurrent opposite fails; agent denied and forged actor ignored.

Gaps: Request-revision concurrency/replay not claimed as equivalent to approve/reject; payload integrations remain explicit.

### `resubmit`

API: `present` — POST /api/approvals/{id}/resubmit.

Agent access: `partial` — board or original requesting agent REST/CLI; admitted native call_api standard/skill_test.

Policy: Only revision_requested; original requesting agent required, status-only recovery denied. Optional normalized replacement payload; returns pending and clears note/decider/time. Private linked source still required.

Evidence: `source-only` — [approval routes](../../server/src/routes/approvals.ts), [resubmission](../../server/src/services/approvals.ts); reviewed at `3bbc2104b65caf9f7763938a01260a5673e12f7a`. No live proof.

Verification: `not-run` — Original agent resubmits revised payload -> pending/cleared decision; wrong agent/status-only/terminal request denied. Reload pending/history.

Gaps: No generic formal cancel endpoint or broad agent approver exists.

## `tool-review`

Capability ID: `questions-and-approvals/tool-review`.

Review: `operation-reviewed`.

Human review and provider execution are independently recorded and scoped.

### `invoke-request`

API: `present` — POST /api/tool-gateway/tools/call through an authorized gateway session, or the actual assigned MCP tools/call protocol.

Agent access: `partial` — an actually assigned eligible tool/gateway client can invoke the governed operation. Optional/scenario client presence is not admission.

Policy: Server execution creates the signed invocation, pending action request and linked card with original argument, identity and catalog snapshots. Raw caller-supplied toolAction metadata cannot create authority. Ask first prevents the external call until the independent reviewer approves.

Evidence: `source-only` — [tool execution](../../server/src/services/tool-gateway.ts), [queue](../../server/src/routes/tool-access.ts), [interaction routes](../../server/src/routes/issues.ts); reviewed at `3bbc2104b65caf9f7763938a01260a5673e12f7a`. No live proof.

Verification: `not-run` — Invoke a harmless Ask first action through the actual assigned client. Inspect one pending signed request/card and no early provider effect. Reject an excluded actor, fabricated payload or revoked binding.

Gaps: Optional MCP client/scenario declaration doesn't establish production assigned tool availability.

### `read-task-review`

API: `present` — GET /api/issues/{id}/interactions.

Agent access: `available` — permitted task-local REST/native/CLI reads under task/company/privacy authorization.

Policy: Reading a task review card does not grant approval or company-wide queue access. Preserve exact connection, tool and argument scope.

Evidence: `source-only` — [tool execution](../../server/src/services/tool-gateway.ts), [queue](../../server/src/routes/tool-access.ts), [interaction routes](../../server/src/routes/issues.ts); reviewed at `3bbc2104b65caf9f7763938a01260a5673e12f7a`. No live proof.

Verification: `not-run` — Reload a permitted task card and compare signed request identity/context. Reject private/foreign task access; a reader without decision authority must not gain it from the visible card.

Gaps: Optional MCP client/scenario declaration doesn't establish production assigned tool availability.

### `read-board-queue`

API: `present` — GET /api/companies/{companyId}/tools/action-requests with the supported status filter.

Agent access: `restricted` — board company queue; ordinary agents use their permitted task-local context.

Policy: The queue enforces board identity and company access independently of task-local card reads. Queue visibility does not approve an action or imply provider execution.

Evidence: `source-only` — [tool execution](../../server/src/services/tool-gateway.ts), [queue](../../server/src/routes/tool-access.ts), [interaction routes](../../server/src/routes/issues.ts); reviewed at `3bbc2104b65caf9f7763938a01260a5673e12f7a`. No live proof.

Verification: `not-run` — Read the queue as a permitted board person and match the task card/request after reload. Reject ordinary agent and foreign-company queue reads; inspect decision affordances separately.

Gaps: Optional MCP client/scenario declaration doesn't establish production assigned tool availability.

### `approve-once-or-decline`

API: `present` — POST /api/tool-gateway/action-requests/{id}/approve or /decline with companyId; task accept/reject dispatches same callback.

Agent access: `restricted` — board nonviewer active company membership (local implicit/instance-admin exceptions); service rejects agent actor; native fallback preserves denial.

Policy: Exact task/card/request/invocation signed binding, open/unexpired pending state, resolver addressee/human policy. Definition/connection/identity/current policy rechecked; required formal approval must be approved. Same settled decision returns current state; conflicting decision fails. Approval may execute stored request; decline never does.

Evidence: `source-only` — [review route](../../server/src/routes/tool-gateway.ts), [review transaction](../../server/src/services/tool-action-review.ts), [execution checks](../../server/src/services/tool-gateway.ts); reviewed at `3bbc2104b65caf9f7763938a01260a5673e12f7a`. No live proof.

Verification: `not-run` — Decide concurrently from task/queue, reload synchronized one receipt/provider call. Reject wrong context/company/agent/viewer/stale/expired/revoked/snapshot/formal-gate request. Provider failure remains approved+failed.

Gaps: Decision acceptance isn't provider delivery/termination proof; uncertain action never replayed automatically.

### `approve-and-remember`

API: `present` — POST /api/tool-gateway/action-requests/{id}/approve with rememberAction. Separate administration uses POST /api/companies/{companyId}/tools/action-requests/{actionRequestId}/trust-rule and POST /api/companies/{companyId}/tools/trust-rules/{policyId}/revoke.

Agent access: `restricted` — human review authority; trust administration active board tool membership; no agent self-allow.

Policy: Approval and displayed action-wide trust rule atomic. Only reviewed approved/executed ask-required source, bounded selectors/definition; rule failure rolls approval back. Changed arguments may be allowed within scope, but Off/deny and changed catalog still win. Formal-gated source cannot gain action-wide permission.

Evidence: `source-only` — [remember transaction](../../server/src/services/tool-action-review.ts), [rule scope](../../server/src/services/tool-access-policy.ts), [rule administration](../../server/src/routes/tool-access.ts); reviewed at `3bbc2104b65caf9f7763938a01260a5673e12f7a`. No live proof.

Verification: `not-run` — Approve remember then safe changed args obey rule; Off/definition change still blocks/reviews. Failed rule save leaves pending/no execution. Revoke rule then next action follows current policy.

Gaps: Cross-link app-permissions for full trust administration; not company-wide blanket trust.

### `execution-and-continuation`

API: `present` — GET /api/companies/{companyId}/tools/action-requests and GET /api/issues/{id}/interactions expose saved decision/outcome. Delivery workers process the accepted signed request and eligible continuation.

Agent access: `partial` — agent receives own settled tool result/continuation, board inspects; no authority from local dismissal.

Policy: Decision status distinct from executed/failed/expired/unknown. Test-tab has no agent so approval runs stored test call; agent executionOnApprove uses exact stored operation and current authority. Durable settled/outbox receipts avoid duplicate provider calls/wakes on retry/restart; uncertain write not blindly retried.

Evidence: `source-only` — [tool result delivery](../../server/src/services/tool-action-delivery.ts), [settlement](../../server/src/services/tool-gateway.ts); reviewed at `3bbc2104b65caf9f7763938a01260a5673e12f7a`. No live proof.

Verification: `not-run` — Failure after approval stays accepted with useful failure context; lost response/restart retains one call/continuation; dismissing doesn't decide; inspect actual useful provider result.

Gaps: Scripted process/local MCP E2E isn't live provider/model qualification.

## `continuation`

Capability ID: `questions-and-approvals/continuation`.

Review: `operation-reviewed`.

A durable response feeds the eligible source input or continuation without repeating work.

### `read-and-deliver-answer`

API: `present` — GET /api/issues/{id}/interactions; GET /api/heartbeat-runs/{runId}. The response routes atomically write the delivery outbox; delivery is server-owned.

Agent access: `available` — permitted reads/native task context; actual bound waiting-input bridge or server continuation receives response, not an arbitrary model-created wake.

Policy: Exact interaction/source/payload digest and current task/assignee. Waiting native/PRP input first; unavailable session remains pending. Running successor answer queues rather than auto-steers; never steer into source solely because alive. No target/terminal task fails safely; historical Done answer has no outbox.

Evidence: `source-only` — [answer delivery](../../server/src/services/question-response-delivery.ts), [interaction routes](../../server/src/routes/issues.ts), [native bridge](../../server/src/services/native-runtime/native-interaction-bridge.ts); reviewed at `3bbc2104b65caf9f7763938a01260a5673e12f7a`. No live proof.

Verification: `not-run` — Save answer, inspect exact delivery/run/source and useful next answer. Hold input session unavailable -> durable pending, recover once. Reassign/terminal/pause/budget/privacy deny stale execution.

Gaps: Answered status not proof provider consumed it; each real runtime must qualify.

### `recover-and-deduplicate`

API: `present` — GET /api/issues/{id}/interactions; GET /api/heartbeat-runs/{runId}. Existing decision APIs and durable delivery/wake receipts govern server retries; no agent bypass API exists.

Agent access: `available` — eligible resumed agent context; control owned by server, operators observe supported reads.

Policy: Generation-fenced lease, bounded actual-error retry and separate suppressed-wake retry; reuse committed wake after lost acknowledgment/restart. Queued successor coalesces. New verdict IDs only; skip no wake; cancel/withdraw durable cancellation first. Plan/rejection continuation obeys policy and exact source; native completion waits all reviewers.

Evidence: `source-only` — [answer delivery](../../server/src/services/question-response-delivery.ts), [action outbox](../../server/src/services/tool-action-delivery.ts), [interaction routes](../../server/src/routes/issues.ts); reviewed at `3bbc2104b65caf9f7763938a01260a5673e12f7a`. No live proof.

Verification: `not-run` — Concurrent delivery/restart reuses one wake/side effect; stale worker cannot fallback; suppressed retry doesn't exhaust actual error budget or ignore gates. Check rejection reason/fresh plan session.

Gaps: Exactly-once provider outcome is not inferred from DB uniqueness; inspect external effects separately.

### `external-channel-isolation`

API: `present` — POST /api/issues/{id}/interactions/{interactionId}/respond records the normalized response; GET /api/issues/{id}/interactions exposes its persisted result. Provider identity/callback transport remains a separate channel-specific protocol.

Agent access: `partial` — configured provider-linked sender; assigned channel tools/runtime receive server-bound response. Browser response isn't external-provider proof.

Policy: External chat source cannot steer/coalesce into unrelated provider turn. Source waiting process must retire before isolated continuation; preserve original company/task/provider/message provenance and identity grants; failed/unknown retirement stays visible.

Evidence: `source-only` — [answer delivery](../../server/src/services/question-response-delivery.ts), [channel authority](../../server/src/services/chat-channels.ts); reviewed at `3bbc2104b65caf9f7763938a01260a5673e12f7a`. No live proof.

Verification: `not-run` — Answer in actual configured channel -> one persisted result/useful originating reply; wrong/unlinked/expired sender denied. Overlap two conversations and verify no cross-delivery/replay.

Gaps: Slack/Discord/Telegram/email/iMessage and runtime paths independently not-run until driven.
