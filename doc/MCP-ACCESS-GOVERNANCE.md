# MCP Access Governance

Operator guide for Paperclip's MCP tool access surface. Audience: board users and CloudOps engineers who install connections, write policies, approve action requests, and respond to runtime alerts. For runtime alert response, pair this with [MCP-RUNTIME-OPERATIONS.md](./MCP-RUNTIME-OPERATIONS.md).

> Time-to-first-success: under 5 minutes if you follow [Quick start](#quick-start) and use the bundled example. Everything else is reference and how-to material that you read on demand.

## Contents

- [Mental model](#mental-model)
- [Canonical integration model](#canonical-integration-model)
- [Quick start](#quick-start)
- [Paperclip as MCP endpoint vs MCP gateway](#paperclip-as-mcp-endpoint-vs-mcp-gateway)
- [Managed connections](#managed-connections)
- [Catalog and risk classification](#catalog-and-risk-classification)
- [Profiles and bindings](#profiles-and-bindings)
- [Policies](#policies)
- [Approval flow and trust rules](#approval-flow-and-trust-rules)
- [Runtime slots](#runtime-slots)
- [Audit and the call event log](#audit-and-the-call-event-log)
- [Local trusted deployment](#local-trusted-deployment)
- [Known limitations](#known-limitations)
- [Reference](#reference)

## Mental model

Paperclip governs MCP tool access by separating four concerns:

```
┌────────────┐    ┌──────────────┐    ┌──────────┐    ┌────────────────┐
│Application │───▶│  Connection  │───▶│ Catalog  │    │   Profile      │
│  (logical) │    │ (endpoint+   │    │ (tools   │    │ (allow/deny    │
│            │    │  transport)  │    │ schema)  │    │  entries)      │
└────────────┘    └──────────────┘    └──────────┘    └────────┬───────┘
                                                               │ bound to
                                                               ▼
                                              agent / project / routine / issue / company
                                                               │
                                                               ▼
┌──────────┐  policy  ┌───────────┐  decision  ┌──────────────┐
│  Agent   │─────────▶│ Gateway   │───────────▶│  Tool call   │
│ tool call│          │ (policy   │            │   result     │
└──────────┘          │  engine)  │            └──────────────┘
                      └─────┬─────┘
                            │
                            ▼
                      ┌──────────┐
                      │  Action  │  human approve / reject
                      │  Request │  (UI / API)
                      └──────────┘
```

Plain prose version of the same graph:

- An **Application** is a logical grouping ("GitHub", "Linear", "Local todo fixture"). It owns one or more connections.
- A **Connection** is a single MCP endpoint. Transport is either `remote_http` (preferred) or `local_stdio` (gated by trusted deployment).
- A **Catalog Entry** is one tool discovered on a connection. Each entry carries a risk classification (`read`, `write`, `destructive`) and a status (`active`, `quarantined`, `disabled`).
- A **Profile** is a named bundle of allow/deny entries that picks which catalog entries an actor sees. Profiles attach to scopes via **Bindings** (`company`, `agent`, `project`, `routine`, `issue`).
- A **Policy** is an orthogonal rule applied at call time: `allow`, `block`, `require_approval`, `rate_limit`, or `trust_rule`. Deny beats allow.
- The **Gateway** is the runtime that an agent calls. It walks profiles + policies, returns a decision, records a **Call Event** in the audit log, and (if needed) opens an **Action Request** for human approval.

If you remember one thing: **profile says *can this agent see the tool*; policy says *is this exact call allowed right now***.

## Canonical integration model

This runbook covers the MCP gateway slice of the broader Apps v2 integration
model. Before adding a new provider, plugin-provided app, token store, or
connection UX path, read [Apps, Connections, and Integrations](./connections/README.md).
That document records the board decision that Apps v2 is canonical, defines the
shared vocabulary, and links the harvested v1 security threat model and first-30
connector matrix.

## Quick start

The fastest path is the bundled example. From the Tools & Access UI (`/<prefix>/companies/<companyId>/tools/examples`), pick **Safe read-only Todo / KV fixture** and click **Install**. Then run **Smoke**. You can also do it via API:

```sh
# Install the example application + connection + profile in one call.
curl -fsS -X POST \
  -H "Authorization: Bearer $BOARD_API_KEY" \
  -H "Content-Type: application/json" \
  "$PAPERCLIP_URL/api/companies/$COMPANY_ID/tools/examples/safe-read-only-todo-kv/install" \
  -d '{}' | jq .

# Run the bundled smoke check (validates an allowed read, a denied write, audit visibility).
curl -fsS -X POST \
  -H "Authorization: Bearer $BOARD_API_KEY" \
  -H "Content-Type: application/json" \
  "$PAPERCLIP_URL/api/companies/$COMPANY_ID/tools/examples/safe-read-only-todo-kv/smoke" \
  -d '{}' | jq '{ok, checks: [.checks[] | {name, ok, decision, reasonCode}]}'
```

Expected: `ok: true` with three green checks: `allow_read_tool`, `deny_write_tool`, `audit_written`.

If the smoke fails, fix the failing check before introducing any production connection. The bundled fixture only depends on local code, so any failure is a control-plane problem rather than an upstream MCP issue.

## Paperclip as MCP endpoint vs MCP gateway

Paperclip plays two roles in the MCP graph, and confusing them is the most common operator error.

```
              Paperclip as MCP endpoint
              (clients call Paperclip)
                       ┌──────────────┐
   Claude Code  ─────▶ │   Paperclip  │
   IDE / CLI    ─────▶ │ /mcp surface │
                       └──────────────┘
                          (task ops, agent ops)


              Paperclip as MCP gateway / proxy
              (agents call upstream MCP through Paperclip)

   ┌─────┐       ┌────────────┐       ┌──────────────┐
   │Agent│──────▶│ Paperclip  │──────▶│ Upstream MCP │
   │ run │       │  gateway   │       │ (GitHub etc.)│
   └─────┘       │  + policy  │       └──────────────┘
                 │  + audit   │
                 └────────────┘
```

**Endpoint mode** — Paperclip exposes its own MCP surface so external clients (Claude Code, IDEs, scripts) can manipulate Paperclip tasks and agents. This is what `doc/TASKS-mcp.md` covers. Access control here is the standard Paperclip auth model ([DEPLOYMENT-MODES.md](./DEPLOYMENT-MODES.md)): bearer keys, sessions, board API key.

**Gateway mode** — Paperclip proxies tool calls from a Paperclip agent to an upstream MCP server (GitHub, Linear, a local stdio fixture, etc.). Every call goes through profile selection, policy evaluation, optional human approval, rate limiting, redaction, and audit. This is what the rest of this document covers.

Operators usually mean *gateway* when they say "MCP access governance". For Paperclip-managed local adapter runs, Paperclip writes adapter MCP config that points at named gateway endpoints with short-lived scoped bearer tokens. Policies, approvals, and the audit log only exist for calls that enter gateway mode.

V1 does not claim host-wide MCP enforcement. If an unmanaged external client, hand-edited adapter config, or process outside the Paperclip-controlled workspace calls an upstream MCP server directly, Paperclip can warn about known overlapping config entries but cannot prevent or audit that bypass. Treat managed MCP config as a control-plane containment feature for Paperclip-launched agents, not as an endpoint firewall for the operator's whole machine.

## Managed connections

A connection is an enabled, governed link to one MCP server. Two transports are supported:

| Transport | When to use | Trust posture |
| --- | --- | --- |
| `remote_http` | Hosted SaaS MCP servers (GitHub, Linear, custom remote MCP). Default for cloud. | Paperclip authenticates with stored credential refs and proxies calls. Process supervision is upstream's problem. |
| `local_stdio` | Local fixtures or approved stdio templates that must run as a child process. | Only allowed when the host is explicitly trusted; see [Local trusted deployment](#local-trusted-deployment). Cloud public deployments fail closed unless a trusted runtime host is configured. |

Operators do not paste arbitrary `command` / `args` for stdio. Allowed stdio entries are limited to the approved template catalog (e.g. `paperclip.echo-calculator-time`, `paperclip.synthetic-todo-kv`). To add a new template, ship a code change.

### Create a connection (remote_http)

```sh
curl -fsS -X POST \
  -H "Authorization: Bearer $BOARD_API_KEY" \
  -H "Content-Type: application/json" \
  "$PAPERCLIP_URL/api/companies/$COMPANY_ID/tools/connections" \
  -d '{
    "applicationId": "'"$APPLICATION_ID"'",
    "name": "Linear (remote)",
    "transport": "remote_http",
    "transportConfig": {
      "url": "https://mcp.linear.app/mcp",
      "headers": []
    },
    "credentialRefs": [
      { "name": "Authorization", "secretId": "'"$LINEAR_SECRET_ID"'", "placement": "header", "key": "Authorization", "prefix": "Bearer " }
    ],
    "enabled": false
  }' | jq '{id, name, transport, status, enabled, healthStatus}'
```

Connections are created `enabled: false`. Run a health check and a catalog refresh before flipping `enabled: true`.

### Connection lifecycle

```sh
# Health check (no secrets in output)
curl -fsS -X POST -H "Authorization: Bearer $BOARD_API_KEY" -H "Content-Type: application/json" \
  "$PAPERCLIP_URL/api/tool-connections/$CONNECTION_ID/health-check" -d '{}' \
  | jq '{connection: {healthStatus: .connection.healthStatus, healthMessage: .connection.healthMessage}}'

# Catalog refresh (pulls schema, sets risk levels, quarantines unexpected writes)
curl -fsS -X POST -H "Authorization: Bearer $BOARD_API_KEY" -H "Content-Type: application/json" \
  "$PAPERCLIP_URL/api/tool-connections/$CONNECTION_ID/catalog/refresh" -d '{}' \
  | jq '{discoveredCount, quarantinedCount}'

# Enable
curl -fsS -X PATCH -H "Authorization: Bearer $BOARD_API_KEY" -H "Content-Type: application/json" \
  "$PAPERCLIP_URL/api/tool-connections/$CONNECTION_ID" \
  -d '{"enabled": true, "status": "active"}' | jq '{id, enabled, status, healthStatus}'

# Disable (does not delete; preserves audit history)
curl -fsS -X PATCH -H "Authorization: Bearer $BOARD_API_KEY" -H "Content-Type: application/json" \
  "$PAPERCLIP_URL/api/tool-connections/$CONNECTION_ID" \
  -d '{"enabled": false, "status": "disabled"}' | jq '{id, enabled, status}'
```

Connection statuses: `draft`, `active`, `disabled`, `archived`. Health statuses: `ok`, `unchecked`, `degraded`, `failed`, `error`, `missing_secret`.

## Catalog and risk classification

Each tool discovered on a connection becomes a **catalog entry** with a risk level Paperclip infers from MCP annotations:

| Risk | Trigger | Default treatment |
| --- | --- | --- |
| `read` | `annotations.readOnlyHint: true` or schema implies read-only | Allowed by read-friendly profiles. |
| `write` | `annotations.readOnlyHint: false` or `writeHint: true` | Requires approval by default unless the profile or a policy says otherwise. |
| `destructive` | `annotations.destructiveHint: true` | Quarantined on first sight. Requires explicit operator action before any agent call can succeed. |

When a catalog refresh discovers a new write/destructive tool that did not exist on the prior schema, Paperclip sets `status: quarantined` and records the reason in `quarantineReason`. Quarantined entries are never returned to the agent's tool list until an operator reviews and re-enables them. This is the **changed-tool quarantine** rule and the primary defense against an upstream server silently adding a destructive verb.

To inspect and re-enable a quarantined entry, use the UI Catalog view, or PATCH the entry's status via the catalog routes (see [Reference](#reference)).

## Profiles and bindings

A profile is a named bundle of allow/deny rules over the catalog. It does not, by itself, attach to anyone. Bindings put profiles on actors.

Example: create a profile that allows only read-only tools and bind it to a project.

```sh
# Profile with default-deny and one include entry for read-only catalog entries.
curl -fsS -X POST -H "Authorization: Bearer $BOARD_API_KEY" -H "Content-Type: application/json" \
  "$PAPERCLIP_URL/api/companies/$COMPANY_ID/tools/profiles" \
  -d '{
    "profileKey": "engineering.read-only",
    "name": "Engineering read-only",
    "defaultAction": "deny",
    "entries": [
      { "selectorType": "risk_level", "selectorValue": "read", "effect": "include" }
    ]
  }' | jq '{id, name, defaultAction}'

# Bind it to a project so every agent run in that project gets this profile.
curl -fsS -X POST -H "Authorization: Bearer $BOARD_API_KEY" -H "Content-Type: application/json" \
  "$PAPERCLIP_URL/api/companies/$COMPANY_ID/tools/profiles/$PROFILE_ID/bind" \
  -d '{ "targetType": "project", "targetId": "'"$PROJECT_ID"'", "priority": 10 }' | jq .
```

Selector types:
- `application` — every catalog entry under an application
- `connection` — every catalog entry under one connection
- `catalog_entry` — one specific tool
- `tool_name` — pattern match on tool name (e.g. `"list_*"`)
- `risk_level` — `read`, `write`, or `destructive`

Effects: `include` adds to the allowed set, `exclude` removes. `defaultAction` is the fallback when no entry matches.

Binding scopes, narrowest first: `issue` > `routine` > `agent` > `project` > `company`. The effective profile for an agent is computed at session time and cached on the gateway session. To preview:

```sh
curl -fsS -H "Authorization: Bearer $BOARD_API_KEY" \
  "$PAPERCLIP_URL/api/companies/$COMPANY_ID/tools/profiles/effective/agents/$AGENT_ID" \
  | jq '{profileIds, allowedToolNames}'
```

## Policies

Policies run after profile selection. A profile decides *can this agent see the tool*; a policy decides *is this exact call allowed right now*. Policy types:

| Type | Effect |
| --- | --- |
| `allow` | Explicit allow for matching selectors. Adds positive evidence; does not override a `block`. |
| `block` | Deny matching calls. **Deny always beats allow.** |
| `require_approval` | Force human approval for matching calls; opens an action request. |
| `rate_limit` | Apply a sliding-window counter. Match → consume; over limit → `rate_limited`. |
| `trust_rule` | Approval-derived allow rule scoped to specific argument shapes. See [Approval flow and trust rules](#approval-flow-and-trust-rules). |

Order of evaluation:
1. Catalog status: `quarantined`/`disabled` → immediate deny.
2. Profile: not in effective set → `deny`.
3. Policies in priority order. `block` short-circuits. `require_approval` short-circuits to an action request. `rate_limit` evaluates the counter.
4. If no policy matched and the profile allowed the tool: `allow`.

To dry-run a policy decision without making a real call. The dry-run endpoint takes a structured `{ companyId, actor, request, runContext? }` body and returns the decision under `.decision`:

```sh
curl -fsS -X POST -H "Authorization: Bearer $BOARD_API_KEY" -H "Content-Type: application/json" \
  "$PAPERCLIP_URL/api/companies/$COMPANY_ID/tools/policy/test" \
  -d '{
    "companyId": "'"$COMPANY_ID"'",
    "actor": {
      "actorType": "agent",
      "actorId": "'"$AGENT_ID"'",
      "agentId": "'"$AGENT_ID"'"
    },
    "request": {
      "toolName": "create_item",
      "arguments": { "title": "test" }
    }
  }' | jq '{decision: .decision.decision, matchedPolicyIds: .decision.matchedPolicyIds, reasonCode: .decision.reasonCode}'
```

Decisions: `allow`, `deny`, `require_approval`, `rate_limited`, `defer_runtime`. `defer_runtime` means the policy engine asked the gateway to consult runtime state (e.g. slot availability) before producing the final verdict.

## Approval flow and trust rules

When a call resolves to `require_approval`, the gateway opens an **Action Request** carrying:
- the agent, run, and tool identity,
- a canonical hash of the arguments (so we can match later trust rules),
- a `signedArguments` payload the approver sees verbatim,
- a linked issue-thread `request_confirmation` interaction for the in-app card,
- an expiry.

The gateway responds to the agent's tool call with HTTP `409`, `reasonCode: "approval_required"`, and the new `actionRequestId` in the body. The agent's run is paused on this exact call until a decision lands. Once approved, the agent retries the same tool call with `approvedActionRequestId` set; the gateway re-validates that the canonical arguments hash matches and then executes the tool.

After approval, the operator can promote that approval into a **trust rule**: a policy of `policyType: trust_rule` that allows the same tool with the same argument shape for the same actor scope, optionally for a limited number of approvals or until an expiry. This is how you avoid clicking *Approve* on every safe repetition of the same action.

```sh
# Approve via API (UI does the same). Approval requires companyId — body or query.
curl -fsS -X POST -H "Authorization: Bearer $BOARD_API_KEY" -H "Content-Type: application/json" \
  "$PAPERCLIP_URL/api/tool-gateway/action-requests/$ACTION_REQUEST_ID/approve" \
  -d '{ "companyId": "'"$COMPANY_ID"'" }' | jq '{id, status, resolvedAt, resolvedByUserId}'

# Retry the original tool call with approvedActionRequestId (the agent does this).
curl -fsS -X POST -H "X-Paperclip-Tool-Gateway-Token: $GATEWAY_TOKEN" -H "Content-Type: application/json" \
  "$PAPERCLIP_URL/api/tool-gateway/tools/call" \
  -d '{
    "tool": "create_item",
    "parameters": { "title": "Approved item" },
    "approvedActionRequestId": "'"$ACTION_REQUEST_ID"'"
  }' | jq '{invocationId, status, tool, result}'

# Promote the approval to a trust rule
curl -fsS -X POST -H "Authorization: Bearer $BOARD_API_KEY" -H "Content-Type: application/json" \
  "$PAPERCLIP_URL/api/companies/$COMPANY_ID/tools/action-requests/$ACTION_REQUEST_ID/trust-rule" \
  -d '{
    "approvalThreshold": 2,
    "expiresAt": "2026-09-01T00:00:00.000Z"
  }' | jq '{id, policyType, priority, config: {trustRule: .config.trustRule}}'

# Revoke a trust rule (audit-safe; does not delete)
curl -fsS -X POST -H "Authorization: Bearer $BOARD_API_KEY" -H "Content-Type: application/json" \
  "$PAPERCLIP_URL/api/companies/$COMPANY_ID/tools/trust-rules/$POLICY_ID/revoke" \
  -d '{ "reason": "Catalog schema changed." }' | jq '{id, enabled, config: {revokedAt: .config.trustRule.revokedAt}}'
```

Trust rules carry the catalog and schema hashes captured at approval time. If the upstream tool changes its schema or the canonical argument hash drifts, the trust rule stops applying — the next matching call falls back to `require_approval`. The retry-with-`approvedActionRequestId` flow enforces the same invariant for a single approval: change the arguments between approval and retry and the call fails with `reasonCode: "signed_arguments_mismatch"`. This is intentional: an approval is for a specific argument shape, not for "future versions of this tool, sight unseen".

In v1, trust-rule promotion is deliberately narrow: the server derives the reviewed actor/tool scope from the approved invocation and stores the exact reviewed argument hash. Promotion requests that try to widen the scope or replace exact-hash matching with broader argument predicates are rejected. Broader trust authoring needs a separately governed mechanism.

## Runtime slots

Local stdio connections run as supervised child processes. Each process is a **runtime slot** with a lifecycle: `stopped` → `starting` → `running` → `idle` → (`stopped`|`failed`).

You don't normally touch slots. They're spun up on first call and evicted after idle expiry. You only touch them when:

- a slot is stuck `starting` or `running` past 5 minutes,
- restart suppression has fired (too many restart attempts),
- a connection is being decommissioned and you need to free the process.

Day-to-day runtime response — health summary, stuck-slot diagnosis, stop/restart, restart-storm playbook — lives in [MCP-RUNTIME-OPERATIONS.md](./MCP-RUNTIME-OPERATIONS.md). Read that doc when paged.

Cloud reminder: in `authenticated/public`, local stdio slots fail closed unless `PAPERCLIP_TRUSTED_MCP_RUNTIME_HOST` is set on a worker explicitly designated to supervise local processes. Set it on one worker, not on the API edge.

## Audit and the call event log

Every tool invocation lands in the **call event log** (`tool_call_events`). Each event records:

- decision (`allow`, `deny`, `require_approval`, `rate_limited`),
- matched policy IDs,
- reason code (`deny_default`, `deny_policy_block`, `quarantined_catalog_entry`, `missing_secret`, etc.),
- redaction plan applied to arguments and results,
- latency,
- final outcome (`success`, `pending`, `denied`, `failure`, `timeout`).

To pull recent audit:

```sh
curl -fsS -H "Authorization: Bearer $BOARD_API_KEY" \
  "$PAPERCLIP_URL/api/tool-gateway/audit?companyId=$COMPANY_ID&limit=100" \
  | jq '[.[] | {createdAt, action: .action, decision: .details.decision, tool: .details.tool, outcome: .details.outcome, reasonCode: .details.reasonCode}]'
```

Two practical patterns:

- **Per-run timeline:** `GET /api/companies/:companyId/tools/runs/:runId/decisions` returns every policy decision attached to a single agent run. Use this in QA to prove an agent never touched a denied tool.
- **Approval audit:** the audit log itself is the approval-request ledger — filter the gateway audit response for `action == "tool_gateway.approval_requested"` to get the queue, and pair each row with the matching `tool_gateway.call_allowed` / `tool_gateway.call_denied` entry to see how the approval resolved. Approver identity lands on the action request itself; once approved, the action request body shows `resolvedByUserId` and `resolvedAt`.

Audit is the source of truth for the security memo. It is intentionally append-only — there is no edit or delete route.

## Local trusted deployment

Local stdio MCP connections introduce a different trust model from remote_http: Paperclip is running a child process under its own credentials. Two questions decide whether this is safe in your deployment:

1. **Who controls the host?** If the operator and the host are the same human (developer laptop, internal CI runner), you can opt into local stdio. If the host is multi-tenant (shared cloud worker), you must not.
2. **Who controls the template?** Only approved templates baked into the Paperclip build can run. Agents cannot supply arbitrary `command` / `args`.

The decision matrix:

| Deployment mode | Local stdio default | When to enable |
| --- | --- | --- |
| `local_trusted` | Available, used for fixtures and developer flows | Always; this mode exists for it. |
| `authenticated/private` (Tailnet/VPN/LAN) | Available with explicit opt-in | When the operator has root on the host and trusts the template list. |
| `authenticated/public` (internet-facing) | Fail closed | Only when one worker is designated trusted by setting `PAPERCLIP_TRUSTED_MCP_RUNTIME_HOST` and is isolated from the public-facing edge. |

In all modes:

- `remote_http` is the preferred path. If you can replace a local stdio fixture with a remote_http endpoint, do.
- Never set `PAPERCLIP_TRUSTED_MCP_RUNTIME_HOST` on the same worker that serves public HTTP traffic.
- Treat the approved-template list as a code-review surface: a PR that adds a new template ships a new code-execution path.

For deployment mode and bind semantics generally, see [DEPLOYMENT-MODES.md](./DEPLOYMENT-MODES.md).

## Known limitations

These are intentional gaps as of the MCP Access Governance v1 launch. Track or work around as noted.

- **Audit-write failures are production incidents.** `mcp_runtime_audit_write_failures` is backed by the durable runtime metric counter and fires when MCP audit-event persistence fails. Treat any firing alert as a control-plane incident — page CloudOps and freeze tool calls until audit durability is restored.
- **No CLI surface for tool access yet.** Connections, profiles, policies, approvals, and trust rules are managed via the UI and the REST API only. There is no `paperclipai tool ...` subcommand.
- **No bulk catalog review.** When an upstream server adds many new tools at once, you review each quarantined entry individually. Bulk operations are planned but not in v1.
- **Trust rules match exact argument shapes only.** A trust rule built from one approval covers calls whose canonical argument hash matches and whose catalog schema hash is unchanged. Wildcards and structural filters across the rest of the schema are not supported in v1.
- **Rate limits are per-policy.** Rate limit counters are scoped to the matching policy and counter key. There is no cross-policy aggregation (e.g. "300 requests/hour across all GitHub policies"). Operators who need that wire two `rate_limit` policies and accept the additive behavior.
- **Action request expiry is fixed by policy.** The approval card carries a server-set expiry; the human approver cannot extend it from the UI. If a request expires before approval, the agent must retry the tool call.
- **Endpoint mode (Paperclip as MCP server) is not policy-governed.** Tool access governance applies only to *gateway mode* — Paperclip's own MCP endpoint surface (`/mcp`) uses standard Paperclip auth and is not subject to the profile/policy stack.
- **No multi-region runtime supervisor.** Local stdio slots run on the worker that serves the request that started them. If you scale workers, slots do not migrate. Plan capacity per worker, not per cluster.

## Reference

| Surface | Path / endpoint | Notes |
| --- | --- | --- |
| UI overview | `/<prefix>/companies/<companyId>/tools` | All tabs: Overview, Examples, Applications, Connections, Profiles, Policies, Runtime, Audit. |
| Examples | `POST /api/companies/:companyId/tools/examples/:id/install` and `…/smoke` | Bundled fixtures for first-run validation. |
| Applications | `GET\|POST /api/companies/:companyId/tools/applications`, `PATCH /api/tool-applications/:id` | Logical groupings. |
| Connections | `GET\|POST /api/companies/:companyId/tools/connections`, `GET\|PATCH\|DELETE /api/tool-connections/:id` | `POST …/health-check`, `POST …/catalog/refresh`, `GET …/catalog` for lifecycle. |
| Profiles | `GET\|POST /api/companies/:companyId/tools/profiles`, `PATCH /api/tool-profiles/:id` | Entries: `POST /api/tool-profiles/:id/entries`, `PATCH\|DELETE /api/tool-profile-entries/:id`. |
| Bindings | `POST /api/companies/:companyId/tools/profiles/:id/bind` and `…/unbind` | Targets: `company`, `agent`, `project`, `routine`, `issue`. |
| Effective profile | `GET /api/companies/:companyId/tools/profiles/effective/agents/:agentId` | Use for QA proofs and debugging selector misses. |
| Policies | `GET\|POST /api/companies/:companyId/tools/policies`, `PATCH\|DELETE /api/companies/:companyId/tools/policies/:id` | Types: `allow`, `block`, `require_approval`, `rate_limit`, `trust_rule`. |
| Policy dry-run | `POST /api/companies/:companyId/tools/policy/test` | Structured `{ companyId, actor, request, runContext? }` body; decision returned under `.decision`. |
| Gateway sessions | `POST /api/tool-gateway/sessions`, `POST /api/tool-gateway/sessions/:sessionId/revoke` | Board callers must supply `companyId`, `agentId`, `runId` to create and `companyId` to revoke; agent JWTs auto-fill from the token. Revocation invalidates the session immediately and emits `tool_gateway.session_revoked` without logging the raw session token. |
| Gateway calls | `POST /api/tool-gateway/tools/call` | `X-Paperclip-Tool-Gateway-Token` header; body uses `tool` + `parameters`. Approval-required calls respond `409` with `reasonCode: approval_required` and an `actionRequestId`; the agent retries with `approvedActionRequestId`. |
| Action requests | `POST /api/tool-gateway/action-requests/:id/approve` | Requires `companyId` (body or query). Listing is via the audit log: filter for `tool_gateway.approval_requested`. |
| Trust rules | `POST /api/companies/:companyId/tools/action-requests/:id/trust-rule`, `POST /api/companies/:companyId/tools/trust-rules/:id/revoke` | Approval-derived allow policies. |
| Runtime health | `GET /api/companies/:companyId/tools/runtime-health` | Alerts and metrics. Pair with [MCP-RUNTIME-OPERATIONS.md](./MCP-RUNTIME-OPERATIONS.md). |
| Runtime slots | `GET /api/companies/:companyId/tools/runtime-slots`, `POST /api/companies/:companyId/tools/runtime-slots/:id/stop\|restart` | Process supervision. |
| Audit | `GET /api/tool-gateway/audit?companyId=…&limit=…`, `GET /api/companies/:companyId/tools/runs/:runId/decisions` | Call event log. |
| Stdio templates | `GET /api/companies/:companyId/tools/stdio-templates` | Approved local stdio template IDs only. |
| Bulk import preview | `POST /api/companies/:companyId/tools/mcp/import-json` | Inspect a discovery JSON without persisting anything. |
| Demo script | [MCP-DEMO-SCRIPT.md](./MCP-DEMO-SCRIPT.md) | Walks read / approval-gated write / denied flows end-to-end. |
| Runtime runbook | [MCP-RUNTIME-OPERATIONS.md](./MCP-RUNTIME-OPERATIONS.md) | Alerts, stuck slots, recovery. |
| Deployment modes | [DEPLOYMENT-MODES.md](./DEPLOYMENT-MODES.md) | Auth, exposure, bind. |
