# Agent permission defaults

This document describes the server defaults for an ordinary, standard trust agent. An agent must belong to the same company and be active where the action requires active membership. A responsible user's authority, project or run trust policy, scope rules, and approval gates can narrow these defaults.

## Granted by default

| Capability | Source and limit |
| --- | --- |
| Agent configuration and suggestions | New standard agents receive direct, company-scoped `agents:configure` and `agents:suggest-changes` grants. Protected-change and responsible-user checks still apply. |
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

The new direct grants are withheld from low trust agents and managed built-in agents. Low trust run or project policies can also deny privileged actions even if an agent has a grant. There is no permission backfill or upgrade migration for existing agents. A standard pending new hire receives the new default set when approved and activated. Invitation approval retains the set when it replaces a new agent's grants and preserves any explicitly scoped default grant. Existing scoped grants stay unchanged. A grant removed by an operator stays removed; ordinary updates and startup do not reapply it.

The standard agent configuration default supports the agent setup in the linked runner task. Enabling a warm runtime can still depend on the target agent's adapter and runtime configuration, provider availability, and any responsible-user or approval checks.

## Connection administration (2026-10-13)

The five default tool grants are usable through the existing connection APIs and default native `search_api`/`call_api`. A fresh standard agent for a normally provisioned Operator can configure app/tool, chat/email and AI connections, profiles and gateways without additional agent grants. Gateway management uses the agent's `tools:manage_connections` grant and still requires `tools:admin` on the responsible human. It does not grant blanket agent administration.

Connection management always intersects the current human's authority, including in responsible-user shadow mode. Personal self-service remains available where the human setup surface permits it; sharing and assignments require authority over their targets. Current run/work-mode/trust restrictions, scoped grants and explicit grant removal remain effective. No existing-agent permissions are backfilled. Agent-issued gateway clients preserve this delegation at every use, even after the setup run ends.

See [the authorization and qualification record](plans/2026-10-13-connection-api-parity.md) and the operation-reviewed [agent access maps](../maps/agent-access-map/connection-setup.md). Human consent, credential entry and identity confirmation remain bounded handoffs to saved setup.

Authorized policy administration includes user-requested changes that loosen the acting agent’s own tool controls. These writes remain bounded by management grants, resource scope and the responsible user’s current authority; they do not need an additional approval solely because the agent is a target. Subsequent tool calls obey the resulting policy. Agents cannot approve their own governed action requests or edit their own principal permission grants.

## Board administration of agent grants

A board operator with `users:manage_permissions` can list actual agent company
memberships with `GET /api/companies/:companyId/members?principalType=agent`.
The default members query still returns human members. Agent records contain
the membership ID, agent principal ID and explicit grants; they do not use human
roles or removal affordances.

Use `PATCH /api/companies/:companyId/members/:memberId/permissions` with the
complete desired `grants` array to replace an agent's grants. An empty array
revokes all explicit grants. Existing scopes are retained only when included in
the replacement. `users:manage_permissions` and `joins:approve` cannot be granted
to agent targets through this route. Other finite company permissions retain
their existing action-specific checks. An agent cannot use this route to change
its own or another agent's grants, even if it already holds the management key.
Each successful change records the board user's audit identity. Human member
role, owner, self-change and instance-admin protections remain unchanged.
