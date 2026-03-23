# CEO Agent Creation and Hiring Governance Plan (V1.1)

Status: Proposed  
Date: 2026-02-19  
Owner: Product + Server + UI + Skills

## 1. Goal

Enable a CEO agent to create new agents directly, with lightweight but explicit governance:

- Company-level toggle: new hires require board approval (default ON).
- Agent-level permission: `can_create_agents` (default ON for CEO, OFF for everyone else).
- Clear hire workflow with draft/limbo state until approval.
- Config reflection so hiring agents can inspect available adapter configuration and compare existing agent configs (including self).
- Approval collaboration flow with comments, revision requests, and audit trail.

## 2. Current State (Repo Reality)

- Agent creation is board-only at `POST /api/companies/:companyId/agents` (`server/src/routes/agents.ts`).
- Approvals support `pending/approved/rejected/cancelled` and `hire_agent` + `approve_ceo_strategy` (`packages/shared/src/constants.ts`, `server/src/services/approvals.ts`).
- `hire_agent` approval currently creates the agent only on approval; there is no pre-created limbo agent.
- There is no agent permissions system today.
- There is no company setting for "new hires require board approval".
- Approvals have no comment thread or revision-request state.
- Inbox and Approvals UIs support approve/reject only; no approval detail route exists in app routes.
- Agent adapter configuration is free-form JSON; no runtime reflection endpoint exists for machine-readable or text discovery.

## 3. Product Decisions

## 3.1 Company setting

Add company setting:

- `requireBoardApprovalForNewAgents: boolean`
- Default: `true`
- Editable only in company advanced settings (not onboarding/company creation flow UI)

## 3.2 Agent permissions

Introduce lightweight permission model with one explicit permission now:

- `can_create_agents: boolean`

Defaults:

- CEO: `true`
- Everyone else: `false`

Authority:

- Board can edit permissions for any agent.
- CEO can edit permissions for agents in same company.

No broader RBAC system in this phase.

## 3.3 Limbo state for hires

Introduce dedicated non-operational status:

- `pending_approval`

Meaning:

- Agent record exists in org tree and can be reviewed.
- Agent cannot run, receive assignments, create keys, or be resumed to active states until approved.

## 4. Data Model Changes

## 4.1 `companies`

Add column:

- `require_board_approval_for_new_agents` boolean not null default `true`

Sync required:

- `packages/db/src/schema/companies.ts`
- `packages/shared/src/types/company.ts`
- `packages/shared/src/validators/company.ts`
- UI company API type usage and company advanced settings form

## 4.2 `agents`

Add columns:

- `permissions` jsonb not null default `{}`
- status value expansion to include `pending_approval`

Sync required:

- `packages/db/src/schema/agents.ts`
- `packages/shared/src/constants.ts` (`AGENT_STATUSES`)
- `packages/shared/src/types/agent.ts`
- `packages/shared/src/validators/agent.ts`
- status badges, filters, and lifecycle controls in UI

## 4.3 `approvals`

Keep approval as central governance record; extend workflow support:

- add status `revision_requested`
- ensure payload for hire approvals contains:
  - `agentId`
  - `requestedByAgentId`
  - `requestedConfigurationSnapshot`

## 4.4 New `approval_comments` table

Add discussion thread for approvals:

- `id`, `company_id`, `approval_id`, `author_agent_id`, `author_user_id`, `body`, timestamps

Purpose:

- review comments
- revision requests
- rationale for approve/reject
- permanent audit trail

## 5. API and AuthZ Plan

## 5.1 Permission helpers

Add server-side authz helpers:

- `assertCanCreateAgents(req, companyId)`
- `assertCanManageAgentPermissions(req, companyId)`

Rules:

- Board always passes.
- Agent passes `can_create_agents` check if self permission true and same company.
- Permission management by CEO or board.

## 5.2 Hire creation flow

Add route:

- `POST /api/companies/:companyId/agent-hires`

Behavior:

- Requires `can_create_agents` (or board).
- Creates agent row first.
- If company setting requires approval:
  - create agent with `status=pending_approval`
  - create `approvals(type=hire_agent,status=pending,payload.agentId=...)`
  - return both agent + approval
- If setting disabled:
  - create agent as `idle`
  - no approval record required

Board may continue using direct create route, but this route becomes canonical for CEO/agent-led hiring.

## 5.3 Approval workflow endpoints

Add/extend:

- `GET /api/approvals/:id`
- `POST /api/approvals/:id/request-revision`
- `POST /api/approvals/:id/resubmit`
- `GET /api/approvals/:id/comments`
- `POST /api/approvals/:id/comments`

Update existing approve/reject semantics:

- approve of hire transitions linked agent `pending_approval -> idle`
- reject keeps linked agent in non-active state (`pending_approval` or `terminated`/purged later)

## 5.4 Agent permission management endpoints

Add:

- `PATCH /api/agents/:id/permissions`

Supports initial key only:

- `{ "canCreateAgents": boolean }`

## 5.5 Read config endpoints (protected)

Add permission-gated config-read endpoints:

- `GET /api/companies/:companyId/agent-configurations`
- `GET /api/agents/:id/configuration`

Access:

- board
- CEO
- any agent with `can_create_agents`

Security:

- redact obvious secret values from adapter config (`env`, API keys, tokens, JWT-looking values)
- include redaction marker in response

## 5.6 Reflection endpoints for adapter configuration

Add plain-text reflection routes:

- `GET /llms/agent-configuration.txt`
- `GET /llms/agent-configuration/:adapterType.txt`

Index file includes:

- installed adapter list for this Paperclip instance
- per-adapter doc URLs
- brief "how to hire" API sequence links

Per-adapter file includes:

- required/optional config keys
- defaults
- field descriptions
- safety notes
- example payloads

Auth:

- same gate as config-read endpoints (board/CEO/`can_create_agents`).

## 6. Adapter Protocol Extension

Extend `ServerAdapterModule` contract to expose config docs:

- `agentConfigurationDoc` (string) or `getAgentConfigurationDoc()`

Implement in:

- `packages/adapters/claude-local`
- `packages/adapters/codex-local`
- `server/src/adapters/registry.ts`

This is required so reflection is generated from installed adapters, not hardcoded.

## 7. UI Plan

## 7.1 Company advanced settings

In Companies UI, add advanced settings panel/modal with:

- toggle: "Require board approval for new agent hires" (default on)

Not shown in onboarding flow.

## 7.2 Agent permissions UI

In Agent Detail (board/CEO context):

- permissions section
- toggle for "Can create new agents"

## 7.3 Hire UX

Add "Hire Agent" flow (for CEO/authorized agents):

- choose role/name/title/reportsTo
- compose initial prompt/capabilities
- inspect adapter reflection docs
- inspect existing related agent configurations
- submit hire

State messaging:

- if approval required: show "Pending board approval"
- if not required: show active-ready state

## 7.4 Approvals UX

Add approval detail page and expand inbox integration:

- `/approvals/:approvalId`
- threaded comments
- revision request action
- approve/reject with decision note
- activity timeline (created, revisions, decisions)

## 7.5 Disapproved agent cleanup

Provide board-only destructive action in approval detail:

- "Delete disapproved agent"
- explicit confirmation dialog
- preserves approval + comment history (audit)

## 8. New Skill: `paperclip-create-agent`

Create new skill directory:

- `skills/paperclip-create-agent/SKILL.md`
- `skills/paperclip-create-agent/references/api-reference.md`

Skill responsibilities:

- Discover available adapter configuration via `/llms/agent-configuration*.txt`
- Read existing agent configurations (including self and related roles)
- Propose best-fit config for current environment
- Draft high-quality initial prompt for new agent
- Set manager/reporting line
- Execute hire API flow
- Handle revision loop with board comments

Also update `skills/paperclip/SKILL.md` to reference this skill for hiring workflows.

## 9. Enforcement and Invariants

New/updated invariants:

- `pending_approval` agents cannot:
  - be invoked/woken
  - be assigned issues
  - create or use API keys
  - transition to active lifecycle states except through hire approval
- approval transitions:
  - `pending -> revision_requested | approved | rejected | cancelled`
  - `revision_requested -> pending | rejected | cancelled`
- every mutation writes `activity_log` records.

## 10. Implementation Phases

## Phase 1: Contracts and migration

- DB schema updates (`companies`, `agents`, approvals status expansion, `approval_comments`)
- shared constants/types/validators updates
- migration generation and typecheck

## Phase 2: Server authz + hire flow

- permission resolver and authz guards
- `agent-hires` route
- limbo status enforcement in heartbeat/issue/key flows
- approval revision/comment endpoints

## Phase 3: Reflection and config-read APIs

- adapter protocol docs support
- `/llms/agent-configuration*.txt` routes
- protected config-read endpoints with redaction

## Phase 4: UI and skilling

- company advanced setting UI
- permission controls
- approval detail + comments/revision flow in inbox/approvals
- disapproved agent delete flow
- `paperclip-create-agent` skill + docs updates

## 11. Test Plan

Server tests:

- permission gate tests for hire/config-read/permission-update endpoints
- hire creation behavior with company setting on/off
- approval transitions including revision cycle
- pending_approval enforcement across wakeup/invoke/assignment/keys
- config redaction tests

UI tests:

- advanced setting toggle persistence
- approval detail comment/revision interactions
- hire flow states (pending vs immediate)

Repo verification before merge:

- `pnpm -r typecheck`
- `pnpm test:run`
- `pnpm build`

## 12. Risks and Mitigations

- Risk: leaking secrets through agent config reads.
  - Mitigation: strict redaction pass + allowlist/denylist tests.
- Risk: status explosion complexity.
  - Mitigation: single added status (`pending_approval`) with explicit transition guards.
- Risk: approval flow regressions.
  - Mitigation: centralize transition logic in approval service and back it with tests.

## 13. Open Decisions (Default Recommendation)

1. Should board direct-create bypass approval setting?
Recommendation: yes, board is explicit governance override.

2. Should non-authorized agents still see basic agent metadata?
Recommendation: yes (name/role/status), but configuration fields stay restricted.

3. On rejection, should limbo agent remain `pending_approval` or move to `terminated`?
Recommendation: move to `terminated` on final reject; keep optional hard delete action for cleanup.
