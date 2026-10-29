# Task creation and lifecycle — agent access

Product map: [Task creation and lifecycle](../feature-map/tasks.md).

Feature ID: `tasks`.

Source revision: `3bbc2104b65caf9f7763938a01260a5673e12f7a`.

Review depth and executed proof are separate. The operation records enumerate the named behavior and access boundaries. Their evidence states describe the reviewed sources; run results and environment limits belong in the PR or verification artifacts. A listed API or source test does not establish a live authorized journey. Follow the [map contract](../README.md).

Operation review of the six existing task capabilities at `3bbc2104b65caf9f7763938a01260a5673e12f7a`. Evidence remains source-only and live verification not-run. Legacy agent REST/CLI require the actual issued identity, company and run context. Native tools require their advertised binding, running native run, current assignment/executionRunId, company/budget/actor authority and responsible-user privacy intersection. Generic native search_api/call_api additionally requires operator rollout admission and a permitted current mode; ordinary mutations are restricted in Ask/Plan, and Muse excludes generic API. GET/HEAD and title PUT are separate mode exceptions. See [native transport](README.md#native-rest-transport), [paperclip-runner-tool-authority.ts](../../server/src/services/native-runtime/paperclip-runner-tool-authority.ts), [runner-api-rollout.ts](../../server/src/services/native-runtime/runner-api-rollout.ts) and [runner-api-catalog.ts](../../server/src/services/native-runtime/runner-api-catalog.ts). Declared scenario tools are not production admission. Detailed coordination, questions, steering, documents, goals, workspaces and recovery subflows retain their own maps; the following records enumerate their task-facing entry points without claiming those engines are completely qualified.

## `create`

Capability ID: `tasks/create`.

Review: `operation-reviewed`.

Create ordinary work, retry safely, and create child/accepted-plan work with the correct parent and attribution.

### `create-task`

API: `present` — POST /api/companies/{companyId}/issues.

Agent access: `partial` — legacy agent REST; CLI issue create; admitted native create_task for its narrow advertised fields, call_api for other permitted fields.

Policy: Title OR nonblank description; assigned omission defaults todo, unassigned omission backlog. Same-company readable parent/project/origin run, tasks:assign and eligible agent/active company person. Agent responsibleUserId rejected; creator attribution server-derived. Skill-test creation forbidden; trust/watchdog/task-bridge ceilings, delegation cycles and host-command denials remain. Native title required, maximum 500 characters, backlog|todo only, standard mode, fixed active-task parent (standalone project work in conversation), default caller assignee; no advertised privacy/labels/mode/workspace/review config. CLI requires title, supports --standalone/--parent-id but lacks many rich fields.

Evidence: `source-only` — reviewed at `3bbc2104b65caf9f7763938a01260a5673e12f7a`; [issues.ts](../../server/src/routes/issues.ts), [issue.ts](../../packages/shared/src/validators/issue.ts), [paperclip-runner-tool-authority.ts](../../server/src/services/native-runtime/paperclip-runner-tool-authority.ts), [issue.ts](../../cli/src/commands/client/issue.ts), [issue-assigned-backlog-contract-routes.test.ts](../../server/src/__tests__/issue-assigned-backlog-contract-routes.test.ts), [issue-agent-mutation-ownership-routes.test.ts](../../server/src/__tests__/issue-agent-mutation-ownership-routes.test.ts), [task-creation-backlog.test.ts](../../server/src/services/native-runtime/task-creation-backlog.test.ts). No live execution claimed.

Verification: `not-run` — Create unassigned backlog and assigned todo; reload saved content/context/attribution and verify no backlog wake vs one eligible todo wake. Reject foreign/inaccessible parent/project, unavailable assignee, spoofed responsible user, skill-test create and agent host commands. Compare actual native and REST paths.

Gaps: Native/CLI field parity is incomplete. Rich fields require an actually admitted REST fallback; no native/remote CLI availability assumed.

### `retry-create`

API: `present` — POST /api/companies/{companyId}/issues with a stable idempotencyKey, duplicate policy and optional initialPlan.

Agent access: `partial` — REST/call_api and native create_task stable key; CLI create has no idempotency-key flag.

Policy: REST deduplicated reuse responds 200 with reason; new task 201. allowDuplicate skips recent-title guard but not key replay. Native durable child origin/fingerprint rejects changed arguments and repairs one durable dispatch on replay. Replays retain current authorization.

Evidence: `source-only` — reviewed at `3bbc2104b65caf9f7763938a01260a5673e12f7a`; [issues.ts](../../server/src/routes/issues.ts), [issue.ts](../../packages/shared/src/validators/issue.ts), [paperclip-runner-tool-authority.ts](../../server/src/services/native-runtime/paperclip-runner-tool-authority.ts), [issue-create-deduplication-routes.test.ts](../../server/src/__tests__/issue-create-deduplication-routes.test.ts). No live execution claimed.

Verification: `not-run` — Repeat identical key after uncertain response; assert same task/plan and one wake. Changed native input/key conflicts. Test recent-title reuse and explicit duplicate separately.

Gaps: No exactly-once external execution inferred from a receipt or single returned ID.

### `create-child-or-plan-batch`

API: `present` — POST /api/issues/{id}/children; GET/POST /api/issues/{id}/accepted-plan-decompositions.

Agent access: `partial` — agent REST/call_api; CLI issue child:create --payload-json; dedicated create_task is one current-task child, not arbitrary-parent/batch.

Policy: Readable same-company parent and write influence, tasks:assign, normal creation restrictions. Child API fixes parent/inheritance; acceptanceCriteria maximum 20 entries, 500 characters each; blockParentUntilDone. Batch binds acceptedPlanRevisionId and 1..25 child definitions, with no stale/unaccepted-plan substitution. Source privacy follows child/handoff.

Evidence: `source-only` — reviewed at `3bbc2104b65caf9f7763938a01260a5673e12f7a`; [issues.ts](../../server/src/routes/issues.ts), [issue.ts](../../packages/shared/src/validators/issue.ts), [paperclip-runner-tool-authority.ts](../../server/src/services/native-runtime/paperclip-runner-tool-authority.ts), [issue.ts](../../cli/src/commands/client/issue.ts), [issue-agent-mutation-ownership-routes.test.ts](../../server/src/__tests__/issue-agent-mutation-ownership-routes.test.ts). No live execution claimed.

Verification: `not-run` — Create child and accepted-plan batch; reload parent/children/criteria/blockers, reject foreign parent/stale plan and verify retry adds no duplicate work. Follow [coordination](../feature-map/task-coordination.md) and [plan review](../feature-map/questions-and-approvals.md) for their engines.

Gaps: Accepted-plan approval/decomposition engine remains owned by its detailed companion review; this record covers task creation entry/limits.

## `organize`

Capability ID: `tasks/organize`.

Review: `operation-reviewed`.

Read task collections, navigation projections and blocked counts; distinguish domain reads from browser layout state.

### `list-filter-page`

API: `present` — GET /api/companies/{companyId}/issues; optional view=compact.

Agent access: `partial` — REST/call_api full query; CLI issue list exposes status/agent/project and local --match on one fetched page; native search_tasks query up to 500 characters, statuses, and a declared limit 1..200; production clamps the limit to 1..100 (default 50), without full paging/project/label/workspace knobs.

Policy: Company/read privacy filtering and inaccessible edge redaction; task-bridge company list denied. Default 500, maximum 1000, offset>=0, sortField updated|id, sortDir asc|desc, afterId. Supports status/assignee/participant/project/workspace/parent/descendant/label/origin/text/date and routine/plugin/blocker query groups. includeAgentCreatedTasks=false filters independent roots before search/pagination; omission retains agent/API behavior. includeParticipatedTasks and user me filters require board identity. Compact ETag is actor-private; 429 is not empty results.

Evidence: `source-only` — reviewed at `3bbc2104b65caf9f7763938a01260a5673e12f7a`; [issues.ts](../../server/src/routes/issues.ts), [issues.ts](../../server/src/services/issues.ts), [paperclip-runner-tool-authority.ts](../../server/src/services/native-runtime/paperclip-runner-tool-authority.ts), [issue.ts](../../cli/src/commands/client/issue.ts), [issues-list-query-parsing.test.ts](../../server/src/__tests__/issues-list-query-parsing.test.ts), [issues-creation-visibility.test.ts](../../server/src/__tests__/issues-creation-visibility.test.ts), [issue-list-assignee-filter-routes.test.ts](../../server/src/__tests__/issue-list-assignee-filter-routes.test.ts), [private-json-etag.test.ts](../../server/src/__tests__/private-json-etag.test.ts). No live execution claimed.

Verification: `not-run` — Compare human/agent/routine/channel tasks, list/compact/full filters and ID pagination without duplicates or inaccessible rows. Reject invalid boolean/date/sort/limit and agent human-only/task-bridge query. Preserve failed/429 result visibly. Request native limit 200 and confirm the production result contains at most 100 tasks.

Gaps: Bounded native search and one-page CLI local match are not complete company-search substitutes.

### `read-task-and-summaries`

API: `present` — GET /api/issues/{id} (optional `view=core` omits related enrichment); GET /api/companies/{companyId}/issues/summaries?ids=... .

Agent access: `partial` — REST/CLI issue get; native get_task_context reads CURRENT task only; call_api for eligible arbitrary task/summaries. No dedicated summaries CLI/tool.

Policy: Company/task issue:read; exact identifiers resolved in company context. Summary strict query 1..5 UUIDs/no extra parameters, no-store, omits missing/hidden/private/foreign IDs; task-bridge denied. Locked/redacted parent/project/blocker context does not grant read.

Evidence: `source-only` — reviewed at `3bbc2104b65caf9f7763938a01260a5673e12f7a`; [issues.ts](../../server/src/routes/issues.ts), [paperclip-runner-tool-authority.ts](../../server/src/services/native-runtime/paperclip-runner-tool-authority.ts), [issue.ts](../../cli/src/commands/client/issue.ts), [issue-summaries-routes.test.ts](../../server/src/__tests__/issue-summaries-routes.test.ts), [issue-identifier-routes.test.ts](../../server/src/__tests__/issue-identifier-routes.test.ts), [issue-access-grants-routes.test.ts](../../server/src/__tests__/issue-access-grants-routes.test.ts). No live execution claimed.

Verification: `not-run` — Cold-open current task/identifier, reload after rename, batch own/private/missing/foreign IDs and compare exact navigation fields. Switch company/account, reject private/full read and ensure no stale actor content.

Gaps: A summary result proves neither workspace inspection nor full task/comment access.

### `blocked-count`

API: `present` — GET /api/companies/{companyId}/issues/count?attention=blocked.

Agent access: `available` — agent REST/admitted call_api; no dedicated CLI/native count.

Policy: Company/actor/read filters and low-trust boundaries apply. Task-bridge denied; attention=blocked required, limit/offset rejected; supported collection filters shape visible count.

Evidence: `source-only` — reviewed at `3bbc2104b65caf9f7763938a01260a5673e12f7a`; [issues.ts](../../server/src/routes/issues.ts), [issue-blocker-attention.test.ts](../../server/src/__tests__/issue-blocker-attention.test.ts). No live execution claimed.

Verification: `not-run` — Compare count to accessible filtered blocked tasks, including inaccessible fixtures; reject other attention/pagination and foreign company.

Gaps: A count is not proof the underlying blocker can be resolved.

### `collection-presentation`

API: `not-applicable` — list/board, grouping/sort/columns/hierarchy/expanded rows and saved collection preference are browser presentation; resource reads use listed APIs.

Agent access: `not-applicable` — no agent layout API; permitted underlying task data is separate.

Policy: IssuesList loads/saves browser preferences by company/collection, with separate agent-created visibility. Contextual ancestors/descendants do not become unrelated independent results. No shared server view preference inferred.

Evidence: `source-only` — reviewed at `3bbc2104b65caf9f7763938a01260a5673e12f7a`; [IssuesList.tsx](../../ui/src/components/IssuesList.tsx), [Issues.tsx](../../ui/src/pages/Issues.tsx), [Issues.test.tsx](../../ui/src/pages/Issues.test.tsx). No live execution claimed.

Verification: `not-run` — Set list/board/grouping/columns, hide/show automation, search child, open task/back and reload. Verify company/collection scope and Clear filters hidden-automation default; failed read stays visible.

Gaps: Issues.test.tsx covers helpers/URL/paging/constants, not a mounted real-browser list journey. Full shell permutations remain live scope.

## `properties`

Capability ID: `tasks/properties`.

Review: `operation-reviewed`.

Separate rename, generic metadata, company labels, assignment, blockers, execution configuration, monitor and watchdog contracts.

### `rename`

API: `present` — PUT /api/issues/{id}/title; PATCH /api/issues/{id} title is a distinct metadata path.

Agent access: `partial` — native set_task_title is active/current-task-only; REST/call_api dedicated PUT; CLI issue update --title uses PATCH and lacks provisional/retry-key fields.

Policy: The dedicated title path validates trimmed input, supports onlyIfProvisional, and accepts an optional retry key. Agent must be assigned active RUNNING run bound to exact task/current execution/checkout and chat generation. Board cannot supply run retry key. The per-run receipt limit applies; same-key replay never overwrites later human edit, changed arguments409. Generic PATCH has different policy.

Evidence: `source-only` — reviewed at `3bbc2104b65caf9f7763938a01260a5673e12f7a`; [issues.ts](../../server/src/routes/issues.ts), [issue-title.ts](../../server/src/services/issue-title.ts), [paperclip-runner-tool-authority.ts](../../server/src/services/native-runtime/paperclip-runner-tool-authority.ts), [issue.ts](../../cli/src/commands/client/issue.ts), [task-title-routes.test.ts](../../server/src/__tests__/task-title-routes.test.ts). No live execution claimed.

Verification: `not-run` — Rename/reload references; onlyIfProvisional no-op after human rename. Replay accepted key after later human edit preserves edit. Reject stale/nonowner/idle run, changed key arguments and blank title.

Gaps: Do not claim visible peer PATCH authority grants dedicated title authority.

### `edit-metadata-context`

API: `present` — PATCH /api/issues/{id}: description, priority, billing/request depth, labels, goal/project/parent and supported metadata.

Agent access: `partial` — REST/call_api; CLI update exposes a subset, lacking human assignment, label IDs, mode/review/adapter/workspace configuration and CAS flags; no dedicated generic native editor.

Policy: PATCH uses issue:read and issue:mutate with visible-idle-peer writes; another assignee active lock requires management override, own in-progress writes current checkout/run. Same-company readable parent/project and service-valid goals/relations; reject cycles, forged onBehalfOfUserId and agent host commands. Priority API exists but ordinary priority UI editing is hidden.

Evidence: `source-only` — reviewed at `3bbc2104b65caf9f7763938a01260a5673e12f7a`; [issues.ts](../../server/src/routes/issues.ts), [issue.ts](../../packages/shared/src/validators/issue.ts), [issues.ts](../../server/src/services/issues.ts), [issue.ts](../../cli/src/commands/client/issue.ts), [IssueProperties.tsx](../../ui/src/components/issue-properties/IssueProperties.tsx), [issue-agent-mutation-ownership-routes.test.ts](../../server/src/__tests__/issue-agent-mutation-ownership-routes.test.ts), [issue-workspace-command-authz.test.ts](../../server/src/__tests__/issue-workspace-command-authz.test.ts). No live execution claimed.

Verification: `not-run` — Persist each property group after reload; verify context/ref/count changes without gratuitous execution restart. Reject foreign/private project/parent/goal, cycles, spoof attribution and agent host commands.

Gaps: Goal/workspace engines and configuration variants retain their owning maps; metadata persistence is not usable runtime evidence.

### `manage-labels`

API: `present` — GET/POST /api/companies/{companyId}/labels; DELETE /api/labels/{labelId}; PATCH task labelIds for attach/detach.

Agent access: `available` — agent REST/call_api; CLI issue label:list/create/delete for catalog, task labelIds via REST; no dedicated native labels tool.

Policy: Actual catalog routes use company access/resource lookup, without added board role gate. Name trim1..48, color#RRGGBB. Task label attach/detach retains task mutation rules; deleting label affects catalog, not just one task.

Evidence: `source-only` — reviewed at `3bbc2104b65caf9f7763938a01260a5673e12f7a`; [issues.ts](../../server/src/routes/issues.ts), [issue.ts](../../packages/shared/src/validators/issue.ts), [issue.ts](../../cli/src/commands/client/issue.ts), [IssueProperties.tsx](../../ui/src/components/issue-properties/IssueProperties.tsx). No live execution claimed.

Verification: `not-run` — Create/attach label, filter tasks, reload, detach and delete disposable label. Reject invalid name/color, foreign company and denied task write.

Gaps: No live label workflow claimed; do not confuse catalog delete with per-task detach.

### `assign-reassign`

API: `present` — PATCH /api/issues/{id} assigneeAgentId/assigneeUserId.

Agent access: `partial` — REST/call_api; CLI agent assignment only; native reassign_task for another eligible task, never own active task.

Policy: tasks:assign with exact target/project/parent; eligible agent or active person, single assignee. Stop old run before transfer; unconfirmed stop409. Narrow signed legacy current-run self→human handoff can finish; late outgoing edits denied; board/native/key/agent transfer keeps stop rules. Native reassignment requires a retry key, reason, expected owner and status version, denies current task/conversations/terminal/in_review/pending review; preserves blocked/backlog and durable wake replay.

Evidence: `source-only` — reviewed at `3bbc2104b65caf9f7763938a01260a5673e12f7a`; [issues.ts](../../server/src/routes/issues.ts), [paperclip-runner-tool-authority.ts](../../server/src/services/native-runtime/paperclip-runner-tool-authority.ts), [issue.ts](../../cli/src/commands/client/issue.ts), [reassign-task.ts](../../packages/paperclip-runner/src/protocol-actions/reassign-task.ts), [issue-agent-mutation-ownership-routes.test.ts](../../server/src/__tests__/issue-agent-mutation-ownership-routes.test.ts), [task-reassignment.test.ts](../../server/src/services/native-runtime/task-reassignment.test.ts). No live execution claimed.

Verification: `not-run` — Reload recipient/ownership, race expected-version reassignments and inspect single handoff/wake. Compare legacy self→human final report with board stop; reject late write, stale owner/version and foreign/unavailable recipient.

Gaps: Detailed delegation and governed review handoffs remain [task coordination](task-coordination.md).

### `set-dependencies`

API: `present` — PATCH /api/issues/{id} blockedByIssueIds replaces whole set.

Agent access: `partial` — native set_dependencies CURRENT task/standard mode/key+array; REST/call_api arbitrary permitted target; CLI update lacks blocker-set flag.

Policy: Task mutation and valid same-company, nonself/noncycle dependencies. Preserve existing blockers explicitly when replacing. Native Muse additionally checks blocker read. Eligible continuation retains pause/budget/responsible-user/finalization authority.

Evidence: `source-only` — reviewed at `3bbc2104b65caf9f7763938a01260a5673e12f7a`; [issues.ts](../../server/src/routes/issues.ts), [issues.ts](../../server/src/services/issues.ts), [paperclip-runner-tool-authority.ts](../../server/src/services/native-runtime/paperclip-runner-tool-authority.ts), [issue-dependency-wakeups-routes.test.ts](../../server/src/__tests__/issue-dependency-wakeups-routes.test.ts), [issue-dependency-restore-wake-policy.test.ts](../../server/src/__tests__/issue-dependency-restore-wake-policy.test.ts). No live execution claimed.

Verification: `not-run` — Add/replace/remove blockers and reload; reject self/foreign/cycle. Finish prerequisite and verify one eligible dependent continuation, not inferred business success from cancelled status.

Gaps: Detailed readiness and wake variants belong [dependencies](task-coordination.md#dependencies).

### `configure-execution`

API: `present` — PATCH /api/issues/{id}: workMode/harnessKind, reviewPolicy/executionPolicy, assigneeAdapterOverrides and supported workspace settings.

Agent access: `partial` — permitted REST/call_api fields; no general CLI/native configuration tool. Native mode restrictions apply to current call, regardless of requested future mode.

Policy: Policy CAS expectedExecutionPolicy must accompany policy-only write; stale conflict, no smuggled owner/status. Existing governed stage actor/resolver remains authoritative. MCP OAuth cannot participate in review/pending stage or active execution (MCP_REVIEW_REQUIRED/MCP_ACTIVE_EXECUTION). Same-company supported environment; no agent host commands. Saved override is not proof authorized account/runtime.

Evidence: `source-only` — reviewed at `3bbc2104b65caf9f7763938a01260a5673e12f7a`; [issues.ts](../../server/src/routes/issues.ts), [issue.ts](../../packages/shared/src/validators/issue.ts), [runner-api-catalog.ts](../../server/src/services/native-runtime/runner-api-catalog.ts), [issue-execution-policy-routes.test.ts](../../server/src/__tests__/issue-execution-policy-routes.test.ts), [issue-execution-policy-persistence.test.ts](../../server/src/__tests__/issue-execution-policy-persistence.test.ts), [issue-workspace-command-authz.test.ts](../../server/src/__tests__/issue-workspace-command-authz.test.ts). No live execution claimed.

Verification: `not-run` — Persist config then inspect subsequent actual run mode/model. Reject stale/mixed CAS, foreign environment, agent host commands and restricted-mode mutation; verify no denied request stops existing execution.

Gaps: Review/workspace/runtime engines remain separately reviewed; broad account/provider/config permutations not claimed.

### `manage-monitor`

API: `present` — PATCH /api/issues/{id} with executionPolicy.monitor; POST /api/issues/{id}/monitor/check-now; GET /api/issues/{id}/diagnostics/wakes.

Agent access: `partial` — native set_task_monitor standard-mode binding; permitted agent REST/call_api policy PATCH/check-now; no CLI monitor flags. No REST operation named set_task_monitor. Queue and HTTP/2 sandbox callbacks admit the wake-diagnostics read and monitor check-now request. Controller task-read, monitor-management and assignment checks still apply. Recovery resolution and scheduled-retry controls are outside this callback allowance. See the [callback bridge](../../packages/adapter-utils/src/sandbox-callback-bridge.ts) and [callback boundary tests](../../packages/adapter-utils/src/sandbox-callback-context-routes.test.ts).

Policy: Native nested monitor|null, optional OWNED target taskId, key<=240, notes1..500, future check/timeouts/attempts<=100; reserved quota service denied, externalRef sanitized. Target assigned same agent/no human, in_progress|in_review; issue:read,runtime:manage,responsible-user authority. REST monitor changes require runtime:manage+current assignee for agent; board role gate differs. Receipt replay returns current schedule without rearming consumed monitor. Human check-now may request one check of a blocked task with a retained monitor; agents and automatic ticks still require in_progress|in_review. This does not change status or bypass dependency, recovery, finalization, pause, budget or ownership gates. Provider-quota recovery uses a direct retry path and stays paused on blocked tasks; check-now rejects it before consuming the schedule. A skipped check-now returns 409 instead of success.

Evidence: `source-only` — reviewed at `3bbc2104b65caf9f7763938a01260a5673e12f7a`; [issues.ts](../../server/src/routes/issues.ts), [paperclip-runner-tool-authority.ts](../../server/src/services/native-runtime/paperclip-runner-tool-authority.ts), [issue-monitors.ts](../../server/src/services/issue-monitors.ts), [issue-monitor-scheduler.test.ts](../../server/src/__tests__/issue-monitor-scheduler.test.ts), [task-monitor.integration.test.ts](../../server/src/services/native-runtime/task-monitor.integration.test.ts), [scheduling.test.ts](../../server/src/services/heartbeat/scheduling.test.ts). No live execution claimed.

Verification: `not-run` — Schedule/reload/yield monitor wait→one wake and consumption; replace/clear, malformed schema correction and consumed-key replay. Deny mode/owner/time/reserved service. Recovery/finalization hold retains due schedule and throttled issue.monitor_deferred; settle/clear then one wake; expiry uses recorded policy with no duplicate escalation or successor ownership change.

Gaps: Retain existing detailed PostgreSQL scheduler/native-monitor/late-result regression boundaries; scripted/no-op execution is not live model recovery.

### `manage-watchdog`

API: `present` — GET/PUT/DELETE /api/issues/{id}/watchdog; PUT{agentId,instructions?}; create can attach watchdog.

Agent access: `partial` — agent REST/call_api with exact issue authority; no dedicated native/CLI watchdog editor.

Policy: Read task; mutations stricter task helper, low-trust denial and eligible company watchdog agent. Watchdog-scoped run cannot change watchdog configuration even in watched subtree. Remove disables active config and queues evaluation; repeated disable returnsok.

Evidence: `source-only` — reviewed at `3bbc2104b65caf9f7763938a01260a5673e12f7a`; [issues.ts](../../server/src/routes/issues.ts), [task-watchdogs.ts](../../server/src/services/task-watchdogs.ts), [issue-watchdogs-routes.test.ts](../../server/src/__tests__/issue-watchdogs-routes.test.ts). No live execution claimed.

Verification: `not-run` — Set/update/remove, reload config/activity; retry no duplicate active watcher. Deny wrong company, active peer ownership, low-trust and watchdog self-configuration.

Gaps: Watchdog execution/recovery acceptance remains [recovery](recovery.md), beyond this config operation.

## `discussion`

Capability ID: `tasks/discussion`.

Review: `operation-reviewed`.

Read, append/retry, author-delete or queued-cancel messages, attach allowed files, and distinguish human feedback from agent reporting.

### `read-history-comment`

API: `present` — GET /api/issues/{id}/comments and /comments/{commentId}; GET /api/issues/{id}/recent-comments returns four latest comments plus the latest human comment, a cursor, and `hasMore`. The compact read also includes the first human instruction when there is no description. Cold task views use `GET /api/issues/{id}/activity?view=recent` (50 rows) and `/runs?view=recent` (two summaries) without changing the default full-read contracts. It uses the same issue authorization and run/trust redaction.

Agent access: `available` — REST/call_api, CLI issue comments/comment:get; native get_task_history CURRENT task only, declared limit 1..200 but production clamps to 1..100 (default 50).

Policy: Company/task issue:read, exact task/comment binding, run/trust redaction. API supports after/afterCommentId, asc|desc, limit cap500. Locked mention edge is not comment read authority.

Evidence: `source-only` — reviewed at `3bbc2104b65caf9f7763938a01260a5673e12f7a`; [issues.ts](../../server/src/routes/issues.ts), [paperclip-runner-tool-authority.ts](../../server/src/services/native-runtime/paperclip-runner-tool-authority.ts), [issue.ts](../../cli/src/commands/client/issue.ts), [issue-comment-redaction.test.ts](../../server/src/__tests__/issue-comment-redaction.test.ts), [issue-agent-mutation-ownership-routes.test.ts](../../server/src/__tests__/issue-agent-mutation-ownership-routes.test.ts). No live execution claimed.

Verification: `not-run` — Read multipage history and exact comment, reload same content; reject inaccessible task, foreign/mismatched comment and inspect trust redaction. Request native limit 200 and confirm at most 100 comments.

The same authorized activity route supports `view=comment-inputs&commentIds=<comma-separated UUIDs>` for original comment/steering facts. Each request accepts at most 100 comment IDs and returns at most two facts per comment, scoped to the accessible issue and company. This preserves delivered-input state when its receipt is older than the recent activity window.

Gaps: Native bounded history is not an arbitrary-task/paginated API substitute. The new UI preview route has no dedicated native tool or CLI command. Existing full comment reads remain available.

### `append-retry-comment`

API: `present` — POST /api/issues/{id}/comments; PATCH task with comment.

Agent access: `partial` — REST/call_api, CLI issue comment/update--comment; native report_progress plain CURRENT-task body+stable key only. answer_status_question is declared but not production-admitted.

Policy: issue:comment/responsible-user/influence ceilings may allow peer/direct-parent reporting without disposition authority. body nonempty, clientRequestId UUID, maximum 20 unique attachment IDs. Agent onBehalfOfUserId rejected; presentation/metadata board-only; authorType cannot gain board wake. A new board comment on a paused task returns 409. An ordinary board comment whose same-task, same-user request key was already accepted repairs its reference/activity records and returns that receipt before task mutations; different text conflicts without reopening work. Completion serializes on the same-company task/comment and does not duplicate the activity. Board Agent Chat additionally flag/owner/clientRequestId. Pending/running retries preserved by ordinary board comments; explicit control separate.

Evidence: `source-only` — reviewed at `3bbc2104b65caf9f7763938a01260a5673e12f7a`; [issues.ts](../../server/src/routes/issues.ts), [issue.ts](../../packages/shared/src/validators/issue.ts), [paperclip-runner-tool-authority.ts](../../server/src/services/native-runtime/paperclip-runner-tool-authority.ts), [issue.ts](../../cli/src/commands/client/issue.ts), [issue-comment-attribution-audit-routes.test.ts](../../server/src/__tests__/issue-comment-attribution-audit-routes.test.ts), [issue-comment-reopen-routes.test.ts](../../server/src/__tests__/issue-comment-reopen-routes.test.ts), [cross-issue-influence-limit-postgres.test.ts](../../server/src/__tests__/cross-issue-influence-limit-postgres.test.ts). No live execution claimed.

Verification: `not-run` — Append/mention/reference/file, reload actor/content. Retry same request/key after uncertain response→single message; changed native args conflict. Deny spoof/structured agent fields, foreign task and pause-gated board message; closed peer report stays inert.

Gaps: Conversation, queued delivery, steering, human question continuation and artifacts retain owning recipes; saved message is not delivery/continuation proof.

### `delete-own-or-cancel-queued`

API: `present` — DELETE /api/issues/{id}/comments/{commentId}; mode=cancel is distinct legacy queued-cancel path.

Agent access: `partial` — REST/call_api and CLI issue comment:delete; no dedicated native delete.

Policy: Stricter task mutation before author check; only own comment normal deletion. Tombstones and scrubbed references/annotations/training snapshots; repeated deleted result stable. Queued cancel must still own cancelable queue; delivery race409. No general delivered-comment editor.

Evidence: `source-only` — reviewed at `3bbc2104b65caf9f7763938a01260a5673e12f7a`; [issues.ts](../../server/src/routes/issues.ts), [issue.ts](../../cli/src/commands/client/issue.ts), [issue-comment-cancel-routes.test.ts](../../server/src/__tests__/issue-comment-cancel-routes.test.ts), [issue-queued-comments-routes.test.ts](../../server/src/__tests__/issue-queued-comments-routes.test.ts). No live execution claimed.

Verification: `not-run` — Delete own/reload tombstone/derived cleanup and retry; reject other-author/foreign task. Race queued cancel vs dispatch and inspect persisted winner.

Gaps: Modern queue edit/order/steer/interrupt/discard contract remains [steering](steering.md).

### `attach-reference`

API: `present` — GET task attachments; POST /api/companies/{companyId}/issues/{issueId}/attachments multipart; GET /api/attachments/{attachmentId}/content; DELETE /api/attachments/{attachmentId}.

Agent access: `partial` — REST/CLI attachments/upload/download/delete; admitted native multipart call_api or scoped register_deliverable/current-task attachment tools according to actual binding. report_progress is not upload.

Policy: Company/task binding, stricter mutation and deliverable run-context gates. Nonempty permitted bytes, default 10 MiB deployment ceiling via PAPERCLIP_ATTACHMENT_MAX_BYTES; bound conversation owner/flag. In-progress agent requires run; CLI multipart forwards header. Content reads enforce retained task/run privacy including removed records.

Evidence: `source-only` — reviewed at `3bbc2104b65caf9f7763938a01260a5673e12f7a`; [issues.ts](../../server/src/routes/issues.ts), [issue.ts](../../cli/src/commands/client/issue.ts), [attachment-types.ts](../../server/src/attachment-types.ts), [issue-attachment-routes.test.ts](../../server/src/__tests__/issue-attachment-routes.test.ts), [privacy-production-review.test.ts](../../server/src/__tests__/privacy-production-review.test.ts). No live execution claimed.

Verification: `not-run` — Upload/read/download compare bytes/reload, reject foreign comment/task/wrong run and missing/empty/disallowed/oversize file; delete disposable attachment and verify no read disclosure.

Gaps: Document/work-product/annotation detail and live upload journey belong [documents/artifacts](documents-artifacts.md); pathname alone is not uploaded deliverable.

### `human-feedback-vote`

API: `present` — GET/POST /api/issues/{id}/feedback-votes; POST targetType,targetId,vote,reason<=1000,allowSharing.

Agent access: `restricted` — board identity only; CLI issue feedback:votes/feedback:vote still requires board context; no delegated/native agent voting tool. Human-input request can ask, not impersonate.

Policy: Actual handlers require company-accessible issue lookup and board; GET own user votes. Explicit selected sharing may persist preference/queue export;201 does not wait for remote upload. Do not infer private-task read guard absent from these handlers.

Evidence: `source-only` — reviewed at `3bbc2104b65caf9f7763938a01260a5673e12f7a`; [issues.ts](../../server/src/routes/issues.ts), [feedback.ts](../../packages/shared/src/validators/feedback.ts), [feedback.ts](../../server/src/services/feedback.ts), [issue-feedback-routes.test.ts](../../server/src/__tests__/issue-feedback-routes.test.ts), [feedback-service.test.ts](../../server/src/__tests__/feedback-service.test.ts). No live execution claimed.

Verification: `not-run` — Vote disposable AI target, reload same-user preference and another user separately; reject agent/foreign company; inspect selected consent and queued state without claiming export completion.

Gaps: Private-task denial must be proved, not invented. Trace/report/export belongs [feedback export](cli-operations.md#feedback-export).

## `completion`

Capability ID: `tasks/completion`.

Task chat may group adjacent run and recovery errors for display. The API
retains all run and comment records. This presentation does not change retry,
approval, checkout or company access. See the
[presentation coverage](../feature-map/tasks.md#task-detail).

Review: `operation-reviewed`.

Separate status/report acceptance, versioned start, follow-up, checkout/release and deletion; accepted provider report is not final task state.

### `transition-report-review`

API: `present` — PATCH /api/issues/{id}; POST /api/issues/{id}/stalled-review-decision for board; native paperclip_finish/paperclip_block uses admitted PRP protocol, not a REST endpoint.

Agent access: `partial` — authorized REST/call_api and CLI status updates; native actual PRP completion/block tools. finish_task/block_task/request_review declarations are excluded from production IMPLEMENTED_OPERATIONS.

Policy: Task mutation/run/assignment/recovery/resolver gates. Blocked requires unresolved blocker/pending input/approval or unblockDescriptor; agent can name only SELF unblock owner. In_review requires actionable path. Native bound completion contract/criterion revision, deliverable evidence and verification must agree; done rejects unfinished work; needs_review names valid different reviewer. Pending input/approval/review/blocker can keep task open. Final state commits after provider turn/workspace finalization; report never overwrites successor/already terminal state.

Evidence: `source-only` — reviewed at `3bbc2104b65caf9f7763938a01260a5673e12f7a`; [issues.ts](../../server/src/routes/issues.ts), [paperclip-runner-tool-authority.ts](../../server/src/services/native-runtime/paperclip-runner-tool-authority.ts), [native-completion-feedback.ts](../../server/src/services/native-runtime/native-completion-feedback.ts), [native-completion-feedback.test.ts](../../server/src/services/native-runtime/native-completion-feedback.test.ts), [native-deliverable-feedback.test.ts](../../server/src/services/native-runtime/native-deliverable-feedback.test.ts), [paperclip-runner-tool-authority.test.ts](../../server/src/services/native-runtime/paperclip-runner-tool-authority.test.ts), [issue-stalled-review-decision-routes.test.ts](../../server/src/__tests__/issue-stalled-review-decision-routes.test.ts). No live execution claimed.

Verification: `not-run` — Actual native accepted report→provider stop→workspace finalization→persisted status/output; stale/failed report correction without repeating work. Test blocked/review/done, pending question/blocker, invalid/self/foreign reviewer, missing output and duplicate report.

Gaps: Governed review/approval engines remain [questions/approvals](questions-and-approvals.md); protocol report acceptance is not immediate status commit.

### `start-backlog-cas`

API: `present` — PATCH /api/issues/{id} exactly{status:todo,expectedStatusVersion:N}, N>=0.

Agent access: `partial` — agent REST/admitted call_api; CLI update has no expectedStatusVersion; native create_task creates backlog but does not promote existing task.

Policy: Status-only backlog→todo compare under row lock. Intervening status/assignment version including ABA409/no wake; mixed fields422. Existing assignment/run/responsible-user/eligibility gates remain.

Evidence: `source-only` — reviewed at `3bbc2104b65caf9f7763938a01260a5673e12f7a`; [issues.ts](../../server/src/routes/issues.ts), [issues.ts](../../server/src/services/issues.ts), [issue-status-version-route-service.test.ts](../../server/src/__tests__/issue-status-version-route-service.test.ts). No live execution claimed.

Verification: `not-run` — Fresh version start→one eligible wake; race another change and replay old version→unchanged conflict, no second wake; mixed field denial.

Gaps: Use fresh authoritative response; a matching displayed status is not matching version.

### `follow-up-reopen-restore`

API: `present` — POST /api/issues/{id}/comments or PATCH /api/issues/{id} with a comment and explicit resume/reopen where permitted; tree restore is a separate operation in the coordination map.

Agent access: `partial` — REST/call_api and CLI comment--resume/--reopen; report_progress alone is not resume authority; no generic dedicated native reopen tool.

Policy: Resume requires comment, eligible assignee, no unresolved blockers/pause and current actor/responsible-user/control authority. Bare cancelled status/reopen uses dedicated restore; structured resume has separate branch. Closed peer reporting inert. Ordinary board comment preserves active/queued retry; parked retry may supersede. Closed workspace restores only after authority gates. MCP pending review/active execution stays blocked.

Evidence: `source-only` — reviewed at `3bbc2104b65caf9f7763938a01260a5673e12f7a`; [issues.ts](../../server/src/routes/issues.ts), [issue.ts](../../cli/src/commands/client/issue.ts), [issue-comment-reopen-routes.test.ts](../../server/src/__tests__/issue-comment-reopen-routes.test.ts), [issue-update-comment-wakeup-routes.test.ts](../../server/src/__tests__/issue-update-comment-wakeup-routes.test.ts), [issue-scheduled-retry-routes.test.ts](../../server/src/__tests__/issue-scheduled-retry-routes.test.ts), [issue-closed-workspace-routes.test.ts](../../server/src/__tests__/issue-closed-workspace-routes.test.ts). No live execution claimed.

Verification: `not-run` — Finish then authorized follow-up→same-task one continuation; plain terminal assignee note stays terminal. Reject paused/blocked/cancelled invalid path/wrong owner. Board message during running retry keeps same executor; parked retry supersedes once.

Gaps: Steering/tree control/recovery recipes own pause/restore/stop and retry repair; do not broaden comment authority.

### `checkout`

API: `present` — POST /api/issues/{id}/checkout{agentId,expectedStatuses}.

Agent access: `partial` — REST/CLI issue checkout; agent must claim itself with run ID. Native call_api only where actual admitted run needs it; native is normally already bound.

Policy: Company lookup, tasks:assign when changing assignee, assignability, project pause/budget, subtree pause, dependency readiness and atomic expected status/assignee/execution locks. Same-run retry differs from competing run. Run-id gate before closed workspace reopen. Exact handler differs from generic read/mutation helper; do not invent blanket guard.

Evidence: `source-only` — reviewed at `3bbc2104b65caf9f7763938a01260a5673e12f7a`; [issues.ts](../../server/src/routes/issues.ts), [issues.ts](../../server/src/services/issues.ts), [issue.ts](../../cli/src/commands/client/issue.ts), [issues-checkout-wakeup.test.ts](../../server/src/__tests__/issues-checkout-wakeup.test.ts), [issue-stale-execution-lock-routes.test.ts](../../server/src/__tests__/issue-stale-execution-lock-routes.test.ts), [issue-closed-workspace-routes.test.ts](../../server/src/__tests__/issue-closed-workspace-routes.test.ts). No live execution claimed.

Verification: `not-run` — Race two claimants: one owner/executor; same-run retry no duplicate wake. Deny wrong agent/missing run, blocked dependencies, paused project and foreign company; inspect persisted locks.

Gaps: Private-target admission requires negative proof because checkout does not mirror generic issue-read guard placement.

### `release-force-release`

API: `present` — POST /api/issues/{id}/release; POST /api/issues/{id}/admin/force-release?clearAssignee=true(optional).

Agent access: `partial` — REST/call_api/CLI issue release permitted owner path; force-release requires board user (CLI command does not confer role); no dedicated native release.

Policy: Normal release stricter mutation, agent run+assignee/matching live checkout; stale missing/terminal lock handled safely. In_progress→todo clears assignee/locks; terminal keeps historic assignee while clearing locks. Force-release explicit clearAssignee and audit, not verified process stop.

Evidence: `source-only` — reviewed at `3bbc2104b65caf9f7763938a01260a5673e12f7a`; [issues.ts](../../server/src/routes/issues.ts), [issues.ts](../../server/src/services/issues.ts), [issue.ts](../../cli/src/commands/client/issue.ts), [issue-stale-execution-lock-routes.test.ts](../../server/src/__tests__/issue-stale-execution-lock-routes.test.ts), [issues-service.test.ts](../../server/src/__tests__/issues-service.test.ts). No live execution claimed.

Verification: `not-run` — Owner release/reload, wrong live agent/run denied, stale lock handling; terminal assignment preserved; agent force-release denied and board prior-lock audit retained.

Gaps: Use [recovery](recovery.md) for verified termination; clearing locks alone is not provider-stop evidence.

### `delete-task`

API: `present` — DELETE /api/issues/{id}.

Agent access: `partial` — permitted REST/call_api and CLI issue delete--yes; no dedicated native deletion.

Policy: Stricter task mutation including active ownership/run constraints; company/task boundaries. Service removes task-owned rows; attachment object cleanup best effort with logged failures. Delete differs from complete/hide/archive; never imply unrelated child erasure.

Evidence: `source-only` — reviewed at `3bbc2104b65caf9f7763938a01260a5673e12f7a`; [issues.ts](../../server/src/routes/issues.ts), [issues.ts](../../server/src/services/issues.ts), [issue.ts](../../cli/src/commands/client/issue.ts), [issue-remove-cascade.test.ts](../../server/src/__tests__/issue-remove-cascade.test.ts). No live execution claimed.

Verification: `not-run` — Delete disposable task/files, inspect list/direct reads/cascades and inaccessible orphan content; reject wrong actor/company, repeat404. Preserve unrelated records per actual service behavior.

Gaps: Storage cleanup failure and retention are distinct from returned task removal; parent removal is not proof all children vanished.

## `privacy`

Capability ID: `tasks/privacy`.

Review: `operation-reviewed`.

Treat restriction, audience inspection, direct sharing/revocation, publishing and explicit emergency read as distinct operations.

### `create-restrict-private`

API: `present` — POST scoped issues visibility=private; PATCH /api/issues/{id} visibility=private.

Agent access: `partial` — authorized agent REST/call_api restriction; native create_task has no privacy field but inherits source privacy; CLI create/update lacks visibility.

Policy: Read/mutation/current authority; standalone private requires responsible user/personal private project. Parent/private project/source-run privacy provenance protects descendants and standalone handoffs. Server derives responsible identity; management authority is exact task, never privacy-root authority.

Evidence: `source-only` — reviewed at `3bbc2104b65caf9f7763938a01260a5673e12f7a`; [issues.ts](../../server/src/routes/issues.ts), [issues.ts](../../server/src/services/issues.ts), [paperclip-runner-tool-authority.ts](../../server/src/services/native-runtime/paperclip-runner-tool-authority.ts), [privacy-production-review.test.ts](../../server/src/__tests__/privacy-production-review.test.ts), [issue-access-grants-routes.test.ts](../../server/src/__tests__/issue-access-grants-routes.test.ts). No live execution claimed.

Verification: `not-run` — Private create/restrict→reload; protect existing/new descendants and private-run standalone handoff. Ordinary other user cannot discover/open; wrong actor/spoof responsible identity denied.

Gaps: App-record privacy is not filesystem isolation or memory erasure.

### `inspect-constraints-grants`

API: `present` — GET /api/issues/{id}/privacy-constraints; GET /api/issues/{id}/access-grants.

Agent access: `restricted` — authorized BOARD manager; agents/shared readers can read eligible task but cannot inspect grants/action hints. Catalog GET label does not override route.

Policy: Issue read then board responsible user/creator/human assignee, active company owner/admin, instance admin/local implicit. Safe publicBlockedBy/leavesPersonalProject hints omit inaccessible scope identity. Lists direct/inherited owner/assignment/project sources; inherited rows no local revoke.

Evidence: `source-only` — reviewed at `3bbc2104b65caf9f7763938a01260a5673e12f7a`; [issues.ts](../../server/src/routes/issues.ts), [authorization.ts](../../server/src/services/authorization.ts), [IssueShareSheet.tsx](../../ui/src/components/IssueShareSheet.tsx), [PrivateTaskPrivacyControls.test.tsx](../../ui/src/components/PrivateTaskPrivacyControls.test.tsx), [privacy-production-review.test.ts](../../server/src/__tests__/privacy-production-review.test.ts). No live execution claimed.

Verification: `not-run` — Manager sees correct audience/hints after reload; reader/agent403 and inaccessible404. No unreadable parent/project names.

Gaps: Management role does not automatically grant normal private task read; use actual actor/read branch.

### `share-directly`

API: `present` — POST /api/issues/{id}/access-grants{subjectType:user|agent,subjectId}.

Agent access: `restricted` — authorized board manager; no CLI/dedicated native grant tool or delegated agent share. Human-input request can ask responsible person.

Policy: Exact readable managed task; active company user/company agent only(422 invalid); open task returns 409. Created201/existing active200. Read flows downward descendants, never parent/sibling/private project metadata. Shared agent access intersects responsible/authorizing user; memory warning cannot promise unlearning.

Evidence: `source-only` — reviewed at `3bbc2104b65caf9f7763938a01260a5673e12f7a`; [issues.ts](../../server/src/routes/issues.ts), [authorization.ts](../../server/src/services/authorization.ts), [issue-access-grants-routes.test.ts](../../server/src/__tests__/issue-access-grants-routes.test.ts), [privacy-production-review.test.ts](../../server/src/__tests__/privacy-production-review.test.ts). No live execution claimed.

Verification: `not-run` — Share child/reload both people: child+descendants visible, parent/sibling/project hidden. Repeat share one grant. Reject open/foreign/nonmember and shared-reader/agent mutation.

Gaps: A grant alone does not authorize shared agent acting for another unauthorized person.

### `revoke-direct-inherited`

API: `present` — POST /api/issues/{id}/access-grants/{grantId}/revoke; inherited source edits use ancestor grant/project membership APIs.

Agent access: `restricted` — authorized board manager; no agent delegation established.

Policy: Grant must belong to EXACT managed task, active matching grant else404; child manager cannot revoke ancestor/sibling. Other assignment/project/ancestor grants remain; assignment grants sticky after unassignment until revoked. Implicit owner access changes via role not local revoke. Live reads reauthorize; memory cannot be erased.

Evidence: `source-only` — reviewed at `3bbc2104b65caf9f7763938a01260a5673e12f7a`; [issues.ts](../../server/src/routes/issues.ts), [authorization.ts](../../server/src/services/authorization.ts), [IssueShareSheet.tsx](../../ui/src/components/IssueShareSheet.tsx), [issue-access-grants-routes.test.ts](../../server/src/__tests__/issue-access-grants-routes.test.ts), [privacy-production-review.test.ts](../../server/src/__tests__/privacy-production-review.test.ts). No live execution claimed.

Verification: `not-run` — Revoke/reload/retry cold/direct/socket access with no independent source→denied. Source-edit inherited access separately, independent source retained. Reject wrong ancestor/sibling grant and repeat404.

Gaps: A successful direct revoke does not prove complete audience removal if independent sources remain.

### `publish-private`

API: `present` — PATCH /api/issues/{id} visibility=open.

Agent access: `restricted` — authorized board manager; agent call_api cannot publish.

Policy: Private parent/nonpersonal private project blocks; personal-project task may leave personal project. Confirmation discloses task/comments/docs/history; private children stay private. Current constraints rechecked under privacy-tree lock, not just optimistic hints.

Evidence: `source-only` — reviewed at `3bbc2104b65caf9f7763938a01260a5673e12f7a`; [issues.ts](../../server/src/routes/issues.ts), [issues.ts](../../server/src/services/issues.ts), [IssuePrivacyActions.tsx](../../ui/src/components/IssuePrivacyActions.tsx), [PrivateTaskPrivacyControls.test.tsx](../../ui/src/components/PrivateTaskPrivacyControls.test.tsx), [privacy-production-review.test.ts](../../server/src/__tests__/privacy-production-review.test.ts). No live execution claimed.

Verification: `not-run` — Cancel confirmation leaves private; valid publish visible after reload/private child remains denied. Reject private parent/project and raced stale constraint; deny agent widening.

Gaps: Do not infer existing private descendants became public from parent or project discovery.

### `break-glass-read`

API: `present` — GET /api/issues/{id}?breakGlass=true.

Agent access: `restricted` — eligible board company owner/admin explicit read, no agent path; instance/local normal admin bypass separate.

Policy: Private-read denial plus eligible explicit owner/admin gate; emits audit and owner-visible issue notice, not persistent share or arbitrary grant mutation. Ordinary member flag still404.

Evidence: `source-only` — reviewed at `3bbc2104b65caf9f7763938a01260a5673e12f7a`; [issues.ts](../../server/src/routes/issues.ts), [issue-access-grants-routes.test.ts](../../server/src/__tests__/issue-access-grants-routes.test.ts). No live execution claimed.

Verification: `not-run` — Compare eligible owner/admin ordinary denied with explicit read/audit+notice; ordinary operator/agent/foreign denied, grants unchanged.

Gaps: Local implicit/instance admin bypass cannot establish ordinary two-user private isolation.
