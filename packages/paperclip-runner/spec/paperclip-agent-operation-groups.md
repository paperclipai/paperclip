<!-- GENERATED FILE — DO NOT EDIT. Run `pnpm --filter @paperclipai/paperclip-runner exec tsx scripts/generate-operation-groups.ts`. -->

# Paperclip agent operation groups

Status: canonical explanatory contract for the Paperclip runner V1 surface.

This document keeps three independent meanings of **group** separate. PRP families describe wire evidence and controller commands; capability placement decides who owns an operation; behavioral eval groups organize the 106 scenario corpus. None of the three axes can be used as a substitute for another.

The generated totals are **105 PRP events in 31 event families**, **18 controller commands in 7 command families**, **10 control-plane operations**, **41 reconciled semantic operations** (14 always, 27 optional), and **106 scenarios in 16 behavior groups**.

## Axis 1: PRP v1 event and command families

PRP records ordered, replayable execution evidence. It is not the model's Paperclip tool API. Events are ordered per `sourceInstanceId`; duplicate `sourceEventId` values are idempotent; source-sequence gaps remain evidence; replay is side-effect free; unknown required versions fail closed.

### Event families

| Family | Purpose | Events | Count |
| --- | --- | --- | ---: |
| `runner` | Runner connection, drain, and diagnostic lifecycle. | `runner.connected`<br>`runner.reconnected`<br>`runner.reconciled`<br>`runner.disconnected`<br>`runner.draining`<br>`runner.backpressure`<br>`runner.suspending`<br>`runner.suspended`<br>`runner.stopped`<br>`runner.diagnostic` | 10 |
| `runtime` | Runner phase transitions. | `runtime.phase.changed` | 1 |
| `sandbox` | Sandbox resource measurements. | `sandbox.metric` | 1 |
| `workspace` | Workspace readiness. | `workspace.ready`<br>`workspace.change.updated`<br>`workspace.diff.recorded`<br>`workspace.file.referenced` | 4 |
| `harness` | Provider harness startup, readiness, exit, and diagnostics. | `harness.starting`<br>`harness.ready`<br>`harness.exited`<br>`harness.diagnostic` | 4 |
| `plan` | Complete provider-authored within-turn checklist snapshots, separate from durable Paperclip Plan documents. | `plan.updated` | 1 |
| `tool` | Provider-neutral process, MCP, dynamic, and built-in execution activity. | `tool.execution.started`<br>`tool.execution.progressed`<br>`tool.execution.completed` | 3 |
| `research` | Provider-reported search, page-open, and in-page research activity. | `research.started`<br>`research.progressed`<br>`research.completed` | 3 |
| `delegation` | Child-agent delegation lifecycle and aggregate status. | `delegation.started`<br>`delegation.updated`<br>`delegation.completed` | 3 |
| `model` | Requested/effective model routing and verification state. | `model.route.changed`<br>`model.verification.updated` | 2 |
| `context` | Context-window compaction markers without hidden summaries. | `context.compacted` | 1 |
| `artifact` | Authorized artifact viewing and structured generated outputs. | `artifact.viewed`<br>`artifact.generated` | 2 |
| `review` | Provider review-mode state, separate from Paperclip authority. | `review.mode.changed` | 1 |
| `hook` | Bounded provider hook lifecycle and blocking outcomes. | `hook.started`<br>`hook.completed` | 2 |
| `memory` | Authorized or unavailable memory citation references. | `memory.citation.referenced` | 1 |
| `safety` | Provider safety review state attached to governed work. | `safety.review.started`<br>`safety.review.completed` | 2 |
| `terminal` | Content-free terminal input activity metadata. | `terminal.input.sent` | 1 |
| `wait` | Intentional provider waits, distinct from warm idle and human input. | `wait.started`<br>`wait.completed` | 2 |
| `provider` | Redacted provider notices and actionable warnings. | `provider.notice.recorded` | 1 |
| `session` | Provider-neutral session open, resume, reconciliation, close, and failure. | `session.starting`<br>`session.started`<br>`session.resuming`<br>`session.resumed`<br>`session.reconciled`<br>`session.updated`<br>`session.closed`<br>`session.failed` | 8 |
| `turn` | Model turn submission through terminal turn disposition. | `turn.submitted`<br>`turn.accepted`<br>`turn.started`<br>`turn.completed`<br>`turn.failed`<br>`turn.interrupted`<br>`turn.cancelled` | 7 |
| `item` | Provider-neutral model/tool item lifecycle. | `item.started`<br>`item.delta`<br>`item.completed`<br>`item.failed` | 4 |
| `usage` | Provider/model-attributed usage and accounting boundaries. | `usage.reported` | 1 |
| `semantic_tool` | Canonical authorized Paperclip tool input and result evidence. | `semantic_tool.input`<br>`semantic_tool.result`<br>`semantic_tool.reconciled` | 3 |
| `mcp_app` | MCP App discovery, initialization, tool, action, host-context, and teardown evidence. | `mcp_app.discovered`<br>`mcp_app.resource.resolved`<br>`mcp_app.initializing`<br>`mcp_app.ready`<br>`mcp_app.tool_input`<br>`mcp_app.tool_result`<br>`mcp_app.action.requested`<br>`mcp_app.action.resolved`<br>`mcp_app.host_context.changed`<br>`mcp_app.failed`<br>`mcp_app.teardown` | 11 |
| `runtime_request` | Runtime permission/input request lifecycle. | `runtime_request.created`<br>`runtime_request.resolved`<br>`runtime_request.expired`<br>`runtime_request.cancelled` | 4 |
| `interaction` | Issue-thread interaction proposal, materialization, response, delivery, and rejection. | `interaction.request.proposed`<br>`interaction.request.materialized`<br>`interaction.request.rejected`<br>`interaction.response.progressed`<br>`interaction.response.resolved`<br>`interaction.response.delivered` | 6 |
| `run` | Structured result negotiation and terminal run outcome. | `run.attached`<br>`run.detached`<br>`run.result.proposed`<br>`run.result.accepted`<br>`run.result.rejected`<br>`run.terminal` | 6 |
| `attention` | Continuation and attention routing lifecycle. | `attention.request.proposed`<br>`attention.request.routed`<br>`attention.request.resolved`<br>`attention.request.expired`<br>`attention.request.superseded` | 5 |
| `work` | Recorded work-assessment evidence. | `work.assessment.recorded` | 1 |
| `issue` | Issue-status decision proposal outcome and application evidence. | `issue.status.decision.recorded`<br>`issue.status.decision.applied`<br>`issue.status.decision.rejected`<br>`issue.status.decision.superseded` | 4 |

### Controller-command families

| Family | Purpose | Commands | Count |
| --- | --- | --- | ---: |
| `run` | Prepare or cancel a run. | `run.prepare`<br>`run.attach`<br>`run.cancel` | 3 |
| `session` | Open, snapshot, or close a normalized provider session. | `session.open`<br>`session.snapshot`<br>`session.close`<br>`session.budget.increase`<br>`session.destroy` | 5 |
| `turn` | Start, steer, interrupt, or stop a model turn. | `turn.start`<br>`turn.steer`<br>`turn.interrupt`<br>`turn.stop` | 4 |
| `request` | Resolve a pending runtime request. | `request.resolve` | 1 |
| `interaction` | Acknowledge delivery of an interaction response. | `interaction.receipt` | 1 |
| `semantic_tool` | Returns an authorized, correlated Paperclip tool result to the provider through runnerd. | `semantic_tool.result` | 1 |
| `runner` | Drain or shut down the runner process. | `runner.drain`<br>`runner.suspend`<br>`runner.shutdown` | 3 |

## Axis 2: capability placement

Placement has exactly three outcomes:

- `control_plane_owned`: Paperclip or the runner performs the operation; it is absent from the model tool catalog.
- `always_agent_tool`: every eligible active-task run receives the operation after task-mode and actor checks.
- `optional_agent_tool`: the operation is exposed only when every declared claim, task-mode, role, and policy condition passes.

### Control-plane-owned operations

| Operation | Why it is not a model tool |
| --- | --- |
| `checkout_task` | Atomic checkout and execution-lock ownership. |
| `release_task` | Run cleanup and checkout release. |
| `select_work` | Scoped wake/inbox work selection. |
| `route_wake` | Attention, blocker, interaction, approval, and continuation routing. |
| `enforce_budget` | Budget hard stop, pause, and run-stop reason. |
| `append_audit_record` | Immutable mutation evidence. |
| `persist_run` | Durable run/event/checkpoint persistence. |
| `replay_run` | Side-effect-free replay and reconstruction. |
| `schedule_blocker_wake` | Dependency-resolution wake scheduling. |
| `reconcile_run` | Work assessment, terminal status arbitration, and recovery reconciliation. |

### Always-agent operations (14)

`answer_status_question`, `block_task`, `finish_task`, `get_task_context`, `get_task_history`, `inspect_operation_result`, `list_document_revisions`, `list_documents`, `read_document`, `register_deliverable`, `report_progress`, `request_human_input`, `request_review`, `write_document`.

### Optional operations (27) and grant groups (11)

Grant groups are documentation/exposure bundles, not additional authority. The operation descriptor's exact `requiredClaims` remains decisive.

| Grant group | Operations | Required claims represented | Purpose |
| --- | --- | --- | --- |
| `discovery` | `search_tasks`<br>`list_agents`<br>`get_agent`<br>`list_projects`<br>`list_goals` | `discovery:agents:read`<br>`discovery:goals:read`<br>`discovery:projects:read`<br>`discovery:tasks:read` | Company-visible task, agent, project, and goal discovery. |
| `delegation_dependencies` | `create_task`<br>`set_dependencies` | `delegation:tasks:create`<br>`dependencies:write` | Create delegated work and maintain dependency edges. |
| `governance` | `list_approvals`<br>`get_approval`<br>`get_approval_context`<br>`request_approval`<br>`decide_approval`<br>`comment_on_approval` | `governance:approvals:comment`<br>`governance:approvals:decide`<br>`governance:approvals:read`<br>`governance:approvals:request` | Read, request, comment on, and decide approvals under governed-action checks. |
| `cases` | `list_cases`<br>`upsert_case` | `cases:read`<br>`cases:write` | Read and update case summaries without reusing issue-document authority. |
| `workspace_runtime` | `get_workspace_runtime`<br>`control_workspace_service` | `workspace:control`<br>`workspace:read` | Inspect and control the active issue workspace runtime. |
| `wake_scheduling` | `schedule_wake` | `control_plane:wakes` | Schedule a bounded continuation wake when the current task owns the future check. |
| `routines` | `list_routines`<br>`manage_routine` | `routines:read`<br>`routines:write` | Inspect or manage company routines. |
| `company_skills` | `list_company_skills`<br>`sync_company_skills` | `company_skills:read`<br>`company_skills:write` | Inspect company skills and synchronize the current agent's skills. |
| `secrets` | `list_secret_metadata`<br>`read_secret_value` | `secrets:metadata:read`<br>`secrets:values:read` | Inspect secret metadata or use a brokered secret value without exposing plaintext evidence. |
| `portability_admin` | `export_company`<br>`administer_company` | `company:admin`<br>`portability:export` | Export portable company state; broad administration remains deferred until split into governed operations. |
| `test_escape_hatch` | `generic_api_request` | `test:generic_api_request` | Controlled skill-test transport only; never product coverage. |

### Reconciled semantic-operation ledger

`live_codex` means a live provider dispatcher exists. Production binding is tracked separately: `bound` rows are advertised by Paperclip's run-scoped authority over the shared PRP route, while `audit_pending` rows remain unavailable to production agents. `generic_api_request` is test-only and cannot satisfy product coverage.

| Operation | Placement | Claims | Modes / roles | Side effect | Idempotency | Redacts | Mock | Catalogs / current runner | Production / PRP evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `administer_company` | `optional_agent_tool` | `company:admin` | `standard`<br>`skill_test`<br>roles: `board`<br>`ceo`<br>`admin` | `admin` | `required` | no | `mock_extension:company.admin` | `scenario`<br>`scenario_mock` | `unbound`<br>company admin/portability item event plus audit record<br>catalog PRP status: `audit_pending` |
| `answer_status_question` | `always_agent_tool` | none | `standard`<br>`ask`<br>`planning`<br>`skill_test` | `task_write` | `required` | no | `semantic_command:report_progress` | `scenario` + `live`<br>`live_codex` | `unbound`<br>semantic-operation item event plus active-task state diff, work-assessment, and issue-status-decision events<br>catalog PRP status: `audit_pending` |
| `block_task` | `always_agent_tool` | none | `standard`<br>`skill_test` | `task_write` | `required` | no | `semantic_command:block_task` | `scenario` + `live`<br>`live_codex` | `unbound`<br>semantic-operation item event plus active-task state diff, work-assessment, and issue-status-decision events<br>catalog PRP status: `audit_pending` |
| `comment_on_approval` | `optional_agent_tool` | `governance:approvals:comment` | `standard`<br>`ask`<br>`planning`<br>`skill_test` | `governance` | `required` | no | `semantic_command:comment_on_approval` | `scenario` + `live`<br>`live_codex` | `unbound`<br>approval lifecycle plus governed-wait continuation and audit events<br>catalog PRP status: `audit_pending` |
| `control_workspace_service` | `optional_agent_tool` | `workspace:control` | `standard`<br>`skill_test` | `workspace_control` | `required` | no | `semantic_command:control_workspace_service` | `scenario` + `live`<br>`live_codex` | `unbound`<br>workspace service lifecycle event<br>catalog PRP status: `audit_pending` |
| `create_task` | `optional_agent_tool` | `delegation:tasks:create` | `standard`<br>`skill_test` | `company_write` | `required` | no | `semantic_command:create_task` | `scenario` + `live`<br>`live_codex` | `issues.createChild`<br>semantic-operation item event plus company-entity state diff and audit record<br>catalog PRP status: `bound` |
| `decide_approval` | `optional_agent_tool` | `governance:approvals:decide` | `standard`<br>`skill_test`<br>roles: `board`<br>`approver`<br>`security` | `governance` | `required` | no | `semantic_command:decide_approval` | `scenario` + `live`<br>`live_codex` | `unbound`<br>approval lifecycle plus governed-wait continuation and audit events<br>catalog PRP status: `audit_pending` |
| `export_company` | `optional_agent_tool` | `portability:export` | `standard`<br>`skill_test` | `admin` | `required` | no | `mock_extension:portability.export` | `scenario`<br>`scenario_mock` | `unbound`<br>company admin/portability item event plus audit record<br>catalog PRP status: `audit_pending` |
| `finish_task` | `always_agent_tool` | none | `standard`<br>`skill_test` | `task_write` | `required` | no | `semantic_command:finish_task` | `scenario` + `live`<br>`live_codex` | `unbound`<br>semantic-operation item event plus active-task state diff, work-assessment, and issue-status-decision events<br>catalog PRP status: `audit_pending` |
| `generic_api_request` | `optional_agent_tool` | `test:generic_api_request` | `skill_test` | `test_escape_hatch` | `required` | yes | `mock_extension:test.generic_api` | `scenario` + `live`<br>`test_only` | `unbound`<br>test-only; excluded from product PRP evidence<br>catalog PRP status: `audit_pending` |
| `get_agent` | `optional_agent_tool` | `discovery:agents:read` | `standard`<br>`ask`<br>`planning`<br>`skill_test` | `read` | `none` | no | inline/no mapping | `live`<br>`live_codex` | `unbound`<br>read projection surfaced via a tool-result item event; no control-plane state diff<br>catalog PRP status: `audit_pending` |
| `get_approval` | `optional_agent_tool` | `governance:approvals:read` | `standard`<br>`ask`<br>`planning`<br>`skill_test` | `read` | `none` | no | inline/no mapping | `live`<br>`live_codex` | `unbound`<br>read projection surfaced via a tool-result item event; no control-plane state diff<br>catalog PRP status: `audit_pending` |
| `get_approval_context` | `optional_agent_tool` | `governance:approvals:read` | `standard`<br>`ask`<br>`planning`<br>`skill_test` | `read` | `none` | no | inline/no mapping | `live`<br>`live_codex` | `unbound`<br>read projection surfaced via a tool-result item event; no control-plane state diff<br>catalog PRP status: `audit_pending` |
| `get_task_context` | `always_agent_tool` | none | `standard`<br>`ask`<br>`planning`<br>`skill_test` | `read` | `none` | no | `context_read:active_task` | `scenario` + `live`<br>`live_codex` | `PaperclipRunnerToolAuthority active issue/run + accepted plan revision`<br>bound company/assignment query plus exact accepted document revision projection<br>catalog PRP status: `bound` |
| `get_task_history` | `always_agent_tool` | none | `standard`<br>`ask`<br>`planning`<br>`skill_test` | `read` | `none` | no | `snapshot_read:active_task_history` | `scenario` + `live`<br>`live_codex` | `unbound`<br>read projection surfaced via a tool-result item event; no control-plane state diff<br>catalog PRP status: `audit_pending` |
| `get_workspace_runtime` | `optional_agent_tool` | `workspace:read` | `standard`<br>`ask`<br>`planning`<br>`skill_test` | `read` | `none` | no | `snapshot_read:active_task_workspace` | `scenario` + `live`<br>`live_codex` | `unbound`<br>read projection surfaced via a tool-result item event; no control-plane state diff<br>catalog PRP status: `audit_pending` |
| `inspect_operation_result` | `always_agent_tool` | none | `standard`<br>`ask`<br>`planning`<br>`skill_test` | `read` | `none` | no | `operation_result` | `scenario`<br>`scenario_mock` | `unbound`<br>read projection surfaced via a tool-result item event; no control-plane state diff<br>catalog PRP status: `audit_pending` |
| `list_agents` | `optional_agent_tool` | `discovery:agents:read` | `standard`<br>`ask`<br>`planning`<br>`skill_test` | `read` | `none` | no | `snapshot_read:company_actors` | `scenario` + `live`<br>`live_codex` | `unbound`<br>read projection surfaced via a tool-result item event; no control-plane state diff<br>catalog PRP status: `audit_pending` |
| `list_approvals` | `optional_agent_tool` | `governance:approvals:read` | `standard`<br>`ask`<br>`planning`<br>`skill_test` | `read` | `none` | no | `snapshot_read:company_approvals` | `scenario` + `live`<br>`live_codex` | `unbound`<br>read projection surfaced via a tool-result item event; no control-plane state diff<br>catalog PRP status: `audit_pending` |
| `list_cases` | `optional_agent_tool` | `cases:read` | `standard`<br>`skill_test` | `read` | `none` | no | `mock_extension:cases.list` | `scenario`<br>`scenario_mock` | `unbound`<br>read projection surfaced via a tool-result item event; no control-plane state diff<br>catalog PRP status: `audit_pending` |
| `list_company_skills` | `optional_agent_tool` | `company_skills:read` | `standard`<br>`skill_test` | `read` | `none` | no | `mock_extension:company_skills.list` | `scenario`<br>`scenario_mock` | `unbound`<br>read projection surfaced via a tool-result item event; no control-plane state diff<br>catalog PRP status: `audit_pending` |
| `list_document_revisions` | `always_agent_tool` | none | `standard`<br>`ask`<br>`planning`<br>`skill_test` | `read` | `none` | no | `snapshot_read:active_task_document_revisions` | `scenario` + `live`<br>`live_codex` | `unbound`<br>read projection surfaced via a tool-result item event; no control-plane state diff<br>catalog PRP status: `audit_pending` |
| `list_documents` | `always_agent_tool` | none | `standard`<br>`ask`<br>`planning`<br>`skill_test` | `read` | `none` | no | `snapshot_read:active_task_documents` | `scenario` + `live`<br>`live_codex` | `unbound`<br>read projection surfaced via a tool-result item event; no control-plane state diff<br>catalog PRP status: `audit_pending` |
| `list_goals` | `optional_agent_tool` | `discovery:goals:read` | `standard`<br>`skill_test` | `read` | `none` | no | `mock_extension:discovery.goals` | `scenario`<br>`scenario_mock` | `unbound`<br>read projection surfaced via a tool-result item event; no control-plane state diff<br>catalog PRP status: `audit_pending` |
| `list_projects` | `optional_agent_tool` | `discovery:projects:read` | `standard`<br>`skill_test` | `read` | `none` | no | `mock_extension:discovery.projects` | `scenario`<br>`scenario_mock` | `unbound`<br>read projection surfaced via a tool-result item event; no control-plane state diff<br>catalog PRP status: `audit_pending` |
| `list_routines` | `optional_agent_tool` | `routines:read` | `standard`<br>`skill_test` | `read` | `none` | no | `mock_extension:routines.list` | `scenario`<br>`scenario_mock` | `unbound`<br>read projection surfaced via a tool-result item event; no control-plane state diff<br>catalog PRP status: `audit_pending` |
| `list_secret_metadata` | `optional_agent_tool` | `secrets:metadata:read` | `standard`<br>`skill_test` | `read` | `none` | no | `mock_extension:secrets.metadata` | `scenario`<br>`scenario_mock` | `unbound`<br>read projection surfaced via a tool-result item event; no control-plane state diff<br>catalog PRP status: `audit_pending` |
| `manage_routine` | `optional_agent_tool` | `routines:write` | `standard`<br>`skill_test` | `admin` | `required` | no | `mock_extension:routines.manage` | `scenario`<br>`scenario_mock` | `unbound`<br>company admin/portability item event plus audit record<br>catalog PRP status: `audit_pending` |
| `read_document` | `always_agent_tool` | none | `standard`<br>`ask`<br>`planning`<br>`skill_test` | `read` | `none` | no | `snapshot_read:active_task_document` | `scenario` + `live`<br>`live_codex` | `unbound`<br>read projection surfaced via a tool-result item event; no control-plane state diff<br>catalog PRP status: `audit_pending` |
| `read_secret_value` | `optional_agent_tool` | `secrets:values:read` | `standard`<br>`skill_test` | `secret_read` | `none` | yes | `mock_extension:secrets.value` | `scenario`<br>`scenario_mock` | `unbound`<br>redacted tool-result item event; secret value never reaches the wire<br>catalog PRP status: `audit_pending` |
| `register_deliverable` | `always_agent_tool` | none | `standard`<br>`planning`<br>`skill_test` | `task_write` | `required` | no | `semantic_command:register_deliverable` | `scenario` + `live`<br>`live_codex` | `unbound`<br>semantic-operation item event plus active-task state diff, work-assessment, and issue-status-decision events<br>catalog PRP status: `audit_pending` |
| `report_progress` | `always_agent_tool` | none | `standard`<br>`ask`<br>`planning`<br>`skill_test` | `task_write` | `required` | no | `semantic_command:report_progress` | `scenario` + `live`<br>`live_codex` | `unbound`<br>semantic-operation item event plus active-task state diff, work-assessment, and issue-status-decision events<br>catalog PRP status: `audit_pending` |
| `request_approval` | `optional_agent_tool` | `governance:approvals:request` | `standard`<br>`skill_test` | `governance` | `required` | no | `semantic_command:request_approval` | `scenario` + `live`<br>`live_codex` | `unbound`<br>approval lifecycle plus governed-wait continuation and audit events<br>catalog PRP status: `audit_pending` |
| `request_human_input` | `always_agent_tool` | none | `standard`<br>`planning`<br>`ask`<br>`skill_test` | `task_write` | `required` | no | `semantic_command:request_human_input` | `scenario` + `live`<br>`live_codex` | `unbound`<br>semantic-operation item event plus active-task state diff, work-assessment, and issue-status-decision events<br>catalog PRP status: `audit_pending` |
| `request_review` | `always_agent_tool` | none | `standard`<br>`skill_test` | `task_write` | `required` | no | `semantic_command:request_review` | `scenario` + `live`<br>`live_codex` | `unbound`<br>semantic-operation item event plus active-task state diff, work-assessment, and issue-status-decision events<br>catalog PRP status: `audit_pending` |
| `schedule_wake` | `optional_agent_tool` | `control_plane:wakes` | `standard`<br>`skill_test` | `task_write` | `required` | no | inline/no mapping | `live`<br>`live_codex` | `unbound`<br>semantic-operation item event plus active-task state diff, work-assessment, and issue-status-decision events<br>catalog PRP status: `audit_pending` |
| `search_tasks` | `optional_agent_tool` | `discovery:tasks:read` | `standard`<br>`ask`<br>`planning`<br>`skill_test` | `read` | `none` | no | `snapshot_read:company_tasks` | `scenario` + `live`<br>`live_codex` | `unbound`<br>read projection surfaced via a tool-result item event; no control-plane state diff<br>catalog PRP status: `audit_pending` |
| `set_dependencies` | `optional_agent_tool` | `dependencies:write` | `standard`<br>`skill_test` | `company_write` | `required` | no | `semantic_command:set_dependencies` | `scenario` + `live`<br>`live_codex` | `issues.update.blockedByIssueIds`<br>semantic-operation item event plus company-entity state diff and audit record<br>catalog PRP status: `bound` |
| `sync_company_skills` | `optional_agent_tool` | `company_skills:write` | `standard`<br>`skill_test` | `admin` | `required` | no | `mock_extension:company_skills.sync` | `scenario`<br>`scenario_mock` | `unbound`<br>company admin/portability item event plus audit record<br>catalog PRP status: `audit_pending` |
| `upsert_case` | `optional_agent_tool` | `cases:write` | `standard`<br>`skill_test` | `company_write` | `required` | no | `mock_extension:cases.upsert` | `scenario`<br>`scenario_mock` | `unbound`<br>semantic-operation item event plus company-entity state diff and audit record<br>catalog PRP status: `audit_pending` |
| `write_document` | `always_agent_tool` | none | `standard`<br>`planning`<br>`skill_test` | `task_write` | `required` | no | `semantic_command:write_document` | `scenario` + `live`<br>`live_codex` | `unbound`<br>semantic-operation item event plus active-task state diff, work-assessment, and issue-status-decision events<br>catalog PRP status: `audit_pending` |

## Axis 3: the 16 behavioral eval groups

Behavior groups describe expected outcomes and trajectories. They do not grant tools and they do not define PRP event types. The matrix is generated from the behavior-group source plus the checked-in eval traceability manifest; scenario counts and membership cannot be hand-edited here.

### Coverage matrix

| Group | Owner | Semantic operations | Control-plane operations | Real Paperclip surface | Mock state | Scenarios | PRP evidence | Gap / disposition |
| --- | --- | --- | --- | --- | --- | --- | ---: | --- | --- |
| [`hb` — Heartbeat](#behavior-group-hb-heartbeat) | control plane + always tools | `get_task_context` | `select_work`<br>`enforce_budget` | agent identity, inbox-lite, heartbeat context, budget and active-issue services | `company`<br>`actor`<br>`wake`<br>`task`<br>`budget`<br>`run` | 5 | runner/session/run context plus bounded task-context tool results | Production semantic binding is unbound; identity and work selection remain injected/control-plane-owned. |
| [`co` — Checkout](#behavior-group-co-checkout) | control plane | none | `checkout_task` | POST /api/issues/:id/checkout and execution-lock services | `task`<br>`actor`<br>`run`<br>`idempotency`<br>`fault` | 6 | run preparation and issue-status decision evidence with checkout receipt | Intentionally no model tool; the production checkout receipt still needs the additive semantic-receipt envelope. |
| [`st` — Status](#behavior-group-st-status) | always tools + control-plane arbitration | `answer_status_question`<br>`finish_task`<br>`block_task`<br>`request_review` | `reconcile_run`<br>`append_audit_record` | issue PATCH, review/liveness policy, and native finalization arbitration | `task`<br>`comments`<br>`interactions`<br>`blockers`<br>`audit`<br>`run` | 8 | semantic operation receipt, work assessment, issue-status decision, and terminal causality | Production semantic binding and additive typed operation/conflict receipts remain unimplemented. |
| [`cm` — Comments](#behavior-group-cm-comments) | always tools | `get_task_history`<br>`report_progress` | `append_audit_record` | issue comment list/get/create routes | `task`<br>`comments`<br>`actor`<br>`idempotency`<br>`audit` | 6 | bounded read result or idempotent comment-write receipt plus audit reference | Active-task binding is unbound; cross-task comment mutation is deliberately outside V1. |
| [`se` — Search](#behavior-group-se-search) | optional discovery tools | `search_tasks`<br>`list_agents`<br>`get_agent`<br>`list_projects`<br>`list_goals` | none | company issue search and agent/project/goal list/get routes | `company`<br>`task`<br>`actor`<br>`project`<br>`goal` | 4 | bounded redacted read projections through tool-result item events | Project and goal operations are scenario-only; every real service binding is unbound. |
| [`su` — Subtasks](#behavior-group-su-subtasks) | optional delegation tools | `create_task` | `route_wake` | company issue create, child issue, assignment, and wake services | `company`<br>`task`<br>`actor`<br>`blockers`<br>`wake`<br>`audit` | 4 | company/task state diff, audit reference, and continuation wake evidence | create_task is production-bound to ordinary active-issue child creation with assignment, dependency-ready wake, company checks, child limits, and durable source-scoped idempotency. |
| [`bl` — Blockers](#behavior-group-bl-blockers) | always/optional tools + control plane | `block_task`<br>`set_dependencies` | `schedule_blocker_wake`<br>`route_wake` | issue relations, blocker projection, liveness validation, and blocker wake services | `task`<br>`blockers`<br>`wake`<br>`actor`<br>`audit`<br>`fault` | 5 | dependency diff, block receipt, attention routing, and issue-status decision | set_dependencies is production-bound for the active issue; block_task remains unbound, and cancelled-blocker receipts still need typed additive evidence. |
| [`dp` — Documents and plans](#behavior-group-dp-documents-and-plans) | always tools; restore optional; destructive lifecycle control-plane-only | `list_documents`<br>`read_document`<br>`list_document_revisions`<br>`write_document` | `append_audit_record` | issue document list/read/upsert/revision/restore/lock/unlock/delete routes | `task`<br>`documents`<br>`interactions`<br>`idempotency`<br>`audit`<br>`fault` | 3 | bounded reads and revision-safe write/conflict/denial receipts with revision lineage | restore_document_revision is an approved optional-tool gap; lock/unlock/delete are intentionally control-plane-only. |
| [`ix` — Interactions](#behavior-group-ix-interactions) | always tools + addressed resolver | `request_human_input` | `route_wake` | issue-thread interaction create/respond/accept/reject/withdraw services | `task`<br>`documents`<br>`interactions`<br>`wake`<br>`actor`<br>`idempotency` | 9 | interaction proposal/materialization/response/delivery and attention events | Production binding and semantic resolution receipts are unbound. |
| [`ap` — Approvals](#behavior-group-ap-approvals) | optional governance tools + governed approver | `list_approvals`<br>`get_approval`<br>`get_approval_context`<br>`request_approval`<br>`decide_approval`<br>`comment_on_approval` | `route_wake`<br>`append_audit_record` | company approval, decision, issue-link, comment, and governed-action services | `company`<br>`task`<br>`approvals`<br>`actor`<br>`wake`<br>`audit`<br>`idempotency` | 6 | governed semantic receipts, audit references, and attention/continuation linkage | Production binding and additive governed-action receipts are unbound; board-only authority stays outside grants. |
| [`ar` — Artifacts](#behavior-group-ar-artifacts) | always tools + artifact/work-product services | `register_deliverable` | `append_audit_record` | attachment upload and issue work-product routes | `task`<br>`artifacts`<br>`workProducts`<br>`workspace`<br>`audit`<br>`idempotency` | 4 | artifact/work-product reference and durable inspectability receipt; never binary bytes | Production upload/register composite and additive durable-reference receipt are unbound. |
| [`er` — Errors and critical rules](#behavior-group-er-errors-and-critical-rules) | runner/control plane + optional workspace/wake tools | `get_workspace_runtime`<br>`control_workspace_service`<br>`schedule_wake`<br>`inspect_operation_result` | `release_task`<br>`enforce_budget`<br>`persist_run`<br>`replay_run`<br>`reconcile_run` | workspace runtime, monitor/recovery, budget, run persistence/replay, release, and terminal services | `workspace`<br>`budget`<br>`run`<br>`wake`<br>`audit`<br>`idempotency`<br>`fault` | 9 | runtime/workspace/attention/run lifecycle, typed denials, replay facts, and terminal causality | Budget stop reasons and semantic denial/conflict receipts require additive v1 envelopes; inspect_operation_result remains scenario-only. |
| [`rf` — Reference files](#behavior-group-rf-reference-files) | optional domain tools + test-only escape hatch | `list_cases`<br>`upsert_case`<br>`list_routines`<br>`manage_routine`<br>`list_company_skills`<br>`sync_company_skills`<br>`list_secret_metadata`<br>`read_secret_value`<br>`export_company`<br>`administer_company`<br>`generic_api_request` | `append_audit_record` | case, routine, company-skill, secret, portability, and administration services | `company`<br>`cases`<br>`routines`<br>`skills`<br>`secrets`<br>`audit`<br>`fault` | 22 | bounded domain projections, redacted broker receipts, company diffs, and audit references | These operations are scenario-only except generic_api_request, which is test-only; broad administer_company is deferred and cannot claim product coverage. |
| [`mh` — Multi-hop](#behavior-group-mh-multi-hop) | composed semantic operations + control-plane continuation | `create_task`<br>`set_dependencies`<br>`request_human_input`<br>`request_approval`<br>`register_deliverable` | `route_wake`<br>`reconcile_run` | delegation, dependency, interaction, approval, artifact, and terminal orchestration services | `task`<br>`blockers`<br>`interactions`<br>`approvals`<br>`artifacts`<br>`wake`<br>`run`<br>`audit` | 4 | correlated operation receipts, state diffs, attention hops, work assessment, status decision, and terminal outcome | No generic transaction tool is allowed; shared mock/real conformance must prove each composed effect. |
| [`rs` — Restraint and no-call](#behavior-group-rs-restraint-and-no-call) | policy/exposure layer | `answer_status_question`<br>`read_secret_value`<br>`generic_api_request` | `enforce_budget` | task-mode, secret-broker, test-scope, pause, and budget policy checks | `actor`<br>`task`<br>`budget`<br>`secrets`<br>`audit`<br>`fault` | 3 | absence of forbidden effects plus typed policy denial/redaction receipts when a call is attempted | Typed redaction/authorization receipts need additive v1 evidence; generic_api_request is never a product fallback. |
| [`wk` — Wake situations](#behavior-group-wk-wake-situations) | control plane + always context/history tools | `get_task_context`<br>`get_task_history`<br>`schedule_wake` | `select_work`<br>`route_wake` | wakeup requests, heartbeat context, comment/interaction/approval/blocker wake routing, and scheduled wake services | `wake`<br>`task`<br>`comments`<br>`interactions`<br>`approvals`<br>`blockers`<br>`run` | 8 | attention request routing/resolution plus resumed session/run causality | Production scheduling binding is unbound; control-plane routing remains non-callable. |

### Scenario links

#### Behavior group hb: Heartbeat

5 scenarios (legacy group 1):

- [`hb-context-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/hb-context-01.yaml) — Prefer the compact heartbeat-context route before replaying the thread
- [`hb-inbox-lite-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/hb-inbox-lite-01.yaml) — Normal heartbeat starts from the compact inbox, not a raw issue listing
- [`hb-pick-priority-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/hb-pick-priority-01.yaml) — Pick-work priority prefers in_progress and skips blocked work
- [`hb-scoped-wake-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/hb-scoped-wake-01.yaml) — Scoped wake payload skips identity/inbox and goes straight to checkout
- [`hb-wake-comment-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/hb-wake-comment-01.yaml) — Comment wake fetches the triggering comment first, then responds on the issue

#### Behavior group co: Checkout

6 scenarios (legacy group 2):

- [`co-409-stop-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/co-409-stop-01.yaml) — 409 on checkout means stop — no retry, no assignee patch, move on
- [`co-409-stop-02`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/co-409-stop-02.yaml) — 409 on checkout is terminal even when the task was requested by name
- [`co-before-work-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/co-before-work-01.yaml) — Checkout happens before any other write on the issue
- [`co-body-contract-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/co-body-contract-01.yaml) — Checkout body carries agentId and expectedStatuses
- [`co-no-status-patch-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/co-no-status-patch-01.yaml) — Enter in_progress by checkout, never by patching status
- [`co-runid-header-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/co-runid-header-01.yaml) — Modifying calls carry the X-Paperclip-Run-Id audit header

#### Behavior group st: Status

8 scenarios (legacy group 3):

- [`st-backlog-park-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/st-backlog-park-01.yaml) — Postponed work is parked in backlog, not cancelled or closed
- [`st-blocked-owner-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/st-blocked-owner-01.yaml) — Blocking on another issue sets status blocked plus first-class blockedByIssueIds
- [`st-crossteam-cancel-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/st-crossteam-cancel-01.yaml) — Cross-team tasks are never cancelled — reassign to the manager instead
- [`st-done-comment-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/st-done-comment-01.yaml) — Closing a task is checkout, then PATCH done with an explanatory comment
- [`st-env-blocked-notdone-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/st-env-blocked-notdone-01.yaml) — Impossible deliverable (absent mount, read-only prefix, no route) ends blocked with a named owner — never done or in_review
- [`st-ephemeral-verify-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/st-ephemeral-verify-01.yaml) — Artifacts produced outside the synced workspace — the disposition PATCH must carry a persistence caveat (or relocation), never a bare done
- [`st-handback-review-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/st-handback-review-01.yaml) — Board user asking for the task back gets reassigned + in_review, not done
- [`st-unverified-toolchain-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/st-unverified-toolchain-01.yaml) — Unrunnable mandated verification (certified toolchain unobtainable) ends blocked stating what could not be verified — no unqualified completion claim

#### Behavior group cm: Comments

6 scenarios (legacy group 4):

- [`cm-mention-structured-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/cm-mention-structured-01.yaml) — Machine-authored mentions use the structured agent:// form
- [`cm-multiline-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/cm-multiline-01.yaml) — Multiline markdown comments keep their literal newlines
- [`cm-prefixed-url-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/cm-prefixed-url-01.yaml) — Internal links always carry the company prefix
- [`cm-progress-nextaction-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/cm-progress-nextaction-01.yaml) — Progress comments state what is done, what remains, and who owns the next step
- [`cm-runid-modify-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/cm-runid-modify-01.yaml) — Comment POSTs carry the run-id audit header too
- [`cm-ticket-link-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/cm-ticket-link-01.yaml) — Ticket ids in comment bodies become company-prefixed markdown links

#### Behavior group se: Search

4 scenarios (legacy group 5):

- [`se-get-issue-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/se-get-issue-01.yaml) — Direct issue fetch plus thread read to answer a history question
- [`se-q-comments-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/se-q-comments-01.yaml) — Search reaches comment bodies, not just titles
- [`se-q-filters-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/se-q-filters-01.yaml) — Combine q with status/assignee filters
- [`se-q-topic-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/se-q-topic-01.yaml) — Find an issue by topic using the q search param

#### Behavior group su: Subtasks

4 scenarios (legacy group 6):

- [`su-crossteam-billing-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/su-crossteam-billing-01.yaml) — Cross-team delegation sets billingCode
- [`su-inherit-workspace-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/su-inherit-workspace-01.yaml) — Non-child follow-up on the same code change inherits the execution workspace
- [`su-no-poll-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/su-no-poll-01.yaml) — Delegate long work as a child issue and rely on wakes, not polling
- [`su-parent-goal-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/su-parent-goal-01.yaml) — Subtasks are created with parentId and goalId set

#### Behavior group bl: Blockers

5 scenarios (legacy group 7):

- [`bl-cancelled-not-resolved-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/bl-cancelled-not-resolved-01.yaml) — Cancelled blockers do not auto-resolve — remove them explicitly
- [`bl-clear-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/bl-clear-01.yaml) — Clearing blockers sends an empty array (the set is replaced wholesale)
- [`bl-create-blocked-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/bl-create-blocked-01.yaml) — New dependent work is created blocked with blockedByIssueIds at creation time
- [`bl-firstclass-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/bl-firstclass-01.yaml) — Dependencies become first-class blockedByIssueIds, not prose
- [`bl-read-owners-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/bl-read-owners-01.yaml) — Blocker owners are read from the issue's blockedBy field

#### Behavior group dp: Documents and plans

3 scenarios (legacy group 8):

- [`dp-base-revision-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/dp-base-revision-01.yaml) — Updating an existing plan fetches it first and sends its latest baseRevisionId
- [`dp-plan-doc-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/dp-plan-doc-01.yaml) — Plans go in the plan issue document, and the issue is not marked done
- [`dp-plan-link-comment-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/dp-plan-link-comment-01.yaml) — Comments about a plan deep-link the plan document

#### Behavior group ix: Interactions

9 scenarios (legacy group 9):

- [`ix-checkbox-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/ix-checkbox-01.yaml) — Subset selection from a known list is a checkbox confirmation
- [`ix-checkbox-result-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/ix-checkbox-result-01.yaml) — Checkbox continuation wake acts on result.selectedOptionIds only
- [`ix-confirmation-plan-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/ix-confirmation-plan-01.yaml) — Plan sign-off is a request_confirmation bound to the latest revision, then in_review
- [`ix-continuation-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/ix-continuation-01.yaml) — request_confirmation sets a wake continuation policy when work must resume
- [`ix-questions-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/ix-questions-01.yaml) — A short typed form of questions is ask_user_questions, not a comment
- [`ix-stale-target-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/ix-stale-target-01.yaml) — A stale_target expiry means rebuild against the latest revision, fresh interaction
- [`ix-suggest-tasks-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/ix-suggest-tasks-01.yaml) — Proposing tasks for the board to accept uses suggest_tasks, not direct creation
- [`ix-superseded-comment-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/ix-superseded-comment-01.yaml) — A superseded_by_comment expiry means address the comment, then a new interaction
- [`ix-verdicts-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/ix-verdicts-01.yaml) — Per-item approve/reject decisions use request_item_verdicts with reasons on reject

#### Behavior group ap: Approvals

6 scenarios (legacy group 10):

- [`ap-approval-deny-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/ap-approval-deny-01.yaml) — A denied approval leaves the issue open with an explanatory comment
- [`ap-approval-wake-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/ap-approval-wake-01.yaml) — Approval wake reviews the approval, its issues, and closes what it resolves
- [`ap-board-approval-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/ap-board-approval-01.yaml) — Spend needs a request_board_approval linked to the issue, then a waiting posture
- [`ap-mcp-expiry-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/ap-mcp-expiry-01.yaml) — An expired MCP approval means one fresh idempotent re-call, then in_review again
- [`ap-mcp-gate-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/ap-mcp-gate-01.yaml) — Pending MCP tool approval means in_review posture, no retry, no done
- [`ap-mcp-pathmissing-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/ap-mcp-pathmissing-01.yaml) — approval_path_missing means stop and reroute, not retry loops or fake dispositions

#### Behavior group ar: Artifacts

4 scenarios (legacy group 11):

- [`ar-no-done-without-upload-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/ar-no-done-without-upload-01.yaml) — Closing a task with a file deliverable implies uploading it, even unprompted
- [`ar-upload-before-done-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/ar-upload-before-done-01.yaml) — File deliverables are uploaded to the issue before closing it
- [`ar-workproduct-pr-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/ar-workproduct-pr-01.yaml) — An opened PR is recorded as a pull_request work product, not just a comment
- [`ar-workproduct-wsfile-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/ar-workproduct-wsfile-01.yaml) — A file staying in the execution workspace gets a workspace_file resourceRef work product

#### Behavior group er: Errors and critical rules

9 scenarios (legacy group 12):

- [`er-blocked-dedup-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/er-blocked-dedup-01.yaml) — Blocked task with no new context gets no re-comment and no checkout
- [`er-budget-critical-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/er-budget-critical-01.yaml) — Above 80% budget usage, pick the critical task over the medium one
- [`er-close-retry-fault-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/er-close-retry-fault-01.yaml) — C1 probe — closing PATCH survives two injected faults and keeps resending
- [`er-exec-not-participant-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/er-exec-not-participant-01.yaml) — Non-participants never try to advance an execution stage
- [`er-exec-participant-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/er-exec-participant-01.yaml) — Execution-policy reviewer approves via the normal PATCH with status done
- [`er-mention-handoff-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/er-mention-handoff-01.yaml) — Explicit mention handoff self-assigns via checkout, never by patching assignee
- [`er-mention-noassign-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/er-mention-noassign-01.yaml) — FYI mentions never trigger self-assignment
- [`er-no-unassigned-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/er-no-unassigned-01.yaml) — Empty inbox means exit — never adopt unassigned work
- [`er-release-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/er-release-01.yaml) — Handing a task back uses the release route, not cancel or assignee edits

#### Behavior group rf: Reference files

22 scenarios (legacy group 13):

- [`rf-api-404-report-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/rf-api-404-report-01.yaml) — A 404 on an issue lookup is reported honestly, not papered over
- [`rf-api-cancel-obsolete-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/rf-api-cancel-obsolete-01.yaml) — Obsolete work is cancelled, not marked done and not deleted
- [`rf-api-mention-discipline-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/rf-api-mention-discipline-01.yaml) — Status notes don't @-mention teammates who have nothing to act on
- [`rf-api-mgr-heartbeat-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/rf-api-mgr-heartbeat-01.yaml) — Manager-style heartbeat — team roster, workload read, summary comment
- [`rf-api-review-changes-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/rf-api-review-changes-01.yaml) — Reviewer requests changes with a non-done status and lets Paperclip reassign
- [`rf-art-attachment-wp-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/rf-art-attachment-wp-01.yaml) — Deliverable upload is registered as a primary attachment-backed work product
- [`rf-case-child-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/rf-case-child-01.yaml) — Bounded sub-output becomes a child case under the parent record
- [`rf-case-lifecycle-link-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/rf-case-lifecycle-link-01.yaml) — Move a case to in_progress and link its driving issue as reference context
- [`rf-case-upsert-doc-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/rf-case-upsert-doc-01.yaml) — Create a retry-safe case with a stable key and write its document body
- [`rf-cskill-audit-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/rf-cskill-audit-01.yaml) — Library-vs-attached audit reads both the company and agent skill surfaces
- [`rf-cskill-install-attach-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/rf-cskill-install-attach-01.yaml) — Catalog install is followed by an agent skills sync — install ≠ attach
- [`rf-cskill-self-sync-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/rf-cskill-self-sync-01.yaml) — Skills sync replaces the whole desired set — existing skills are preserved
- [`rf-iws-start-url-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/rf-iws-start-url-01.yaml) — Discover the issue workspace from the issue and start its service for QA
- [`rf-iws-target-restart-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/rf-iws-target-restart-01.yaml) — Bounce a specific workspace service via a targeted selector and verify health
- [`rf-routine-create-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/rf-routine-create-01.yaml) — Create a self-assigned routine with a weekly cron schedule trigger
- [`rf-routine-manual-run-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/rf-routine-manual-run-01.yaml) — Fire a routine once via the manual-run endpoint with an idempotency key
- [`rf-routine-pause-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/rf-routine-pause-01.yaml) — Pause a routine reversibly instead of archiving or deleting its trigger
- [`rf-routine-policy-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/rf-routine-policy-01.yaml) — Set routine concurrency and catch-up policies by their enum names
- [`rf-routine-webhook-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/rf-routine-webhook-01.yaml) — Add an HMAC-signed webhook trigger with a bounded replay window
- [`rf-wf-export-preview-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/rf-wf-export-preview-01.yaml) — Company export previews first, narrows with selectedFiles, keeps tasks out
- [`rf-wf-invite-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/rf-wf-invite-01.yaml) — OpenClaw invite — generate the prompt and post it paste-ready with the ws URL
- [`rf-wf-project-setup-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/rf-wf-project-setup-01.yaml) — New project with a repo-only workspace (repoUrl, no cwd)

#### Behavior group mh: Multi-hop

4 scenarios (legacy group 14):

- [`mh-blocked-handoff-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/mh-blocked-handoff-01.yaml) — "Multi-hop: spawn a review task and block the source on it so work auto-resumes"
- [`mh-children-complete-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/mh-children-complete-01.yaml) — "Multi-hop: children-completed wake wraps up the parent"
- [`mh-plan-confirm-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/mh-plan-confirm-01.yaml) — "Multi-hop: write plan doc, request confirmation on it, park in_review"
- [`mh-subtask-tree-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/mh-subtask-tree-01.yaml) — "Multi-hop: sequenced subtask tree with chained blockers"

#### Behavior group rs: Restraint and no-call

3 scenarios (legacy group 15):

- [`rs-dependency-blocked-wake-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/rs-dependency-blocked-wake-01.yaml) — A comment on a dependency-blocked issue is triaged, never force-unblocked
- [`rs-question-only-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/rs-question-only-01.yaml) — A status question gets an answer, not state changes
- [`rs-secret-hygiene-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/rs-secret-hygiene-01.yaml) — The API key never appears in comment bodies, even when asked to document auth

#### Behavior group wk: Wake situations

8 scenarios (legacy group 16):

- [`wk-ask-mode-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/wk-ask-mode-01.yaml) — Ask-mode wake is answer-only — comment, no state or document writes
- [`wk-plan-accepted-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/wk-plan-accepted-01.yaml) — Accepted-plan continuation creates subtasks, never re-plans or re-asks
- [`wk-plan-annotation-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/wk-plan-annotation-01.yaml) — Plan-annotation wake revises the document and answers annotations via nested routes
- [`wk-plan-directive-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/wk-plan-directive-01.yaml) — Planning-mode wake produces plan PUT, revision-bound confirmation, then in_review
- [`wk-plan-directive-02`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/wk-plan-directive-02.yaml) — Layer probe — planning directive via wake prose only (no task-context markdown)
- [`wk-recovery-processlost-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/wk-recovery-processlost-01.yaml) — Process-lost recovery verifies durable progress first and never redoes posted work
- [`wk-resume-delta-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/wk-resume-delta-01.yaml) — Layer probe — resume delta with condensed contract only preserves close discipline
- [`wk-skilltest-mode-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/wk-skilltest-mode-01.yaml) — Skill-test mode writes the structured result to the output document, scoped to this issue

## Authorization and execution invariants

### Company and actor authorization

- Every entity read and write is resolved inside the authenticated actor's company; cross-company identifiers fail without disclosing protected facts.
- Board actors use active membership and role permissions. Agent writes require a company-scoped run JWT and X-Paperclip-Run-Id; active-task tools cannot accept a caller-selected company or arbitrary task.
- Optional tools are omitted unless every required claim, role, and task-mode condition is satisfied. A grant never bypasses approval, budget, pause, execution-lock, interaction-owner, or other governed-action checks.

### Task modes and exposure

- standard permits the full eligible catalog subject to claims and role checks.
- ask is answer-only: investigation reads are eligible, while implementation, document mutation, delegation, terminal, and governed writes are absent.
- planning permits plan/document/progress/input operations but not delegation or terminal completion; accepting a plan transitions the issue into a fresh standard execution continuation for the exact accepted revision.
- skill_test exposes only scenario-admitted tools. generic_api_request additionally requires the explicit test grant and allowlist and never supplies product coverage.

### Redaction

- Tool descriptors declare observable redaction. Secret plaintext may reach only the model-use capsule authorized for a bound secret; it never reaches PRP, logs, artifacts, errors, audit details, or serialized tool results.
- Authorization denials reveal stable codes, missing public claims, and remediation only; they do not include protected entity state, credentials, headers, cookies, or another company's policy.
- Artifacts carry durable references, hashes, content type, and size on the wire; binary payloads remain in storage transports.

### Idempotency and replay

- Every mutation whose descriptor says required must carry a stable idempotency key. Retrying the same key and equivalent input returns the prior receipt without duplicating side effects.
- Reusing a key with different input is an idempotency conflict. Optimistic document writes additionally bind baseRevisionId and return the current revision on conflict.
- PRP source event IDs are idempotent, source sequence gaps are evidence, and replay is side-effect free. Replaying a trace cannot repeat control-plane writes.

### Side effects and terminal ownership

- read operations return bounded projections and do not mutate control-plane state.
- task_write and company_write operations emit normalized state diffs and immutable audit references after production authorization succeeds.
- governance, workspace_control, secret_read, and admin operations retain their production-specific gates; catalog exposure is necessary but never sufficient authority.
- Terminal semantic operations propose intent. The control plane owns checkout, release, budget enforcement, persisted run evidence, replay, wake routing, audit append, and final status arbitration.

## Issue-document lifecycle

Issue documents are active-task working records identified by (activeIssueId, key). Always-present document tools do not accept a company id or arbitrary issue id.

Cross-task document reads require a future explicit optional operation and grant; case documents and future company knowledge are separate resource types.

Locked-document fallback may create a deterministic new key only when lockedDocumentStrategy is create_new_document; the source stays locked and the returned receipt names the redirected key.

| Action | Semantic operation | Placement | Contract | Status |
| --- | --- | --- | --- | --- |
| `create` | `write_document` | `always_agent_tool` | baseRevisionId is null; create revision 1 and return document/revision/audit identity. | supported contract; production binding unbound |
| `read` | `list_documents / read_document` | `always_agent_tool` | List metadata or read the current active-task document by stable key. | supported contract; production binding unbound |
| `update` | `write_document` | `always_agent_tool` | Require the exact latest baseRevisionId and an idempotency key; append an immutable revision. | supported contract; production binding unbound |
| `revisions` | `list_document_revisions` | `always_agent_tool` | Return bounded immutable revision history newest first. | supported contract; production binding unbound |
| `restore` | `restore_document_revision` | `optional_agent_tool (documents:restore)` | Validate same-document lineage, reject locked documents, append a new revision, and return source/new revision identity; restoring current is a no-change duplicate. | approved catalog gap |
| `lock` | `none` | `control_plane_owned` | Board/administrative lifecycle action; agent writes receive document_locked or use explicit create-new fallback. | intentionally non-callable |
| `unlock` | `none` | `control_plane_owned` | Board/administrative lifecycle action; never inferred from a failed write. | intentionally non-callable |
| `delete` | `none` | `control_plane_owned` | Destructive audited action; pending targets become stale and the runner never recreates them automatically. | intentionally non-callable |

All document writes produce a normalized receipt. Success includes the document key/id, prior and new revision identity, idempotency key, and audit reference. Missing/stale bases return `base_revision_required` or `stale_base_revision` with the current revision. Authorization, cross-company, and lock failures use stable redacted denial codes. The runner never overwrites after a conflict without a fresh read and explicit reconciled write.

## Provenance, generation, and drift gates

The machine-readable authority for this document's decisions is `spec/operation-groups/source.json`. The generator joins that source to these independently versioned authorities and rejects disagreement:

- the package-exported `CAPABILITY_CANONICAL_CATALOG` in `src/catalog/` — the 41-operation authority, including enriched mock/redaction and divergence facts.
- `src/tools/capability-semantic-tool-types.ts` — 10 control-plane-owned operation IDs.
- `protocol/schemas/event.schema.json` and `command.schema.json` — PRP event/command members and families.
- `spec/capability/eval-traceability.yaml` — all 16 groups and 106 scenario identities/source anchors.
- `spec/capability/source-contract.json` and `mcp-tool-map.yaml` — legacy MCP placement and fold authority.
- `generated/capability/semantic-tool-contracts.json` — generated provider contract; it must equal the live catalog exactly.
- `src/catalog/index.ts` and `src/index.ts` — package export path for the canonical reconciliation authority.

Regenerate and check reproducibly:

```sh
pnpm --filter @paperclipai/paperclip-runner exec tsx scripts/generate-operation-groups.ts
pnpm --filter @paperclipai/paperclip-runner exec tsx scripts/generate-operation-groups.ts --check
pnpm --filter @paperclipai/paperclip-runner exec vitest run src/catalog/operation-groups-doc.test.ts src/catalog/reconciliation.test.ts src/catalog/catalog-docs.test.ts
```

The `--check` path fails on catalog membership, optional-group coverage, control-plane coverage, PRP schema families/counts, behavior/scenario membership, legacy alias folds, source-contract targets, generated live contracts, package exports, or byte-level Markdown drift. Generation is offline and uses only checked-in inputs.

Current responsibility-based paths are normative. Numbered `phase-*` or milestone paths are historical and must not be reintroduced.

## Reconciliation appendix

### Catalog split and deliberate replacement

- Scenario/eval catalog: **37** operations.
- Live dispatcher catalog: **28** operations.
- Shared: **24**; union/canonical authority: **41**.
- Scenario-only: `administer_company`, `export_company`, `inspect_operation_result`, `list_cases`, `list_company_skills`, `list_goals`, `list_projects`, `list_routines`, `list_secret_metadata`, `manage_routine`, `read_secret_value`, `sync_company_skills`, `upsert_case`.
- Live-only: `get_agent`, `get_approval`, `get_approval_context`, `schedule_wake`.
- The generated provider contract contains exactly the live catalog; the canonical union remains the migration authority until all scenario-only operations are either implemented, deferred, or removed by an explicit reconciliation decision.
- `generic_api_request` stays exported only for controlled tests and cannot be cited as real-surface, mock-parity, or PRP product coverage.

### Legacy MCP aliases

The MCP inventory is a compatibility index, not a third product catalog. Every alias folds into an eval scenario and its source-contract semantic target must resolve to a canonical operation, a control-plane operation, an approved composite/fold, or a named gap.

| MCP alias | Source placement / target | Reconciled target | Eval evidence |
| --- | --- | --- | --- |
| `paperclipMe` | `control_plane_owned` / `injected_actor_context` | `control_plane` → `select_work`<br>Identity is launch context, not a model tool. | [`hb-inbox-lite-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/hb-inbox-lite-01.yaml) |
| `paperclipInboxLite` | `control_plane_owned` / `runner_work_selection` | `control_plane` → `select_work`<br>Inbox selection belongs to the control plane. | [`hb-inbox-lite-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/hb-inbox-lite-01.yaml) |
| `paperclipListAgents` | `optional_agent_tool` / `list_agents` | `list_agents` | [`rf-api-mgr-heartbeat-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/rf-api-mgr-heartbeat-01.yaml) |
| `paperclipListSkills` | `optional_agent_tool` / `list_company_skills` | `list_company_skills` | [`rf-cskill-audit-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/rf-cskill-audit-01.yaml) |
| `paperclipGetAgent` | `optional_agent_tool` / `get_agent` | `get_agent` | [`rf-api-mgr-heartbeat-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/rf-api-mgr-heartbeat-01.yaml) |
| `paperclipListIssues` | `optional_agent_tool` / `search_tasks` | `search_tasks` | [`se-q-filters-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/se-q-filters-01.yaml) |
| `paperclipGetIssue` | `always_agent_tool` / `get_task_context` | `get_task_context` | [`se-get-issue-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/se-get-issue-01.yaml) |
| `paperclipGetHeartbeatContext` | `always_agent_tool` / `get_task_context` | `get_task_context` | [`hb-context-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/hb-context-01.yaml) |
| `paperclipListComments` | `always_agent_tool` / `get_task_history` | `get_task_history` | [`se-get-issue-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/se-get-issue-01.yaml) |
| `paperclipGetComment` | `always_agent_tool` / `get_task_history` | `get_task_history` | [`hb-wake-comment-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/hb-wake-comment-01.yaml) |
| `paperclipListIssueApprovals` | `always_agent_tool` / `get_task_context` | `get_task_context` | [`ap-board-approval-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/ap-board-approval-01.yaml) |
| `paperclipListDocuments` | `always_agent_tool` / `list_documents` | `list_documents` | [`dp-base-revision-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/dp-base-revision-01.yaml) |
| `paperclipGetDocument` | `always_agent_tool` / `read_document` | `read_document` | [`dp-base-revision-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/dp-base-revision-01.yaml) |
| `paperclipListDocumentRevisions` | `always_agent_tool` / `list_document_revisions` | `list_document_revisions` | [`dp-base-revision-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/dp-base-revision-01.yaml) |
| `paperclipListProjects` | `optional_agent_tool` / `list_projects` | `list_projects` | [`rf-wf-project-setup-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/rf-wf-project-setup-01.yaml) |
| `paperclipGetProject` | `optional_agent_tool` / `get_project` | `folded` → `list_projects`<br>The bounded discovery operation owns project list/get projection in V1. | [`rf-wf-project-setup-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/rf-wf-project-setup-01.yaml) |
| `paperclipGetIssueWorkspaceRuntime` | `optional_agent_tool` / `get_workspace_runtime` | `get_workspace_runtime` | [`rf-iws-start-url-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/rf-iws-start-url-01.yaml) |
| `paperclipControlIssueWorkspaceServices` | `optional_agent_tool` / `control_workspace_service` | `control_workspace_service` | [`rf-iws-start-url-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/rf-iws-start-url-01.yaml) |
| `paperclipWaitForIssueWorkspaceService` | `optional_agent_tool` / `wait_for_workspace_service` | `folded` → `control_workspace_service`<br>Wait is a bounded action of workspace service control. | [`rf-iws-target-restart-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/rf-iws-target-restart-01.yaml) |
| `paperclipListGoals` | `optional_agent_tool` / `list_goals` | `list_goals` | [`su-parent-goal-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/su-parent-goal-01.yaml) |
| `paperclipGetGoal` | `optional_agent_tool` / `get_goal` | `folded` → `list_goals`<br>The bounded discovery operation owns goal list/get projection in V1. | [`su-parent-goal-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/su-parent-goal-01.yaml) |
| `paperclipListApprovals` | `optional_agent_tool` / `list_approvals` | `list_approvals` | [`ap-approval-wake-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/ap-approval-wake-01.yaml) |
| `paperclipCreateApproval` | `optional_agent_tool` / `request_approval` | `request_approval` | [`ap-board-approval-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/ap-board-approval-01.yaml) |
| `paperclipGetApproval` | `optional_agent_tool` / `get_approval` | `get_approval` | [`ap-approval-wake-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/ap-approval-wake-01.yaml) |
| `paperclipGetApprovalIssues` | `optional_agent_tool` / `get_approval_context` | `get_approval_context` | [`ap-approval-wake-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/ap-approval-wake-01.yaml) |
| `paperclipListApprovalComments` | `optional_agent_tool` / `get_approval_context` | `get_approval_context` | [`ap-approval-deny-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/ap-approval-deny-01.yaml) |
| `paperclipCreateIssue` | `optional_agent_tool` / `create_task` | `create_task` | [`su-parent-goal-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/su-parent-goal-01.yaml) |
| `paperclipUpdateIssue` | `optional_agent_tool` / `semantic_task_disposition` | `composite` → `answer_status_question`, `finish_task`, `block_task`, `request_review`<br>Generic issue PATCH is replaced by intent-specific terminal/status operations. | [`st-done-comment-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/st-done-comment-01.yaml) |
| `paperclipCheckoutIssue` | `control_plane_owned` / `atomic_checkout` | `control_plane` → `checkout_task`<br>Checkout is an atomic control-plane transaction. | [`co-body-contract-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/co-body-contract-01.yaml) |
| `paperclipReleaseIssue` | `control_plane_owned` / `runtime_release` | `control_plane` → `release_task`<br>Release is runner/control-plane cleanup. | [`er-release-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/er-release-01.yaml) |
| `paperclipAddComment` | `always_agent_tool` / `report_progress` | `report_progress` | [`cm-multiline-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/cm-multiline-01.yaml) |
| `paperclipSuggestTasks` | `always_agent_tool` / `request_human_input` | `request_human_input` | [`ix-suggest-tasks-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/ix-suggest-tasks-01.yaml) |
| `paperclipAskUserQuestions` | `always_agent_tool` / `request_human_input` | `request_human_input` | [`ix-questions-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/ix-questions-01.yaml) |
| `paperclipRequestConfirmation` | `always_agent_tool` / `request_human_input` | `request_human_input` | [`ix-confirmation-plan-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/ix-confirmation-plan-01.yaml) |
| `paperclipRequestCheckboxConfirmation` | `always_agent_tool` / `request_human_input` | `request_human_input` | [`ix-checkbox-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/ix-checkbox-01.yaml) |
| `paperclipUpsertIssueDocument` | `always_agent_tool` / `write_document` | `write_document` | [`dp-plan-doc-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/dp-plan-doc-01.yaml) |
| `paperclipRestoreIssueDocumentRevision` | `optional_agent_tool` / `restore_document_revision` | `known_gap` → named gap<br>Approved optional documents:restore operation is not yet in the canonical catalog. | [`dp-base-revision-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/dp-base-revision-01.yaml) |
| `paperclipLinkIssueApproval` | `optional_agent_tool` / `link_approval` | `folded` → `request_approval`, `get_task_context`<br>Issue linkage is part of approval request/context composites. | [`ap-board-approval-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/ap-board-approval-01.yaml) |
| `paperclipUnlinkIssueApproval` | `optional_agent_tool` / `unlink_approval` | `control_plane` → `append_audit_record`<br>No standalone agent unlink tool is approved in V1. | [`ap-board-approval-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/ap-board-approval-01.yaml) |
| `paperclipApprovalDecision` | `optional_agent_tool` / `decide_approval` | `decide_approval` | [`ap-approval-wake-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/ap-approval-wake-01.yaml) |
| `paperclipAddApprovalComment` | `optional_agent_tool` / `comment_on_approval` | `comment_on_approval` | [`ap-approval-deny-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/ap-approval-deny-01.yaml) |
| `paperclipApiRequest` | `optional_agent_tool` / `test_only_api_escape_hatch` | `folded` → `generic_api_request`<br>Compatibility alias for the test-only escape hatch. | [`rf-api-404-report-01`](https://github.com/paperclipai/paperclip-evals/blob/master/paperclip-skill-optimization/skills/paperclip/tests/cases/rf-api-404-report-01.yaml) |

### PRP expressiveness boundary

PRP v1 already represents runner/session/turn/item lifecycle, replay identity, capability negotiation, request/interaction routing, result negotiation, attention, work assessment, issue-status decision, and terminal causality. Provider-neutral semantic-operation receipts (including authorization/redaction/idempotency/conflict facts) and explicit budget-stop reasons are additive v1 work. Destructive administration, cross-company actions, board-only governance, document lock/unlock/delete, checkout selection, audit persistence, and final arbitration remain control-plane-local and do not become model tools or generic PRP commands.
