# Recovery — agent access

Product map: [Recovery](../feature-map/recovery.md).

Feature ID: `recovery`.

Native finalization deadline reconciliation records unfinished workspace
preservation through the existing server-owned recovery path. It grants no
additional agent API, provider-stop authority or permission to replay work.

Remote process probes remain server-owned. Confirmed exit requires `ESRCH` or a
zombie with the saved generation. Unknown adopted-process ownership rejects the
probe and grants no permission to replace a runner, signal a different process,
or replay work. Launch requires a working Node probe before detachment.

Ordinary board Retry can reauthorize saved GitHub input for the same App after
reconnect. It pins current runtime authority and preserves sender, repository,
conversation and task checks. Pending input takes precedence over the older
failed request and transfers once to the retry owner. This grants no new agent
Retry API or stale webhook authority. Legacy input can use a server-owned,
processed earlier response ledger to prove the same endpoint's App claim before
that input. Company, conversation, agent and prior delivery/source linkage remain
required. Explicit conflicting App IDs cannot use that fallback. Local PostgreSQL and HTTP-route regressions
cover these transitions; hosted execution and delivery remain separate acceptance.
Dispatch validates the exact claimed wake and resolved user-continuation receipt
for the current successor. A later board Retry can follow that successor only
when exact durable diagnostics and absent execution/resources prove it never
started. This preserves the original sender/source and grants no agent Retry
permission or accepted-result replay.

Source revision: `3bbc2104b65caf9f7763938a01260a5673e12f7a`.

Review depth and executed proof are separate. The operation records enumerate the named behavior and access boundaries. Their evidence states describe the reviewed sources; run results and environment limits belong in the PR or verification artifacts. A listed API or source test does not establish a live authorized journey. Follow the [map contract](../README.md).

Source-reviewed operation contracts at `3bbc2104b65caf9f7763938a01260a5673e12f7a`; proposed checks remain not-run. Preserve existing native/legacy ownership, retained-source and historical failed-evidence caveats. Automatic classification is server work, not an agent retry API. REST, native binding, operator, provider and WebSocket clients have distinct authority.

## `diagnosis`

Capability ID: `recovery/diagnosis`.

Review: `operation-reviewed`.

Read causes, owner/attempt state and retained obligations without claiming successful recovery.

### `read-action-and-source`

API: `present` — GET /api/issues/{id}/recovery-actions, GET /api/issues/{id}, GET /api/heartbeat-runs/{runId}.

Agent access: `available` — permitted agent REST/native call_api reads and CLI issue recovery-actions for that operation; actual native rollout/run binding required.

Policy: Same-company task read authorization, private-task/responsible-user scope and run privacy where run detail is used. Related diagnostics omit unauthorized resource details. Recovery action response includes active plus supported retained settled replay-blocked/native export holds, not unrestricted history. Read revalidation may retire stale action through system lifecycle; no reader participation/physical copyback.

Evidence: `source-only` — [recovery routes](../../server/src/routes/issues.ts), [source actions](../../server/src/services/issue-recovery-actions.ts); reviewed at `3bbc2104b65caf9f7763938a01260a5673e12f7a`. No live provider proof.

Verification: `not-run` — Compare exact company/task/action/source run/owner/attempts/next-action across views and reload. Private/foreign read denied. Repeated Done/cancelled read retains exact unresolved physical owner hold.

Gaps: Recorded cause or successful GET isn't a running retry or restored files.

### `read-blocker-wake-and-subtree-diagnostics`

API: `present` — GET /api/issues/{id}/diagnostics/blockers, /diagnostics/wakes, /diagnostics/subtree.

Agent access: `available` — permitted REST or native call_api; no dedicated CLI issue diagnostics command confirmed.

Policy: Same-company task read authorization, private-task/responsible-user scope and run privacy where run detail is used. Related diagnostics omit unauthorized resource details. Wake internal IDs depend on company-scope read; linked blocker/child/wake detail filtered. Diagnostics bounded/read-only.

Evidence: `source-only` — [recovery routes](../../server/src/routes/issues.ts), [diagnostic discovery](../../server/src/services/native-runtime/runner-api-reference.ts); reviewed at `3bbc2104b65caf9f7763938a01260a5673e12f7a`. No live provider proof.

Verification: `not-run` — Read source diagnosis and compare visible blockers/wakes/subtree; unauthorized linked nodes omitted and no mutation/new attempt on repeat.

Gaps: CLI recovery-actions is supported; don't invent diagnostics subcommands. Coverage of every diagnostic inference remains separate.

### `inspect-run-recovery-host`

API: `present` — GET /api/issues/{id}/recovery-actions; GET /api/issues/{id}; GET /api/heartbeat-runs/{runId}. The run UI host adds no separate recovery API.

Agent access: `available` — permitted agent REST/native call_api reads and CLI issue recovery-actions for that operation; actual native rollout/run binding required.

Policy: Same-company task read authorization, private-task/responsible-user scope and run privacy where run detail is used. Related diagnostics omit unauthorized resource details. Run workspace controls only for failed workspace_validation_failed run linked to source task with live workspace_validation action; other failures use source task.

Evidence: `source-only` — [run host](../../ui/src/components/RunWorkspaceRecoverySurface.tsx), [recovery routes](../../server/src/routes/issues.ts); reviewed at `3bbc2104b65caf9f7763938a01260a5673e12f7a`. No live provider proof.

Verification: `not-run` — Exact eligible run and task agree; deny missing authority and hide stale/other-code controls; reload same persisted action.

Gaps: Component host test doesn't prove actual filesystem/provider repair.

## `bounded-continuation`

Capability ID: `recovery/bounded-continuation`.

Ordinary task Retry uses `POST /api/issues/{id}/retry`. This is authenticated
board task-mutation authority, not agent retry authority. The only request
fields are a UUID idempotency key and observed source run (or null). It accepts
no paths, stop attestations or client-selected strategy. The source-scoped
exact-run and maintenance APIs retain their existing contracts. Connected-chat
Retry reuses chat admission and its external identity. It can persist a wait
only for the exact current system recovery generation. The chat owner resumes
that same deferred receipt through normal admission after containment. The
board intent and external principal remain separate authorities; current task,
connection, pause and budget gates still apply. See the
[durable contract](../../doc/task-recovery.md). Agent Chat also requires its
current conversation owner and feature enablement at admission and locked
dispatch; generic board mutation permission does not replace chat ownership.
Local PostgreSQL and assembled
browser qualification do not establish hosted agent access or recovery.

Review: `operation-reviewed`.

Supported restoration and automatic attempts retain source/owner/attempt authority.

### `observe-automatic-attempt`

API: `present` — GET /api/issues/{id}/recovery-actions; GET /api/issues/{id}; GET /api/heartbeat-runs/{runId}. Automatic recovery has no generic agent-enqueue endpoint.

Agent access: `available` — permitted agent REST/native call_api reads and CLI issue recovery-actions for that operation; actual native rollout/run binding required.

Policy: Server-owned bounded continuation uses exact run/source identity, current owner/normal admission and durable episode limits. Stop, pause, budget, durable wait, owned lifecycle and existing execution remain gates; native exact completion proposal requires source/session/turn+termination proof, not just terminal row.

Evidence: `source-only` — [source actions](../../server/src/services/issue-recovery-actions.ts), [legacy bounded decision](../../server/src/services/recovery/legacy-continuation.ts), [native recovery](../../server/src/services/native-runtime/native-restart-recovery.ts); reviewed at `3bbc2104b65caf9f7763938a01260a5673e12f7a`. No live provider proof.

Verification: `not-run` — Observe attempts/retry timing and actual useful result; concurrent sweeps don't reset budget or duplicate turn. Operator Stop/chat idle must not trigger unwanted recovery.

Gaps: Native/Legacy and live provider takeover need separate proof; preserve existing failed callback evidence.

A review-path repair uses the existing canonical disposition-repair prompt
section. The server fixes its instruction and one-attempt bound. This adds no
API, monitor authority, credential access, or bypass for task and approval gates.
A pending repair retains that section across connection-pool retries. Ordinary
wakes without the typed repair marker ignore stale raw instruction text.
[Prompt controls](../../server/src/services/heartbeat/run-preparation.review-path.test.ts)
cover fresh/resumed delivery and existing disposition repairs; hosted execution
and durable monitor acceptance remain separate verification.

### `resolve-permitted-source-action`

API: `present` — POST /api/issues/{id}/recovery-actions/resolve with exact actionId/outcome/sourceIssueStatus/resolutionNote.

Agent access: `partial` — eligible REST/CLI issue recovery:resolve; native call_api standard/skill_test. false_positive/cancelled and special reconciliation/workspace paths board-only.

Policy: Agent needs issue:mutate, authenticated run, low-trust exclusion and cross-issue allowance; source assignee/action owner or admitted active-checkout management override. Action ownership does not itself grant source-task mutation rights. Board and agent route policies remain distinct. Status changes separately require source owner/current execution participant/management grant or guarded exact-owner handback. blocked needs unresolved first-class blocker. Restored todo cannot bypass task/project/subtree/budget/review/approval/competing-run gates. Dedicated workspace causes reject generic retry.

Evidence: `source-only` — [recovery routes](../../server/src/routes/issues.ts), [resolution schema](../../packages/shared/src/validators/issue.ts); reviewed at `3bbc2104b65caf9f7763938a01260a5673e12f7a`. No live provider proof.

Verification: `not-run` — Eligible owner resolves fresh action, reload recorded outcome/state and useful continuation. Peer/recovery-owner source completion, stale target, no blocker, pause/budget/review gates denied without side effects.

Gaps: CLI body lacks executionReconciliation/workspaceBaseRef; no generic agent permission for operator source repair.

### `replay-and-deliver-resolution`

API: `present` — POST /api/issues/{id}/recovery-actions/resolve; GET /api/issues/{id}/recovery-actions. Server wake, reconciliation and chat outboxes own delivery.

Agent access: `partial` — permitted resolution followed by current eligible agent context; no arbitrary client self-wake.

Policy: Lock exact source/action. Same settled actionId returns retained receipt/no repeated log/wake. Todo wake only when required state/owner changed; reconciled executions use own durable delivery, restricted chat uses exact authorized failed request and real board user/current channel authority. No generic duplicate wake alongside durable owner.

Evidence: `source-only` — [recovery routes](../../server/src/routes/issues.ts), [reconciliation outbox](../../server/src/services/execution-recovery-resolution.ts); reviewed at `3bbc2104b65caf9f7763938a01260a5673e12f7a`. No live provider proof.

Verification: `not-run` — Repeat/concurrent same action and lost acknowledgment -> one recorded resolution/eligible continuation. Changed/new action/source never overwritten; restricted chat either retains exact provenance or stays unresolved.

Gaps: Receipt success isn't provider execution; actual retry may remain gated/pending.

## `source-action`

Capability ID: `recovery/source-action`.

Review: `operation-reviewed`.

Source-scoped repair ownership and retained files survive task status changes.

### `read-and-follow-owner`

API: `present` — GET /api/issues/{id}/recovery-actions; GET /api/issues/{id}; GET /api/heartbeat-runs/{runId}. Linked repair tasks retain their own access checks.

Agent access: `available` — permitted agent REST/native call_api reads and CLI issue recovery-actions for that operation; actual native rollout/run binding required.

Policy: Same-company task read authorization, private-task/responsible-user scope and run privacy where run detail is used. Related diagnostics omit unauthorized resource details. Original assignee, recovery owner and return owner remain distinct. Completion/cancellation doesn't remove physical workspace hold; retired notices shouldn't hide retained obligation.

Evidence: `source-only` — [recovery routes](../../server/src/routes/issues.ts), [source actions](../../server/src/services/issue-recovery-actions.ts); reviewed at `3bbc2104b65caf9f7763938a01260a5673e12f7a`. No live provider proof.

Verification: `not-run` — Follow source/repair/return owner, reload exact IDs; foreign/mismatched source hidden. Unresolved file hold persists after Done/cancelled.

Gaps: Repair task existence does not authorize source mutation or prove recovery.

### `record-retained-file-repair`

API: `present` — POST /api/issues/{id}/recovery-actions/resolve with exact actionId, restored outcome, unchanged source status and workspace repair evidence.

Agent access: `restricted` — board with accessible source and exact file/stop evidence. Current branch does not additionally enforce runtime:manage; agent REST/native denied.

Policy: Original terminal retained source validated independently: exact issue/run/lease receipt, stop/process/coordinator/no unreleased authority. Successful legacy source may record files only without changing its result. Preserve current status/owner/newer active action; no replay/wake. Same repair evidence receipt dedupes. Do not document stronger runtime grant than route enforces.

Evidence: `source-only` — [recovery routes](../../server/src/routes/issues.ts), [source/stop validation](../../server/src/services/execution-recovery-resolution.ts); reviewed at `3bbc2104b65caf9f7763938a01260a5673e12f7a`. No live provider proof.

Verification: `not-run` — Repair exact historical files, reload unchanged current owner/status/newer action and source result; no wake. Deny agent/foreign/run mismatch/running source/no stop evidence. Duplicate returns saved repair.

Gaps: Existing desired runtime-manager wording is stronger than implementation; product policy decision separate from map edits. Actual files/artifact must be verified before attestation.

### `add-new-execution-evidence`

API: `present` — POST /api/issues/{id}/recovery-actions/resolve with executionReconciliation on the exact settled automatic replay-blocked action.

Agent access: `restricted` — board; exact source read, restoration/status and independent execution evidence.

Policy: Can reopen matching settled no-replay disposition only restored/todo with no competing active action and new accepted source proof; plain repeat returns receipt. Active coordinator/newer turn/retained uncertain authority disallows blind replay.

Evidence: `source-only` — [recovery routes](../../server/src/routes/issues.ts), [reconciliation proof](../../server/src/services/execution-recovery-resolution.ts); reviewed at `3bbc2104b65caf9f7763938a01260a5673e12f7a`. No live provider proof.

Verification: `not-run` — New verified evidence permits one eligible delivery; duplicate safe. Competing current action or missing/mismatched evidence denied and audit history preserved.

Gaps: Elapsed timeout/client providerStopped flag alone is not proof.

## `exhaustion`

Capability ID: `recovery/exhaustion`.

Review: `operation-reviewed`.

Exhausted and overdue recovery advertises only the current eligible operator action.

### `read-attempt-budget`

API: `present` — GET /api/issues/{id}/recovery-actions; GET /api/issues/{id}; GET /api/heartbeat-runs/{runId}.

Agent access: `available` — permitted agent REST/native call_api reads and CLI issue recovery-actions for that operation; actual native rollout/run binding required.

Policy: Durable maxAttempts is execution budget; exhaustion retires automatic wake/monitor/timeout paths. Due-but-not-started retry differs from live retry. Same episode identity persists through equivalent ref spellings/new run IDs/classifier upgrades.

Evidence: `source-only` — [source actions](../../server/src/services/issue-recovery-actions.ts), [attempt display](../../ui/src/components/IssueRecoveryActionCard.tsx); reviewed at `3bbc2104b65caf9f7763938a01260a5673e12f7a`. No live provider proof.

Verification: `not-run` — Exhaust episode, reload count/gate/no additional automatic wake; overdue retry remains visible as missed rather than working.

Gaps: Reading attempts isn't qualification of every provider retry lane.

### `request-explicit-retry`

API: `present` — POST /api/issues/{id}/recovery-actions/resolve with exact actionId, restored outcome and todo source status, or the separately authorized workspace operation below.

Agent access: `partial` — source-permitted resolution; board-escalated/reconciliation/workspace decisions keep their explicit board gates.

Policy: Exhausted disposition still blocked, exact board-owned deliberate wait/board-escalation action and recorded return owner assigned/invokable; no blockers/pending interaction; normal handback pause/project/budget/approval/run gates. Cannot reset attempts from client.

Evidence: `source-only` — [recovery routes](../../server/src/routes/issues.ts), [retry control](../../ui/src/components/DispositionRecoveryNotice.tsx); reviewed at `3bbc2104b65caf9f7763938a01260a5673e12f7a`. No live provider proof.

Verification: `not-run` — One click waits real acknowledgment, reload one continuation; repeated click stale-owner/paused/blocker/question/budget cases rejected. No new episode budget from repeated request.

Gaps: An acknowledged retry can remain pending or fail; report actual useful result separately.

## `workspace`

Capability ID: `recovery/workspace`.

Committed authorized Retry and workspace-recovery requests notify the internal
preservation worker. Startup reconstructs its source-bound obligations and saved
retry deadlines. A duplicate request during physical preservation does not
replace the owner's generation or revision. Resolved files-only recovery retains
its no-replay restriction. The local PostgreSQL regression checks the producer,
worker, and physical source receipt; it is not deployed provider acceptance.

Connected board-message preparation failures use the canonical board Retry
owner only after the exact unchanged comment, original user wake, accepted
same-user identity and pre-provider settlement are certified. Admission and
execution recheck the pinned source and claimed successor receipts. Repeated
pre-provider failures retain the source only through each canonical intent,
failed dispatch and accepted parent identity; cycles and chains beyond twenty
links fail closed. This grants
no external inbound authority or permission to replay a terminal result; an
uncertifiable source directs the user to send a new task message. The real
HTTP/queue regression proves this boundary locally, not hosted provider recovery.

For external chat, the same canonical Retry owner may certify the structured
isolated-directory binding failure that occurs before environment allocation.
It requires exact task/source authority and trusted settlement with no process,
lease, native result or unknown execution evidence. Other validation reasons and
the older direct chat-retry entry point remain denied. Local HTTP/dispatch proof
does not establish hosted provider completion.

An authorized deliberate Retry also registers missing historical native
preservation from an exact prepared descriptor and an unowned terminal
finalization. It adopts only the existing bounded maintenance capability. A live
owner or mismatched allocation cannot supply this proof. No termination receipt
or execution authority is created by registration; connected Retry still waits
behind recovery and rechecks its existing external identity.

The internal preservation resume path grants no board or agent execution API.
It requires the exact source action, company, run, lease and environment, a
held physical workspace owner, and its current stop-only cleanup claim. The
ordinary resume and destruction fences still apply to protected sources. The
assembled-runtime regression checks this separation before any provider call.

Managed missing-source reconciliation uses the server-only Cloud
`POST /v1/tenant/sandbox-absence` protocol. A host-bound capability authenticates
the stack; board and agent credentials cannot call it. Core requires a fresh
Cloud signature for the exact company, issue, run, lease, allocation and physical
owner. This can establish execution absence, never recovered files or successful
task completion. Normal Retry admission and external-effect fences still apply.
Signature and PostgreSQL regressions are local evidence, not deployed acceptance.

Review: `operation-reviewed`.

Each workspace repair/export/reconstruction/physical-owner operation has its own proof and authority.

### `recover-retained-files`

API: `present` — POST /api/issues/{id}/recovery-actions/recover-workspace with actionId/runId/idempotencyKey.

Agent access: `restricted` — board task-read and issue:mutate; not runtime:manage. Agents denied through REST/native fallback.

Policy: Exact terminal retained source/lease/reference; independent stop and physical ownership checks; no newer writer. Bounded queued repair preserves newer files and has retry state. Matching key/recovered state dedupes; permanent blocked source refuses. Recovery starts no provider turn.

Evidence: `source-only` — [recovery routes](../../server/src/routes/issues.ts), [retained recovery](../../server/src/services/workspace-recovery.ts); reviewed at `3bbc2104b65caf9f7763938a01260a5673e12f7a`. No live provider proof.

Verification: `not-run` — Allowed board requests exact source, inspect persisted copied files/artifact and cleanup. Repeat key/transient retry bounded. Agent/wrong company/newer writer/uncertain owner/no stop denied.

Gaps: Client never certifies recovered files by posting this request; hosted recovery separately not-run.

### `retry-accepted-result-export`

API: `present` — POST /api/issues/{id}/recovery-actions/retry-workspace-export with exact actionId/runId/repairNote.

Agent access: `restricted` — board task read + runtime:manage; native agent call_api preserves denial.

Policy: Eligible native export-repair cause, saved result/coordinator/retained source and independent stop-only proof. Reuses original result/lease and bounded finalization, not provider execution. Pending duplicate audits once. Unsafe-export automatic path/manual admission and active exporter/new owner rejected.

Evidence: `source-only` — [recovery routes](../../server/src/routes/issues.ts), [export retry](../../server/src/services/native-runtime/native-workspace-export-retry.ts); reviewed at `3bbc2104b65caf9f7763938a01260a5673e12f7a`. No live provider proof.

Verification: `not-run` — Repaired sandbox export commits original accepted result without new provider turn; repeated click one audit/intent. Deny mismatched source/cause, active writer and unprivileged actor.

Gaps: Provider stop/probe/export must be actual evidence, not inferred from 202.

### `resume-after-owner-stop`

API: `present` — POST /api/issues/{id}/recovery-actions/resume-workspace-finalization with actionId/runId/ownerToken/stopped flag/stopEvidence.

Agent access: `restricted` — board task read + runtime:confirm_owner_stop; active company owner/admin, trusted local board or current instance admin. Ordinary runtime manager/agent denied.

Policy: Exact native owner/result/task/run; independent platform verification all controller+copyback children stopped. Lease expiry/advisory disconnect not proof. Active lock/local writer/newer run blocks. Exact replay dedupes; reconciler exports/commits saved result and retains approval/monitor waits without fresh provider turn.

Evidence: `source-only` — [recovery routes](../../server/src/routes/issues.ts), [owner proof](../../server/src/services/native-runtime/native-workspace-owner-recovery.ts), [administrator gate](../../server/src/services/authorization.ts); reviewed at `3bbc2104b65caf9f7763938a01260a5673e12f7a`. No live provider proof.

Verification: `not-run` — After actual platform stop proof permitted admin records exact owner; inspect original saved result/files/holds and no fresh turn. Deny wrong owner/member/runtime manager/agent/live writer/stale Cloud admin.

Gaps: Automatic managed-cloud signed stop proof is separate; never invent platform attestation for local acceptance.

### `reconstruct-destroyed-source`

API: `present` — POST /api/issues/{id}/recovery-actions/reconstruct-workspace with action/run/statusVersion/task attachments/lost-work acknowledgement/outcome evidence.

Agent access: `restricted` — board task read + runtime:manage.

Policy: Server confirms original source destruction, hashes same-task saved attachments, exact current status/source/no contradictory execution. Retained/uncertain source denied. Same request hash dedupes, changed request/state conflicts. Preserve failed old export/history/budget; one fresh normal-admission continuation from recorded sources. Intervening run cancellation proof remains exact.

Evidence: `source-only` — [recovery routes](../../server/src/routes/issues.ts), [reconstruction](../../server/src/services/native-runtime/native-workspace-reconstruction.ts); reviewed at `3bbc2104b65caf9f7763938a01260a5673e12f7a`. No live provider proof.

Verification: `not-run` — Inspect acknowledged lost edits/selected hashes and actual reconstructed files. Retry/concurrent same request one continuation; wrong/private attachment, retained source/status change/false destruction denied.

Gaps: Original unexported edits remain lost; fresh reconstruction isn't successful original export or permission to replay completed external effects.

### `source-files-only-repair`

API: `present` — POST /api/issues/{id}/recovery-actions/resolve with unchanged source status and exact file-repair evidence.

Agent access: `restricted` — board with readable source and exact source/action/run proof. This branch does not independently check runtime:manage.

Policy: Record recovered-file evidence only after independent stopped-source validation. Keep the original result and current task status, owner and execution unchanged; do not reopen or wake work. No invented runtime grant can be inferred from the map.

Evidence: `source-only` — [recovery routes](../../server/src/routes/issues.ts), [file evidence](../../server/src/services/execution-recovery-resolution.ts); reviewed at `3bbc2104b65caf9f7763938a01260a5673e12f7a`. No live provider proof.

Verification: `not-run` — Repair a matching retained-file obligation and reload its evidence. Reject missing/stale stop/source proof and agent identity. Compare unchanged task status, accepted result, owner and run count.

Gaps: This is the actual route boundary. The stronger runtime:manage requirement on dedicated workspace operations must not be imputed to generic file-only resolution.

### `repair-starting-branch`

API: `present` — POST /api/issues/{id}/recovery-actions/resolve with the matching workspaceBaseRef repair shape.

Agent access: `restricted` — board with runtime:manage, readable source, exact recovery action and eligible source mutation authority.

Policy: Require the current blocked configuration_incomplete/base_ref_unresolved failure, matching assignee/project/requested ref and effective git-worktree strategy. Replacement branch differs from the failed ref. Reject stale configuration, incompatible reconciliation evidence or mismatched source; normal retry admission remains required.

Evidence: `source-only` — [recovery routes](../../server/src/routes/issues.ts), [file evidence](../../server/src/services/execution-recovery-resolution.ts); reviewed at `3bbc2104b65caf9f7763938a01260a5673e12f7a`. No live provider proof.

Verification: `not-run` — Repair a matching failed starting ref, reload the saved effective strategy and observe one eligible retry. Reject ordinary non-manager, agent, changed ref/project/owner/configuration and stale action.

Gaps: The simple CLI resolve wrapper does not express this branch-repair shape. Source-file-only repair above has different authority and effects.

### `reconcile-branch`

API: `present` — POST /api/execution-workspaces/{id}/reconcile-branch modes forward, override or quarantine_restore.

Agent access: `restricted` — board + workspace privacy + runtime:manage; agent/native fallback denied.

Policy: Source task required. Forward re-inspects ancestry or confirmed missing recorded ref+clean resolved target. Override requires reason and current inspection. Quarantine_restore preserves dirty work on rescue ref, respects physical/runtime contention. No browser ancestry hint substitutes source check.

Evidence: `source-only` — [branch route](../../server/src/routes/execution-workspaces.ts), [branch/filesystem checks](../../server/src/services/execution-workspaces.ts), [mode schema](../../packages/shared/src/validators/execution-workspace.ts); reviewed at `3bbc2104b65caf9f7763938a01260a5673e12f7a`. No live provider proof.

Verification: `not-run` — Exercise offered mode on disposable branches, preserve before/after files/rescue ref and audit. Deny unrelated workspace/private/agent/no grant, wrong ancestry/no reason/live writer. Reload binding and actual files.

Gaps: No dedicated CLI reconciliation wrapper found; 202/toast isn't filesystem integrity proof.

## `unknown-outcome`

Capability ID: `recovery/unknown-outcome`.

Review: `operation-reviewed`.

Inspect actual side effects before explicit source-specific operator resolution.

### `inspect-and-reconcile-execution`

API: `present` — GET /api/issues/{id}/recovery-actions; GET /api/heartbeat-runs/{runId}; POST /api/issues/{id}/recovery-actions/resolve with exact run and executionReconciliation evidence.

Agent access: `restricted` — source read plus board execution-reconciliation decision; agent may inspect own permitted context, not attest provider state.

Policy: Server independently checks terminal source/task/owner or reviewer, stopped leases/process, no coordinator/successor/unreleased authority and workspace evidence. Outcome completed/not_performed/mixed informs continuation without repeating completed effects. Matching source-only file repair requests do not enqueue work.

Evidence: `source-only` — [recovery routes](../../server/src/routes/issues.ts), [execution proof](../../server/src/services/execution-recovery-resolution.ts); reviewed at `3bbc2104b65caf9f7763938a01260a5673e12f7a`. No live provider proof.

Verification: `not-run` — Inspect external provider first; wrong source/flag without stop evidence/live owner denied. Record truthful outcome -> one eligible continuation or retained hold; duplicate doesn't replay.

Gaps: Unknown stays unknown until corroborated. Evidence text alone can't override independent fences.

### `resolve-chat-publication`

API: `present` — POST /api/chat-endpoints/{endpointId}/publications/{publicationId}/resolve action mark_delivered/retry_anyway/cancel, optional fileTransfer phase/version.

Agent access: `restricted` — board endpoint/company + tools:manage_connections (local implicit/instance-admin exceptions) and board user ID.

Policy: Only current delivery_unknown; credential lease/exact publication; stage-specific Teams/Slack/Photon rules and current phase apply. mark delivered/cancel settle; retry_anyway explicitly records duplicate risk and schedules bounded send. Terminal interaction prompt can't retry stale actions.

Evidence: `source-only` — [channel management](../../server/src/routes/chat-channels.ts), [publication resolution](../../server/src/services/chat-channels/publications/resolution.ts); reviewed at `3bbc2104b65caf9f7763938a01260a5673e12f7a`. No live provider proof.

Verification: `not-run` — Inspect real provider, choose truthful resolution, reload/audit exact source/result. Agent/no connection grant/wrong endpoint/stale phase/nonunknown state denied. Retry must not silently duplicate.

Gaps: Accepted send request isn't recipient receipt; per-provider live proof required.

### `replay-failed-publication-or-resolve-action`

API: `present` — POST /api/chat-endpoints/{endpointId}/publications/{publicationId}/replay; POST /api/chat-endpoints/{endpointId}/actions/{actionId}/resolve.

Agent access: `restricted` — endpoint-management board/company/tools:manage_connections; resolve requires board user ID.

Policy: Replay only failed state, expected attempt generation, live pending interaction prompt; delivery_unknown and stage-owned file transfer reject generic replay. Action resolution dispatches authoritative provider_effect or Slack task-start contract with mark_delivered/retry_anyway/cancel; no arbitrary execution retry.

Evidence: `source-only` — [replay and effects](../../server/src/services/chat-channels/publications/resolution.ts), [action kind dispatch](../../server/src/services/chat-channels.ts), [route gates](../../server/src/routes/chat-channels.ts); reviewed at `3bbc2104b65caf9f7763938a01260a5673e12f7a`. No live provider proof.

Verification: `not-run` — Blind uncertain replay denied, failed eligible replay one generation. Resolve actual provider effect/task-start after inspection; races/wrong source/stale action no extra effect.

Gaps: No dedicated agent/CLI decision path; provider-specific stage semantics remain explicit gaps.

### `resolve-uncertain-email`

API: `present` — POST /api/companies/{companyId}/email/deliveries/{publicationId}/resolve outcome sent/failed plus providerMessageId.

Agent access: `restricted` — board company + tools:manage_connections (local implicit/instance-admin exceptions).

Policy: Only current uncertain send under endpoint/thread lease. sent requires live provider read proving exact inbox, x-paperclip-publication-id and sent label; failed marks provider-not-sent and requires new explicit send. Repeat settled request conflicts; never auto-resend unknown email.

Evidence: `source-only` — [email manager](../../server/src/routes/email.ts), [provider proof](../../server/src/services/email-channels.ts); reviewed at `3bbc2104b65caf9f7763938a01260a5673e12f7a`. No live provider proof.

Verification: `not-run` — Use actual uncertain disposable send; wrong inbox/header/label/message ID rejected, truthful sent/failed persists. Failed resolution emits no new send; competing decisions one outcome.

Gaps: Fixture AgentMail response isn't live provider inspection; public assistant/native agent cannot approve unknown outcome.

## `user-continuation`

Capability ID: `recovery/user-continuation`.

Review: `operation-reviewed`.

Saved post-stop instructions wait for real cleanup and normal execution authority.

### `save-and-observe-wait`

API: `present` — POST /api/issues/{id}/comments; GET /api/issues/{id}; GET /api/issues/{id}/comments; GET /api/issues/{id}/queued-comments; GET /api/heartbeat-runs/{runId}.

Agent access: `partial` — human author creates own instruction; agent REST/CLI/native report_progress creates attributed agent content, never human identity.

Policy: Ordinary source-task comment/steering company/privacy/responsible-user policy; saved message independent of provider stop. Existing operator Stop with no new instruction respected. No new client API to manufacture saved-human provenance.

Evidence: `source-only` — [recovery routes](../../server/src/routes/issues.ts), [saved continuation](../../server/src/services/conversation-continuation.ts), [waiting messages](../../ui/src/components/task-chat/TaskChatQueuedMessages.tsx); reviewed at `3bbc2104b65caf9f7763938a01260a5673e12f7a`. No live provider proof.

Verification: `not-run` — Stop disposable owned run, submit distinct follow-ups during cleanup; reload sees ordered waiting messages without premature turn. Deny foreign/private/wrong identity.

Gaps: Comment acknowledgment isn't agent answer or cleanup completion.

### `admit-once-after-stop`

API: `present` — GET /api/issues/{id}; GET /api/heartbeat-runs/{runId}. Server reconsideration uses normal admission; there is no unrestricted retry endpoint.

Agent access: `partial` — eligible admitted agent/native bound wake receives saved input; delivery remains server-owned.

Policy: Exact prior run/lease/workspace stop proof, no competing execution, current owner/responsible user, normal subtree/project pause/budget/review gates. Durable ordered message/wake receipts avoid duplicates; never borrow authority from stale callback/other routine. Unused hold-denied admission needs no-execution/dispatch evidence before automatic reconsideration.

A human-authored comment attached to an assignment wake can authorize the same
fresh continuation as an ordinary comment. The server validates the persisted
comment and its task/author/timing; the assignment label alone grants no
authority. Agents and system wakes cannot inherit this human-input path.

Evidence: `source-only` — [legacy gates](../../server/src/services/recovery/legacy-continuation.ts), [native ownership](../../server/src/services/native-runtime/native-restart-recovery.ts), [queued Stop](../../server/src/modules/wake-queue/adapters/postgres.ts); reviewed at `3bbc2104b65caf9f7763938a01260a5673e12f7a`. No live provider proof.

Verification: `not-run` — After confirmed cleanup one useful continuation consumes saved order; repeat sweep/reload no duplicate. Pause/budget/approval/unknown external outcome and reassignment prevent stale admission. Queued Stop leaves another routine cycle intact.

Gaps: Legacy/native/channel runtimes separately qualify; preserve original undispatched-hold and callback regressions.

## `reconnect`

Capability ID: `recovery/reconnect`.

Review: `operation-reviewed`.

Browser transport recovery refetches persisted state without implying runner recovery.

### `subscribe-and-filter`

API: `present` — GET /api/companies/{companyId}/events/ws with WebSocket Upgrade; GET /api/issues/{id} and GET /api/heartbeat-runs/{runId} remain separate REST reads.

Agent access: `partial` — browser session/trusted Cloud identity or local implicit board; standard unrevoked same-company agent API key via actual WS client. Native call_api cannot Upgrade; scoped keys/native JWT/personal MCP bearer not this path.

Policy: Upgrade membership/company checks; scoped key scopeConfig rejected. Delivery-time key/member and issue/project/run/skill/case privacy rechecks; redacted invalidation payload doesn't confer detail read. Personal MCP Events is a distinct protocol/authority.

Evidence: `source-only` — [WS admission/filter](../../server/src/realtime/live-events-ws.ts); reviewed at `3bbc2104b65caf9f7763938a01260a5673e12f7a`. No live provider proof.

Verification: `not-run` — Permitted browser/key gets only authorized events; foreign/scoped/revoked key/member/private resource denied/filtered after subscription. REST details still enforce own ACL.

Gaps: Actual WS client isn't automatically present in native run; avoid query tokens in evidence despite source compatibility.

### `disconnect-poll-and-refresh`

API: `present` — GET /api/issues/{id}; GET /api/heartbeat-runs/{runId}; reconnect through the same WebSocket protocol. No event-replay API is implied.

Agent access: `partial` — LiveUpdatesProvider browser recovery; agents can poll permitted reads or use actual installed protocol client.

Policy: Bounded reconnect backoff; failed socket fallback polling, healthy open stops polling and invalidates active queries including initial-subscription gap. Events aren't replayed. Hidden/unmounted stops relevant loops; stale socket ignored; reconnect toast suppression distinct from content delivery.

Evidence: `source-only` — [browser recovery](../../ui/src/context/LiveUpdatesProvider.tsx); reviewed at `3bbc2104b65caf9f7763938a01260a5673e12f7a`. No live provider proof.

Verification: `not-run` — Disconnect while server changes task/run/decision; reconnect/visibility return/refetch matches reload without duplicate comments/decisions/toasts. Initial-open gap and hidden/unmount loops checked.

Gaps: Healthy socket proves transport only, not provider restart or successful failed task. Mocks not deployed network proof.
