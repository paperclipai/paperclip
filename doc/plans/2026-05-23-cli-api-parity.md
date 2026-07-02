# CLI API Parity PRD

Date: 2026-05-23
Branch: `improvement/cli-api-parity`
Status: PRD

## Summary

Paperclip already exposes a broad REST API, but the CLI only covers a narrow operator slice: setup/configuration, context profiles, board auth, companies import/export/delete, issues basic CRUD/comments/checkout/release, approvals, agents list/get/local CLI key export, activity, dashboard, secrets basics, plugin lifecycle basics, feedback export, and cloud sync.

The next CLI product slice should make the CLI a real external API entry point:

1. Connect interactively as a board operator or as one agent in one company.
2. Mint, list, revoke, and use board and agent tokens intentionally.
3. Provide single-command agent execution and prompt handoff for scripts.
4. Add CLI coverage for API surfaces that are currently UI-only or curl-only.

The most important requirement is credential ergonomics. External integrations need a reliable "way in" to Paperclip:

- full board access via a board token approved by a user
- individual agent access via an agent API key scoped to a specific company and agent
- saved CLI profiles that know whether they are board or agent personas
- non-interactive commands that can run from shell scripts without a prior wizard

## Existing CLI Coverage

Current top-level command families:

- Setup/runtime: `onboard`, `doctor`, `configure`, `env`, `run`, `db:backup`, `allowed-hostname`, `env-lab`, `worktree`
- Context/auth: `context`, `auth login`, `auth logout`, `auth whoami`, `auth bootstrap-ceo`
- Companies: `company list`, `company get`, `company export`, `company import`, `company delete`, company feedback export
- Issues: `issue list`, `issue get`, `issue create`, `issue update`, `issue comment`, `issue checkout`, `issue release`, issue feedback export
- Agents: `agent list`, `agent get`, `agent local-cli`
- Approvals: `approval list/get/create/approve/reject/request-revision/resubmit/comment`
- Activity/dashboard: `activity list`, `dashboard get`
- Secrets: `secrets list/declarations/create/link/doctor/providers/migrate-inline-env`
- Plugins/cloud/feedback: basic lifecycle and transfer workflows

Current auth behavior:

- `auth login` creates a CLI auth challenge, opens the board approval URL, and stores the approved board token locally.
- `agent local-cli` creates an agent API key through board access, installs local skills, and prints `PAPERCLIP_API_URL`, `PAPERCLIP_COMPANY_ID`, `PAPERCLIP_AGENT_ID`, and `PAPERCLIP_API_KEY`.
- Every client command can accept `--api-base`, `--api-key`, `--context`, `--profile`, `--company-id`, and `--json`.

Main limitation:

- The CLI has no explicit concept of "I am connected as board" versus "I am connected as this agent in this company". It only has a raw bearer token plus optional company context.

## Product Goals

1. Make the CLI the canonical external connection surface for scripts, local agents, and human operators.
2. Reach near-parity with first-class REST API domains, starting with company-scoped control-plane operations.
3. Make token creation safe and auditable: keys are named, scoped, shown once, and easy to revoke.
4. Support both interactive and single-command flows.
5. Preserve existing API authorization boundaries: board has operator control; agent keys remain company and agent scoped.

## Non-Goals

- Do not turn the CLI into a full TUI replacement for the board UI.
- Do not weaken agent authorization to make script flows easier.
- Do not store plaintext tokens in repo files.
- Do not add project/issue privacy semantics; V1 visibility remains company-scoped.
- Do not make a generic `curl` passthrough the primary parity story.

## API Location Requirements

The CLI must always know which Paperclip API it is operating against. This is especially important for fork/local development, where Paperclip may run on `3101+` rather than the upstream default `3100`.

Resolution order:

1. Explicit `--api-base <url>`.
2. `PAPERCLIP_API_URL`.
3. Selected context profile `apiBase`.
4. Repo-local or instance config port, when available.
5. Default `http://localhost:3100`.

Behavior requirements:

- `paperclipai connect` must show the resolved API base before any auth or mutation and allow the user to override it.
- Non-interactive commands must accept `--api-base` and produce a clear connection error that includes the attempted URL and a health-check hint.
- Profiles must persist `apiBase` so a board/agent persona is always tied to the API instance it was created for.
- Commands that mint or use tokens must not silently fall back to a different API base if a stored credential is missing. They should ask interactively or fail with instructions in non-interactive mode.
- The quick verification after `connect` should call `GET /api/health` against the selected API base.

## Target User Flows

### Interactive Connection Wizard

Command:

```sh
paperclipai connect
```

Flow:

1. Resolve or ask for API base.
2. Fetch accessible companies with current board auth, or trigger `auth login`.
3. Ask whether the user wants to connect as:
   - Board operator
   - Agent in a company
4. If board:
   - Mint or reuse a named board token.
   - Save profile with `persona=board`, `apiBase`, `companyId`, and token env-var preference.
5. If agent:
   - Ask for company.
   - List agents in that company.
   - Create a named agent API key for the selected agent.
   - Save profile with `persona=agent`, `companyId`, `agentId`, `agentName`, and token env-var preference.
6. Print shell exports and a verification command.

Expected profile shape should evolve from today's context:

```json
{
  "version": 2,
  "currentProfile": "default",
  "profiles": {
    "default": {
      "apiBase": "http://localhost:3100",
      "companyId": "company-id",
      "persona": "agent",
      "agentId": "agent-id",
      "apiKeyEnvVarName": "PAPERCLIP_API_KEY"
    }
  }
}
```

### Board Token Flow

Commands:

```sh
paperclipai token board create --company-id <company-id> --name "external-admin"
paperclipai token board list
paperclipai token board revoke <key-id>
```

Requirements:

- Board token creation must require an authenticated board approval or an existing board token with sufficient authority.
- Token output shows plaintext once.
- Tokens should have names, creation time, last-used time, expiration, and revoked status.
- A company ID in the profile selects the operating company, but full board tokens retain the server's board authorization model.
- If product wants company-limited board keys, add that as an explicit server-side scope rather than relying on client context.

Current API support:

- Existing challenge flow supports browser-approved board token minting via `/api/cli-auth/challenges`.
- Existing revocation only covers the current CLI key via `/api/cli-auth/revoke-current`.

API gap:

- There is no first-class board API key list/create/revoke endpoint for named external tokens. Add endpoints such as:
  - `GET /api/board-api-keys`
  - `POST /api/board-api-keys`
  - `DELETE /api/board-api-keys/:keyId`

### Agent Token Flow

Commands:

```sh
paperclipai token agent create --company-id <company-id> --agent <agent-id-or-name> --name "external-worker"
paperclipai token agent list --company-id <company-id> --agent <agent-id-or-name>
paperclipai token agent revoke --agent <agent-id-or-name> <key-id>
```

Requirements:

- Requires board access to create/list/revoke long-lived agent keys.
- Agent selector accepts UUID, url key, or unambiguous name within company.
- Output includes `agentId`, `companyId`, key id, key name, and plaintext token once.
- Agent keys remain scoped to one agent and one company, matching `agent_api_keys`.

Current API support:

- `GET /api/agents/:id/keys`
- `POST /api/agents/:id/keys`
- `DELETE /api/agents/:id/keys/:keyId`

CLI gap:

- `agent local-cli` can create a key, but it is bundled with skill installation and local CLI setup.
- There is no generic token command for list/revoke/create.

### Single-Command Prompt Handoff

Required user-facing shape:

```sh
paperclipai agent-prompt <agent-name-or-id> <agent-api-key> "Prompt here"
```

Recommended safer variants:

```sh
paperclipai agent prompt --agent <agent-name-or-id> --api-key-env PAPERCLIP_API_KEY "Prompt here"
paperclipai agent prompt --profile my-agent "Prompt here"
paperclipai board prompt --agent <agent-name-or-id> "Prompt here"
```

Behavior:

- With an agent key:
  - Verify identity with `GET /api/agents/me`.
  - Resolve the provided agent name/id against the authenticated agent. If they do not match, fail clearly.
  - Create a new issue assigned to that agent, or append to a specified issue when `--issue` is passed.
  - Optionally invoke/wake the agent when the authenticated agent is allowed to do so.
- With board auth:
  - Resolve company and target agent.
  - Create a board-authored issue assigned to that agent.
  - Wake/invoke the agent when requested.

Open decision:

- Default prompt target should be `issue create + assign + wake`, because Paperclip's communication model is tasks/comments, not chat.
- A direct "send message" mode can be `--issue <id>` and should add an issue comment plus optional wake.

## Missing CLI Coverage By API Domain

Priority is based on external API usefulness, not raw endpoint count.

OpenAPI source audit:

- Source branch: `feature/openapi-spec`
- Source file: `server/src/openapi.ts`
- Local snapshot for this PRD: `doc/plans/2026-05-23-cli-api-parity-openapi-reference.ts`
- Extracted operations: 307
- Validation context: that branch includes `server/src/__tests__/openapi-spec.test.ts`, which asserts the OpenAPI document covers mounted server routes exactly.
- Snapshot purpose: keep the full operation registrations, request schemas, auth annotations, response status overrides, and tag/summary values next to the CLI parity plan even before the OpenAPI branch is merged.

Additional gaps made explicit by the OpenAPI branch:

- Public/bootstrap surfaces need CLI decisions, not just board UI paths: `GET /api/openapi.json`, board-claim get/claim, invite onboarding docs, skill docs, join key claim, and CLI auth challenge status/approve/cancel.
- User/profile and admin surfaces were under-specified in the first PRD: auth session/profile, company user profile lookup, admin user list/promote/demote/company access.
- Legacy compatibility routes still exist and need an explicit stance: `/api/companies/:companyId/export`, `/api/companies/import/preview`, `/api/companies/import`, `/api/companies/issues`, and bare `GET /api/issues`.
- Agent operations need several extra CLI items: skills list/sync, `claude-login`, scheduler heartbeat visibility, org SVG/PNG export, adapter UI parser, and agent approval.
- Cost/budget coverage must reconcile the OpenAPI branch and current main. The OpenAPI branch lists `GET /api/companies/:companyId/cost-events`; current main exposes `POST /api/companies/:companyId/cost-events` plus additional summary and finance read endpoints. Treat this as a spec/code drift item before implementation.
- The current main branch includes secrets provider-config and remote-import routes beyond the OpenAPI branch list. Keep them in scope for CLI parity even though they are absent from that branch's generated spec.

### P0: Connection, Tokens, and Identity

Missing or incomplete CLI surfaces:

- Board token lifecycle:
  - `GET /api/cli-auth/me` is covered by `auth whoami`.
  - `POST /api/cli-auth/revoke-current` is covered by `auth logout`.
  - Missing named board key list/create/revoke API and CLI.
- Agent identity:
  - Missing `agent me` for `GET /api/agents/me`.
  - Missing `agent inbox` for `GET /api/agents/me/inbox-lite` and `GET /api/agents/me/inbox/mine`.
- Agent token lifecycle:
  - Missing generic CLI for `GET/POST/DELETE /api/agents/:id/keys`.
- Connect wizard:
  - No CLI command combines company selection, persona selection, token minting, profile saving, and verification.
- Public/bootstrap auth helpers:
  - `GET /api/board-claim/:token`
  - `POST /api/board-claim/:token/claim`
  - `POST /api/cli-auth/challenges`
  - `GET /api/cli-auth/challenges/:id`
  - `POST /api/cli-auth/challenges/:id/approve`
  - `POST /api/cli-auth/challenges/:id/cancel`
  - `POST /api/join-requests/:requestId/claim-api-key`

### P0: Prompt, Wake, and Run Control

Missing CLI surfaces:

- `POST /api/agents/:id/wakeup`
- `POST /api/agents/:id/heartbeat/invoke` is partially covered by `heartbeat run`, but not integrated with prompt handoff.
- `GET /api/companies/:companyId/heartbeat-runs`
- `GET /api/companies/:companyId/live-runs`
- `GET /api/heartbeat-runs/:runId`
- `POST /api/heartbeat-runs/:runId/cancel`
- `GET /api/heartbeat-runs/:runId/events`
- `GET /api/heartbeat-runs/:runId/log`
- `GET /api/issues/:issueId/live-runs`
- `GET /api/issues/:issueId/active-run`
- `GET /api/issues/:id/runs`
- `GET /api/heartbeat-runs/:runId/issues`
- `POST /api/heartbeat-runs/:runId/watchdog-decisions`
- `GET /api/heartbeat-runs/:runId/workspace-operations`
- `GET /api/workspace-operations/:operationId/log`

CLI commands to add:

```sh
paperclipai agent wake <agent>
paperclipai run list --company-id <company-id>
paperclipai run get <run-id>
paperclipai run log <run-id>
paperclipai run cancel <run-id>
paperclipai issue runs <issue-id>
```

### P1: Projects and Goals

Missing CLI surfaces:

- `GET /api/companies/:companyId/projects`
- `POST /api/companies/:companyId/projects`
- `GET /api/projects/:id`
- `PATCH /api/projects/:id`
- `DELETE /api/projects/:id`
- `GET /api/companies/:companyId/goals`
- `POST /api/companies/:companyId/goals`
- `GET /api/goals/:id`
- `PATCH /api/goals/:id`
- `DELETE /api/goals/:id`

Commands:

```sh
paperclipai project list|get|create|update|delete
paperclipai goal list|get|create|update|delete
```

### P1: Issue Parity Beyond Basic CRUD

Missing CLI surfaces:

- Issue counts/search/labels:
  - `GET /api/issues`
  - `GET /api/companies/:companyId/search`
  - `GET /api/companies/:companyId/issues/count`
  - `GET /api/companies/issues`
  - `GET/POST /api/companies/:companyId/labels`
  - `DELETE /api/labels/:labelId`
- Child issues:
  - `POST /api/issues/:id/children`
- Force-release/admin recovery:
  - `POST /api/issues/:id/admin/force-release`
- Documents:
  - `GET /api/issues/:id/documents`
  - `GET/PUT/DELETE /api/issues/:id/documents/:key`
  - lock/unlock/revisions/restore endpoints
- Work products:
  - `GET/POST /api/issues/:id/work-products`
  - `PATCH/DELETE /api/work-products/:id`
- Interactions:
  - `GET/POST /api/issues/:id/interactions`
  - accept/reject/respond/cancel endpoints
- Read/archive state:
  - `POST/DELETE /api/issues/:id/read`
  - `POST/DELETE /api/issues/:id/inbox-archive`
- Attachments:
  - `GET /api/issues/:id/attachments`
  - `POST /api/companies/:companyId/issues/:issueId/attachments`
  - `GET /api/attachments/:attachmentId/content`
  - `DELETE /api/attachments/:attachmentId`
- Comment-specific access:
  - `GET /api/issues/:id/comments/:commentId`
  - `DELETE /api/issues/:id/comments/:commentId`
- Recovery/tree control:
  - `GET /api/issues/:id/recovery-actions`
  - `POST /api/issues/:id/recovery-actions/resolve`
  - tree hold and preview endpoints

Commands:

```sh
paperclipai issue child create <issue-id>
paperclipai issue document list|get|put|delete|lock|unlock|revisions|restore
paperclipai issue work-product list|create|update|delete
paperclipai issue interaction list|create|accept|reject|respond|cancel
paperclipai issue attachment list|upload|download|delete
paperclipai issue force-release <issue-id>
paperclipai issue label list|create|delete
paperclipai issue read|unread|archive|unarchive
```

### P1: Agent Lifecycle and Configuration

Missing CLI surfaces:

- Create/update/pause/resume/approve/terminate/delete:
  - `POST /api/companies/:companyId/agents`
  - `PATCH /api/agents/:id`
  - `POST /api/agents/:id/pause`
  - `POST /api/agents/:id/resume`
  - `POST /api/agents/:id/approve`
  - `POST /api/agents/:id/terminate`
  - `DELETE /api/agents/:id`
- Org and config:
  - `GET /api/companies/:companyId/org`
  - `GET /api/companies/:companyId/org.svg`
  - `GET /api/companies/:companyId/org.png`
  - `GET /api/companies/:companyId/agent-configurations`
  - `GET /api/agents/:id/configuration`
  - config revision list/get/rollback
  - runtime state and task sessions
- Instructions:
  - instructions bundle, path, and file endpoints
- Adapter support:
  - models, model profiles, detect model, test environment
- Skills and local-auth helpers:
  - `GET /api/agents/:id/skills`
  - `POST /api/agents/:id/skills/sync`
  - `POST /api/agents/:id/claude-login`
- Scheduler visibility:
  - `GET /api/instance/scheduler-heartbeats`

Commands:

```sh
paperclipai agent create|update|pause|resume|approve|terminate|delete
paperclipai agent org
paperclipai agent config get|revisions|rollback
paperclipai agent instructions get|set|file
paperclipai adapter list|models|profiles|detect|test|install|enable|disable|reload
```

### P1: Costs, Budgets, and Finance

Missing CLI surfaces:

- `POST /api/companies/:companyId/cost-events`
- `GET /api/companies/:companyId/cost-events` from the OpenAPI branch needs reconciliation with main before implementation.
- `POST /api/companies/:companyId/finance-events`
- cost summaries by agent/model/provider/biller/project
- finance summaries by biller/kind and finance events
- quota windows and window spend
- budget overview, budget policies, budget incident resolution
- `PATCH /api/companies/:companyId/budgets`
- `PATCH /api/agents/:agentId/budgets`
- `GET /api/issues/:id/cost-summary`

Commands:

```sh
paperclipai cost summary|by-agent|by-project|by-provider|issue
paperclipai cost event create
paperclipai finance event create|list|summary
paperclipai budget overview|set-company|set-agent|policy-create|incident-resolve
```

### P1: Access, Invites, and Memberships

Missing CLI surfaces:

- Invite creation/list/revoke and onboarding manifests
- Join request list/approve/reject/claim API key
- Company members and user directory
- Member role/grant/permission updates
- Admin users and company access management
- Board claim endpoints
- Skills index/invite onboarding docs
- Auth/profile endpoints:
  - `GET /api/auth/get-session`
  - `GET /api/auth/profile`
  - `PATCH /api/auth/profile`
  - `GET /api/companies/:companyId/users/:userSlug/profile`

Commands:

```sh
paperclipai invite create|list|revoke|show|onboarding
paperclipai join list|approve|reject|claim-key
paperclipai member list|update|archive|permissions
paperclipai admin user list|promote|demote|company-access
```

### P2: Routines, Workspaces, Environments

Missing CLI surfaces:

- Routines API:
  - list/create/get/update/revisions/restore/runs/run/triggers/rotate-secret/public fire
- Environments API:
  - list/capabilities/create/get/update/delete/probe/leases
- Execution and project workspaces:
  - execution workspace list/get/patch/close readiness/operations/runtime actions
  - project workspace list/create/update/delete/runtime actions

Commands:

```sh
paperclipai routine list|create|get|update|run|runs|trigger|revision
paperclipai environment list|create|get|update|delete|probe|leases
paperclipai workspace list|get|update|operations|runtime
paperclipai project workspace list|create|update|delete|runtime
```

### P2: Instance, Sidebar, Assets, Profile, and Miscellaneous

Missing CLI surfaces:

- Instance settings general/experimental and database backups API
- Sidebar preferences and sidebar badges
- Asset image/logo upload and asset content download
- User profile read/update and company user profile lookup
- LLM prompt docs endpoints
- Public API documentation endpoint:
  - `GET /api/openapi.json`
- Plugin deeper surfaces:
  - tools list/execute
  - UI contributions
  - plugin config/test
  - plugin health/logs/jobs/webhooks/local folders/dashboard
- Company create/update/archive/branding/stats are missing or partial in CLI.
- Company portability compatibility routes:
  - `POST /api/companies/:companyId/export`
  - `POST /api/companies/import/preview`
  - `POST /api/companies/import`
  - `POST /api/companies/:companyId/exports`
  - `POST /api/companies/:companyId/exports/preview`
  - `POST /api/companies/:companyId/imports/preview`
  - `POST /api/companies/:companyId/imports/apply`

## Command Taxonomy

Recommended command hierarchy:

```text
paperclipai connect
paperclipai token board|agent create|list|revoke
paperclipai whoami
paperclipai prompt ...
paperclipai board ...
paperclipai agent ...
paperclipai issue ...
paperclipai project ...
paperclipai goal ...
paperclipai run ...
paperclipai cost ...
paperclipai budget ...
paperclipai routine ...
paperclipai environment ...
paperclipai workspace ...
paperclipai invite ...
paperclipai member ...
paperclipai plugin ...
paperclipai instance ...
```

Alias policy:

- Keep existing commands working.
- Add aliases only for high-frequency flows, for example `paperclipai ask` as an alias for `paperclipai prompt`.

## Authorization Rules

- Board commands should use board tokens and fail clearly when an agent key is supplied.
- Agent commands should prefer `GET /api/agents/me` to establish identity instead of trusting CLI flags.
- `--company-id` is a context selector, not an authorization bypass.
- Token creation and revocation must log activity through existing server routes.
- Commands that mutate company state should print the actor type and target company in `--json` output when practical.

## Testing Rules

Automated tests should prefer mocked HTTP/server fixtures where possible. Live/API verification is allowed, but it must be isolated:

- Live tests must create a new disposable company specifically for that test run.
- Live tests must never use an existing company from the operator's profile, local instance, or shared environment.
- The disposable company name should include a clear prefix such as `CLI Parity Test` plus a timestamp or random suffix.
- All agents, projects, issues, tokens, budgets, secrets, routines, workspaces, and other test data must be created inside the disposable company.
- Agent API keys used in tests must be minted only for agents created inside the disposable company.
- Board token tests must use a test-specific key name and revoke the key during cleanup when the API supports it.
- Cleanup should archive or delete the disposable company when the server permits it. If deletion is disabled, the test must leave the company clearly named as disposable and report its ID.
- Commands must provide a `--yes` or non-interactive path for test setup so CI and local verification do not depend on manual prompts.
- Destructive tests must require an explicit test opt-in such as an env var or a dedicated test command; normal unit tests must not mutate a real running Paperclip instance.

## Implementation Plan

### Phase 1: Credential and Persona Foundation

- Extend CLI context to version 2 with `persona`, `agentId`, and token metadata.
- Add `connect` wizard.
- Add `token agent create/list/revoke`.
- Add `agent me`.
- Add `agent prompt` and `prompt` using issue create/comment plus optional wake.
- Harden API base resolution and connection diagnostics.
- Add tests around context migration, explicit token precedence, and persona mismatch failures.
- Add live-test helpers that always create a disposable company before exercising real API mutations.

### Phase 2: Board Token Management

- Add server endpoints for named board API key lifecycle if product approves direct token management.
- Add CLI `token board create/list/revoke`.
- Keep browser approval as the default interactive path.
- Add expiration and naming options.

### Phase 3: Core API Parity

- Add projects/goals.
- Add agent lifecycle/config/instructions.
- Add run/heartbeat inspection and cancellation.
- Add issue documents/work products/interactions/attachments/labels.

### Phase 4: Operations Parity

- Add costs/budgets/finance.
- Add access/invites/members/admin users.
- Add routines/environments/workspaces.
- Expand plugin and instance settings surfaces.

## Acceptance Criteria

- A new user can run `paperclipai connect`, confirm or override the API base, select board or agent, and get a saved working profile tied to that API base.
- A board operator can mint an agent key for a selected agent in a selected company without using `agent local-cli`.
- A script can run a one-liner equivalent to:

```sh
paperclipai agent-prompt AgentName "$AGENT_API_KEY" "Prompt here"
```

- The one-liner creates or updates Paperclip work, does not require a browser, and fails with a clear company/agent mismatch error when the token does not belong to the requested agent.
- Live/API verification creates and uses a disposable company only; no existing company is used for testing.
- CLI docs list which API route families are covered and which remain UI-only.
- Token creation, revocation, and prompt handoff have tests for board and agent auth paths.

## Risks

- Board token lifecycle endpoints may create a broader security surface if expiration, revocation, and audit logging are incomplete.
- A raw prompt command can look like chat; the implementation must keep prompts attached to issues/comments.
- Agent name selectors can be ambiguous; require exact UUID/urlKey or fail on duplicate names.
- CLI parity can sprawl. Ship by user workflow, not by endpoint count alone.

## OpenAPI Reference

The full OpenAPI source snapshot is kept next to this PRD at `doc/plans/2026-05-23-cli-api-parity-openapi-reference.ts`. Use that file when request body schemas, auth levels, response statuses, tags, operation summaries, or the complete endpoint inventory are needed.
