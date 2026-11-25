# Agent permission defaults

This document describes the server defaults for an ordinary, standard trust agent. An agent must belong to the same company and be active where the action requires active membership. A responsible user's authority, project or run trust policy, scope rules, and approval gates can narrow these defaults.

## Granted by default

| Capability | Source and limit |
| --- | --- |
| Agent configuration reads | Standard agents receive company-scoped `agents:read`. This permits redacted configuration, skill settings, instruction content, and configuration/instruction history reads. It grants no write, rollback, or environment-test authority. |
| Agent configuration changes and suggestions | New standard agents also receive `agents:configure` and `agents:suggest-changes`. `agents:configure` permits reads and direct changes; `agents:suggest-changes` retains reads and consented changes. Protected-change and responsible-user checks still apply. |
| Skill changes | New standard agents receive direct `skills:create` and `skills:suggest-changes` grants. |
| Tool access and management | New standard agents receive `tools:manage_connections`, `tools:manage_profiles`, `tools:view_audit`, `tools:use`, and `tools:manage_runtime` grants. Tool, connection, profile, and runtime policy checks still apply. |
| Audit and inbox | New standard agents receive `audit:view_agent_actions` and `inbox:manage` grants. The default inbox grant is limited to the responsible-user path and still follows that user's inbox policy. Cross-user management requires a separately configured grant or the target user's saved consent policy. |
| Task assignment and checkout control | New standard agents receive `tasks:assign`, `tasks:assign_scope`, and `tasks:manage_active_checkouts` grants, subject to company and route checks. The `tasks:assign_scope` grant covers the new agent's own reporting subtree; an explicit invitation scope is preserved. |
| Agent creation | New standard agents have `canCreateAgents: true`. This is a legacy authorization path for `agents:create`, not an `agents:create` grant row. Stored legacy records without the flag stay closed. |
| Skill creation setting | `canCreateSkills: true` is the normalized setting. Protected skill configuration changes still require a direct `skills:create` grant or a consented `skills:suggest-changes` grant. |
| Same-company visibility and work | Standard agents can read same-company agents, projects, issues, and company scope; read and manage decision queues; read runtime and secret metadata where the route allows it; comment or mutate their own or unassigned issues; and assign tasks under the assignment policy. The route and resource checks still apply. |
| Own configuration and wake | An agent can read its own configuration, update unprotected parts of it, and wake itself. Protected changes still require the relevant grant. |

## Not granted by default

These permission keys have no blanket grant for new standard agents: `agents:create` (the flag above is separate), `environments:manage`, `tools:admin`, `users:invite`, `users:manage_permissions`, and `joins:approve`. Existing agents keep their current permissions. The defaults above apply when a new standard agent is created or a pending new hire is activated. Some actions have separate bounded paths; the absence of a grant row does not describe every route decision.

The new direct grants do not grant company administration, user permission management, blanket tool administration, or cross-company access. The responsible user's permissions, route checks, and the normal approval gates still apply.

Agent-authenticated callers cannot set process adapter configuration or switch an existing agent onto the process adapter. For local adapters, they cannot change host command, argument, working-directory, arbitrary environment, or filesystem sandbox command settings. Provider credential secret references on known environment keys remain allowed so agents can hire peers with their own credentials. When a caller uses an AI connection pool, a new peer can use a plain provider authentication override on the small allowlist of supported keys. Arbitrary environment keys remain blocked. The same limits apply to creation, hiring, adapter switches, and configuration rollback. They also cannot restore host-executed workspace commands through a configuration revision. This keeps host-executed commands under board control while standard agents configure other supported agent settings.

## Exceptions and rollout

The new direct grants are withheld from low trust agents and managed built-in agents. Low trust run or project policies can also deny privileged actions even if an agent has a grant. A standard pending new hire receives the new default set when approved and activated. Invitation approval retains the set when it replaces a new agent's grants and preserves any explicitly scoped default grant. Existing scoped grants stay unchanged. A grant removed by an operator stays removed; ordinary updates and startup do not reapply it.

Migration `0423_agent_config_read_defaults` adds only `agents:read` to existing ready, paused, pausing or resuming standard agents with an active same-company membership. It skips setup holds or setup pause reasons, managed built-ins, nonstandard trust policies, pending or terminated agents, and agents with scoped configuration/suggestion grants. An existing read grant keeps its scope. Each addition has a system audit entry. Existing write grants are unchanged. The migration intentionally adds read access even when an older write grant is absent; it does not infer that a missing write grant denies the new independent read capability. Removing the read grant after this one-time migration persists across restarts and ordinary updates. `agents:configure` and `agents:suggest-changes` still independently imply reads within their scopes.

Agents can read their own redacted configuration, skills and configuration history without a peer-read grant. Target-scoped reads identify the target agent, so scoped read grants also work on individual configuration and instruction routes. Company-wide configuration listings require company-wide read authority. Basic same-company agent profiles remain readable through their existing visibility rules.

The standard agent configuration default supports the agent setup in the linked runner task. Enabling a warm runtime can still depend on the target agent's adapter and runtime configuration, provider availability, and any responsible-user or approval checks.

## Connection administration (2026-10-13)

The five default tool grants are usable through the existing connection APIs and default native `search_api`/`call_api`. A fresh standard agent for a normally provisioned Operator can configure app/tool, chat/email and AI connections, profiles and gateways without additional agent grants. Gateway management uses the agent's `tools:manage_connections` grant and still requires `tools:admin` on the responsible human. It does not grant blanket agent administration.

Connection management always intersects the current human's authority, including in responsible-user shadow mode. Personal self-service remains available where the human setup surface permits it; sharing and assignments require authority over their targets. Current run/work-mode/trust restrictions, scoped grants and explicit grant removal remain effective. No existing-agent permissions are backfilled. Agent-issued gateway clients preserve this delegation at every use, even after the setup run ends.

See [the authorization and qualification record](plans/2026-10-13-connection-api-parity.md) and the operation-reviewed [agent access maps](../maps/agent-access-map/connection-setup.md). Human consent, credential entry and identity confirmation remain bounded handoffs to saved setup.

Authorized policy administration includes user-requested changes that loosen the acting agent’s own tool controls. These writes remain bounded by management grants, resource scope and the responsible user’s current authority; they do not need an additional approval solely because the agent is a target. Subsequent tool calls obey the resulting policy. Agents cannot approve their own governed action requests or edit their own principal permission grants.

## Individual interaction restrictions

Optional incoming and outgoing [interaction permissions](agent-interaction-permissions.md)
can narrow assignments, mentions, comments, task edits, and peer configuration.
Missing settings preserve these defaults; no existing agent is backfilled and
new agents do not persist default overrides. A human permission manager sets
individual controls with `agent interaction-permissions:update`; explicit `true`
does not override another authorization denial. These controls are separate from
principal grants, `canAssignTasks`, and low-trust presets.

## Shared default-open issue writes

For standard-trust agents, issue comments, issue field/status updates, child
creation under a parent, and assignment share one authorization rule: the
target issue must be visible to the agent and the responsible user represented
by the run must also be authorized. In V1, issue visibility defaults to the
whole company, so these writes are company-wide by default.

The shared rule does not widen low-trust, `skill_test`, or `task_bridge` key
scopes. It also does not replace run-lifecycle controls: checkout ownership,
active-run conflicts, status-transition validation, interaction ownership,
budget gates, and pause gates remain independently enforced. Comment access is
structurally downstream of issue read access (`issue:comment` is a subset of
`issue:read`).

Low-trust agents may create self-assigned tasks and subtasks inside their existing
project or root-task scope. Both creation endpoints enforce task-assignment
authorization, including responsible-user and protected-assignment checks, even
when the new task is unassigned. Created tasks retain the effective containment
policy and quarantined source attribution. Self-assigned decomposition does not
count as delegation back to another agent. Persistent instruction changes remain
restricted except for self-edits requested through authenticated owner chat.
That exception requires the current accepted identity and a recorded direct
board-message wake, and rechecks the user's current instruction-editing permission
when saving. It does not extend to outside work, subtasks, peer instructions, or
other privileged configuration. Denials name the specific restriction.

Authenticated board direction permits a low-trust agent to execute its own
human conversation or the exact task explicitly assigned or addressed by a human.
This server-owned exception is bound to the current assignee and the run's task;
it uses existing conversation identity and authenticated execution-request records,
including same-task retry ancestry. It does not expand inherited boundaries or
grant privileged tools. Backlog assignments retain the existing human requester
without starting a run. Reassignment transactionally cancels prior human requests,
including service/plugin writes; cancelled runs cannot authorize later retries. See [low-trust presets](LOW-TRUST-PRESETS.md) for containment details.

Project or repository access is a separate boundary from exact-task direction.
A workspace project denial appears on the task with a link to the agent's
Permissions / Trust settings. Board operators with `agents:create` can add
same-company projects through `POST /api/agents/:id/project-access`; the operation
locks the agent, preserves existing permissions and audits added projects.
Saving does not retry work. The task offers explicit Retry after the required
projects are allowed, and dispatch rechecks authorization. Readiness checks the
task's current organizational project and selected workspace source, including
a valid pending selection. Moving the task to an allowed project does not clear
a retained source's access requirement. Existing setup failures with the exact
project-boundary denial also receive the explanation on reload, without assuming
that the task's current project caused the historical failure. A stale or
unavailable workspace selection stays in the non-retryable failure state; it
does not ask the user to grant project access that cannot repair the selection.

Cross-issue writes are contained per heartbeat run. An agent-authored comment
may wake the target assignee, including an explicit `resume: true` comment on a
`done` or `cancelled` issue, but the wake remains agent-class and is subject to
the normal agent rewake throttle; comment presentation cannot give it human
wake privileges. Agent issue comments and updates require a persisted heartbeat
run bound to the authenticated agent and company; missing, invalid, or mismatched
run context fails closed before mutation. A run may attempt at most 20 cross-issue comments, issue
updates, or issue-thread interaction resolutions across one shared counter. The
server records each attempt with its source issue, target issue, run, count, and
rollout mode, and fails closed with the cap in the error once enforcement is
active. Writes to the run's own source issue are not counted. Assignee self-comments do not
wake the assignee, and a non-assignee comment cannot mint a mention grant.

Agent @-mentions are context links only: they do not wake the mentioned agent,
assign work, or forward comments to another task. Normal comment feedback still
routes to the current assignee. Work for another agent requires explicit
assignment, delegation, or a review request.

Agent-authored issue comments persist the responsible user derived from the
authenticated actor; clients cannot choose that attribution. Each comment also
records the write-policy reason, and spoof attempts fail with an audited 422.
Every issue PATCH emits an `issue.updated` activity receipt containing the
actor, responsible user, run, authorization reason, and field-level before/after
changes so both agent and board edits are visible in the issue activity stream.
