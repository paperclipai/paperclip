# Capability auto-install: MCP + skills + plugins (issue #2, sibling #5)

> Scope note: this shipped as one PR covering three capability-request types that
> share the approval carrier: `request_mcp_install` (new infra, below),
> `request_skill_install` (reuses `companySkillService.installFromCatalog`), and
> `request_plugin_install` (reuses the plugin loader via a seam injected from
> `app.ts`; instance-admin approval, instance-scoped). The agent raises a typed
> approval via a `paperclipRequest*` MCP tool; on approval the side-effect dispatch
> in `routes/approvals.ts` routes to the right installer. The installed-MCP-list UI
> on the agent detail page is deferred to a follow-up (visibility is via the
> approvals page + activity log; enable/disable/remove via the API).



## Problem

An Atelier agent that needs a tool (e.g. a browser MCP to do signups / publish a
page / post to a channel) is silently blocked: there is no way for it to request
an MCP server, and nothing provisions an MCP server into the agent runtime. This
is the concrete blocker hit live by the Million CEO on MIL-9 (ClearLabel pre-sell).

## Goal (DoD)

- An agent can emit a typed MCP install request.
- The CEO/board approves or rejects it from the board.
- On approval the MCP server becomes available in the agent runtime, fully audited.
- Any MCP secret goes through `company_secrets`, never plaintext in the audit trail.

V1 supports both transports: **http** (remote MCP, url + headers) and **stdio**
(a command the runtime launches, e.g. `npx -y <pkg>`). stdio runs an arbitrary
command in the runtime; the board approval IS the security gate, so the exact
command/args are shown on the approval screen.

## Architecture (reuse what exists)

Carrier = the existing **approvals** system, which already wakes the requesting
agent on approve (`routes/approvals.ts` → `heartbeat.wakeup` with
`approvalId`/`approvalStatus`). Secrets = existing `company_secrets` +
`secretsSvc.resolveEnvBindings` (bindings are `{type:"secret_ref", secretId,
version}`). Delivery channel to the adapter = a new `context.paperclipMcpServers`,
rendered by the adapter into a per-run `.mcp.json` + `--mcp-config`.

### 1. DB — `packages/db/src/schema/agent_mcp_servers.ts` (new)

`agentMcpServers` (durable record of an installed MCP server, per agent):
- `id`, `companyId` FK, `agentId` FK
- `name` text (the server key in `.mcp.json`), `description`
- `transport` text (`http | stdio`)
- `config` jsonb: for `stdio` `{command, args}`; for `http` `{url}`
- `envBindings` jsonb: `Record<string, EnvBinding>` — stdio: process env; http:
  request headers. Secret values are `{type:"secret_ref", secretId, version}`.
- `status` text default `enabled` (`enabled | disabled`)
- provenance: `sourceApprovalId`, `createdByActorType`/`Id`, timestamps
- index `(companyId, agentId, status)`

Hand-authored migration (drizzle-kit generate is broken upstream) + `_journal.json`
bump; export from `schema/index.ts`.

### 2. Shared — `packages/shared/src`

- `constants.ts`: add `"request_mcp_install"` to `APPROVAL_TYPES`;
  `MCP_TRANSPORTS = ["http","stdio"]`.
- `types/agent-mcp.ts`: `AgentMcpServer`, `McpTransport`, request payload type.
- `validators/agent-mcp.ts`: `requestMcpInstallSchema` (the approval payload the
  agent submits) and `createAgentMcpServerSchema`. Payload uses
  `env: [{ key, value? | secretName? }]`; secrets are declared by `secretName`
  only, never by value in agent payloads.
- `api.ts`: `agentMcpServers` path.

### 3. Server

- `services/agent-mcp-servers.ts` (new): `list/listEnabled/create/setStatus/remove`,
  and `provisionFromApproval(approval, {secretValues}, actor)` — upserts board-provided
  secrets into `company_secrets`, then inserts the `agentMcpServers` row binding each
  required env/header to its `secretId`. `buildRuntimeMcpServers(companyId, agentId)`
  resolves bindings via `secretsSvc.resolveEnvBindings` and returns the runtime shape.
- `routes/agent-mcp-servers.ts` (new): board+agent list; board enable/disable/delete.
  Register in app router + OpenAPI spec + the serialized openapi-routes test prefixes.
- `routes/approvals.ts`: in the `approve` handler `applied` block, when
  `approval.type === "request_mcp_install"`, call `provisionFromApproval` (board secret
  values come from an optional `mcpSecretValues` field added to `resolveApprovalSchema`),
  log `agent_mcp_installed`, then the existing wakeup runs.
- `services/heartbeat.ts`: at the run-context assembly (next to the memory injection),
  set `context.paperclipMcpServers = await agentMcpServersService(db).buildRuntimeMcpServers(...)`
  (resolved secrets included), or delete when empty.

### 4. Adapter — `packages/adapters/claude-local/src/server/execute.ts`

- Read `context.paperclipMcpServers`; build a `.mcp.json` (`{mcpServers:{...}}`):
  stdio → `{command, args, env}`; http → `{type:"http", url, headers}`.
- Write it to a per-run file on the execution filesystem (local fs for the in-container
  runtime; mirror the existing remote-config materialization when targeting a sandbox).
- In `buildClaudeArgs`, when a config was written, push `--mcp-config <file>` and
  `--strict-mcp-config` (so only board-approved servers load — no accidental cloud
  connectors). Record `mcpServerCount` in `promptMetrics`.

### 5. Agent-facing MCP tool — `packages/mcp-server/src/tools.ts`

- `paperclipRequestMcpServer` (+ `paperclipRequestSkillInstall`,
  `paperclipRequestPluginInstall`): the agent describes the server (name, transport,
  command/args|url, reason, `env[]` with optional `secretName`); the tool creates an
  approval of type `request_mcp_install`. Mirrors the existing approval-raising tools.

### 6. UI — `ui/src`

- Approval payload renderer for `request_mcp_install` (and the skill/plugin types):
  show name, transport, the exact command/args or url, reason, and the required secret
  NAMES (values are supplied as company secrets, not typed into the approval form).
- Installed-MCP list on the agent detail page is deferred to a follow-up (visibility in
  this PR is via the approvals page + activity log).

## Security

- stdio executes a command in the runtime → the board approves the exact command. Show
  it prominently; default-deny via `--strict-mcp-config`.
- Secret values never enter the approval payload or audit log; only secret NAMES/refs
  do. Values go straight to `company_secrets` (provider `local_encrypted`) and are
  resolved into env/headers at run time.

## Out of scope (V1)

- MCP marketplace / auto-discovery.
- Shipping system deps (a real chromium) into the sandbox image — a browser MCP should
  use an http-transport hosted server, or a later image change.

## Verification

- Service tests (embedded Postgres): provision-from-approval creates secrets + an
  enabled row binding to `secretId`; `buildRuntimeMcpServers` resolves and never leaks
  the value; disabled servers are excluded.
- Adapter: `.mcp.json` shape for both transports; `--mcp-config`/`--strict-mcp-config`
  added only when servers exist.
- `pnpm -r typecheck` + full `pnpm test:run` green (modulo known env-only failures).
