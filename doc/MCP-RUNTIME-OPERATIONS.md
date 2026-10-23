# MCP Runtime Operations

This runbook covers Paperclip Tools & Access runtime slots for MCP connections. It is written for board and CloudOps operators responding to stuck local stdio slots, degraded remote HTTP connections, capacity deferrals, restart storms, and secret-resolution failures.

Do not print raw bearer tokens, gateway session tokens, credential headers, environment variables, or secret values while following this runbook. The APIs below return redacted state and audit metadata; keep shell tracing disabled when exporting credentials.

Tool action approvals and sensitive request identities use a durable key independent from auth/JWT secrets. `PAPERCLIP_TOOL_ACTION_SIGNING_SECRET` takes precedence when configured. `paperclipai onboard` generates it for local instances, and worktree setup propagates or generates an independent value in the worktree `.env`. When unset, the server derives a separate key from the persisted secrets master key, using its configured environment value or durable key file. Processes serving the same instance must share that signing key or master key, and operators must back it up with the database. Rotation can invalidate outstanding approvals and retry matching; drain or reject pending approvals and reconcile completed writes before rotating.

## Support Matrix

| Transport | Local trusted | Hosted cloud / public authenticated | Notes |
| --- | --- | --- | --- |
| `remote_http` | Supported | Supported | Preferred production path. Paperclip proxies calls through the gateway with policy, audit, timeout, and redaction controls. |
| `local_stdio` | Supported through approved templates and supervised runtime slots | Supported only when an explicitly trusted MCP runtime worker/host is configured | Set `PAPERCLIP_TRUSTED_MCP_RUNTIME_HOST` or `PAPERCLIP_TOOL_RUNTIME_TRUSTED_HOST` only for a worker that is allowed to supervise local processes. Do not enable arbitrary agent-supplied commands. |

## Outbound HTTP proxy for remote requests

Paperclip can use an HTTP proxy for guarded remote HTTP and HTTPS requests.

For HTTP endpoints, configure `HTTP_PROXY` or `http_proxy`. For HTTPS endpoints, configure `HTTPS_PROXY` or `https_proxy`. The transport prefers the matching variable and can fall back to the other variable.

The current transport requires an `http://` proxy URL. The proxy host must be an IP address that Paperclip can reach.

Example:

```sh
HTTP_PROXY=http://192.0.2.10:8080
HTTPS_PROXY=http://192.0.2.10:8080
NO_PROXY=localhost,127.0.0.1,.example.internal
```

Replace the example address and port with your proxy address and port.

For HTTPS endpoints, Paperclip sends CONNECT to the destination IP approved by the endpoint guard. It keeps the original hostname for TLS SNI and certificate verification.

The endpoint guard still resolves and validates the destination hostname before the request. Proxy settings do not provide DNS resolution. The system resolver must resolve the destination hostname.

`NO_PROXY` and `no_proxy` bypass the proxy for matching hostnames. The transport then connects directly to the approved destination IP. Use exclusions only when direct network access is allowed.

Do not disable endpoint validation or TLS verification to work around proxy or DNS failures.

## Native runtime gateway ownership

Paperclip Runner creates an immutable MCP assignment for one agent. Its gateway
stores the owner in `agentId` and the agent context scope. Authentication checks
that the run belongs to that owner and that the gateway and profile metadata
refer to the same assignment. Invalid ownership or assignment metadata rejects
the token with `gateway_token_run_context_invalid`.

The reserved `native:` profile key also identifies a native assignment if its
gateway metadata is cleared. Clearing metadata cannot turn the assignment into
a shared gateway. Invalid JSON metadata, including JSON `null`, returns the same
authentication rejection. Use an ordinary profile for an explicit shared gateway.

Older native gateways can have a null `agentId`. Authentication still checks
their metadata owner. When the owner reuses the assignment, Paperclip validates
the gateway and profile before it binds the gateway to that agent. A conflicting
owner is never overwritten.

Native assignments enter the run configuration once through the runtime MCP
delivery path. Managed gateway discovery excludes historical native assignments.
Their stored rows remain available for existing runs. Explicit company gateways
continue to use their configured scopes.

## Client-side tool-call deadline

The gateway bounds each provider call, but the agent's MCP client also needs a
bound. Without one, a gateway request that never answers holds the agent turn
until the adapter execution timeout ends the run. Claude's default MCP tool
timeout is far longer than a run, and ACP `mcpServers` entries have no
per-server timeout field. So when an ACP Claude run receives runtime MCP
servers, the ACPX engine sets `MCP_TOOL_TIMEOUT` to 15 minutes. A call that
passes this deadline returns an MCP error to the model, and the turn
continues. An `MCP_TOOL_TIMEOUT` value in the adapter `env` configuration
takes priority.

## Metrics

The board runtime health API summarizes one-hour event windows plus current durable slot state:

```sh
curl -fsS \
  -H "Authorization: Bearer $BOARD_API_KEY" \
  "$PAPERCLIP_URL/api/companies/$COMPANY_ID/tools/runtime-health" | jq .
```

Metrics surfaced there include:

- Current slot counts: active, starting, running, idle, failed, stopped.
- Stuck slot counts: starting/running slots without progress for 5 minutes.
- Runtime events: capacity deferrals, restart attempts, restart suppression, idle evictions.
- Tool-call health: call count, timeout count/rate, failure count/rate, average latency, p95 latency.
- Connection health: active, disabled, degraded, `remote_http`, and `local_stdio` connection counts.
- Secret failures: missing-secret failures in the last hour.
- Audit write failures: durable `audit_write_failed` counter increments whenever MCP audit-event persistence fails.

## Alerts

| Alert | Severity | Suggested threshold | First responder action |
| --- | --- | --- | --- |
| `mcp_runtime_stuck_starting_slot` | Critical | Any starting slot older than 5 minutes | Inspect slot health/logs, stop the slot, restart it once, then disable the connection if it sticks again. |
| `mcp_runtime_stuck_running_slot` | Critical | Any running slot with no progress for 5 minutes | Inspect recent audit events and active calls; restart only after confirming no healthy call is still in progress. |
| `mcp_runtime_high_timeout_rate` | Warning/Critical | Warning at >=3 timeouts and >=10% in 1 hour; critical at >=10 timeouts or >=25% | Check upstream MCP health, runtime capacity, and gateway audit failures before retrying workloads. |
| `mcp_runtime_high_error_rate` | Warning/Critical | Warning at >=5 failures and >=10% in 1 hour; critical at >=10 failures or >=25% | Group audit failures by `reasonCode`, then fix credentials/config or disable the affected connection. |
| `mcp_runtime_capacity_deferrals_repeated` | Warning/Critical | Warning at >=3 capacity deferrals in 1 hour; critical at >=10 | Stop idle/stale slots, reduce noisy workloads, or raise slot caps only after confirming host capacity. |
| `mcp_runtime_restart_storm` | Warning/Critical | Warning at >=3 restarts in 1 hour; critical on any restart suppression | Stop the slot, inspect stderr/audit reason codes, and keep the connection disabled until the template/upstream is fixed. |
| `mcp_runtime_connection_health_degraded` | Warning/Critical | Any active enabled connection with degraded/failed/missing-secret health, or any disabled enabled-path connection | Run health check, refresh catalog after recovery, or keep the connection disabled and route agents to alternatives. |
| `mcp_runtime_missing_secret_failures` | Warning/Critical | Warning on any missing-secret failure; critical at >=3 in 1 hour | Check secret bindings and provider health without revealing secret values; rotate or rebind missing secrets. |
| `mcp_runtime_audit_write_failures` | Critical | Any audit write failure | Treat as a control-plane incident; restore DB/audit durability before retrying tool workloads. |

## Diagnose A Stuck Slot

1. Read the health summary and note firing alert names:

   ```sh
   curl -fsS \
     -H "Authorization: Bearer $BOARD_API_KEY" \
     "$PAPERCLIP_URL/api/companies/$COMPANY_ID/tools/runtime-health" | jq '{status, metrics, alerts}'
   ```

2. List durable runtime slots:

   ```sh
   curl -fsS \
     -H "Authorization: Bearer $BOARD_API_KEY" \
     "$PAPERCLIP_URL/api/companies/$COMPANY_ID/tools/runtime-slots" | jq .
   ```

3. Inspect recent gateway audit events without printing secrets:

   ```sh
   curl -fsS \
     -H "Authorization: Bearer $BOARD_API_KEY" \
     "$PAPERCLIP_URL/api/tool-gateway/audit?companyId=$COMPANY_ID&limit=100" \
     | jq '[.[] | {createdAt, action, entityType, entityId, reasonCode: .details.reasonCode, tool: .details.tool, durationMs: .details.durationMs}]'
   ```

4. Identify the affected `slotId`, `connectionId`, `reasonCode`, and whether the slot is `starting`, `running`, `idle`, `failed`, or `stopped`.

## Clear A Stuck Slot

Stop the slot first when it is stale, idle, failed, or confirmed not to be serving a healthy active call:

```sh
curl -fsS -X POST \
  -H "Authorization: Bearer $BOARD_API_KEY" \
  -H "Content-Type: application/json" \
  "$PAPERCLIP_URL/api/companies/$COMPANY_ID/tools/runtime-slots/$SLOT_ID/stop" \
  -d '{}' | jq .
```

Restart once when the template/config is expected to recover:

```sh
curl -fsS -X POST \
  -H "Authorization: Bearer $BOARD_API_KEY" \
  -H "Content-Type: application/json" \
  "$PAPERCLIP_URL/api/companies/$COMPANY_ID/tools/runtime-slots/$SLOT_ID/restart" \
  -d '{}' | jq .
```

If restart suppression fires, do not keep retrying. Disable the connection:

```sh
curl -fsS -X PATCH \
  -H "Authorization: Bearer $BOARD_API_KEY" \
  -H "Content-Type: application/json" \
  "$PAPERCLIP_URL/api/tool-connections/$CONNECTION_ID" \
  -d '{"enabled":false,"status":"disabled"}' | jq '{id, name, enabled, status, healthStatus}'
```

## Verify Recovery

An individual remote MCP tool-call failure stays on its invocation. A network
failure, timeout, non-authentication HTTP error, or JSON-RPC error does not change
the connection's shared health or hide its other tools. HTTP 401/403 responses,
missing credentials, and explicit insufficient-scope errors retain their access
gates. Health checks and catalog refreshes still assess connection health.

After a network failure or timeout, the next explicit call can start a fresh MCP
session. The gateway never automatically replays the failed action: the provider
may already have performed it. Check the outcome before retrying a write. If a
connection was already marked unhealthy before upgrading, use the health check
below to restore access after verifying the endpoint.

1. Run the connection health check:

   ```sh
   curl -fsS -X POST \
     -H "Authorization: Bearer $BOARD_API_KEY" \
     -H "Content-Type: application/json" \
     "$PAPERCLIP_URL/api/tool-connections/$CONNECTION_ID/health-check" \
     -d '{}' | jq '{connection: {id: .connection.id, healthStatus: .connection.healthStatus, healthMessage: .connection.healthMessage}, runtimeSlot}'
   ```

2. Refresh the catalog after a remote endpoint or stdio template recovers:

   ```sh
   curl -fsS -X POST \
     -H "Authorization: Bearer $BOARD_API_KEY" \
     -H "Content-Type: application/json" \
     "$PAPERCLIP_URL/api/tool-connections/$CONNECTION_ID/catalog/refresh" \
     -d '{}' | jq '{discoveredCount, quarantinedCount}'
   ```

3. Re-read runtime health:

   ```sh
   curl -fsS \
     -H "Authorization: Bearer $BOARD_API_KEY" \
     "$PAPERCLIP_URL/api/companies/$COMPANY_ID/tools/runtime-health" | jq '{status, metrics, alerts}'
   ```

Recovery is complete when stuck-slot alerts clear, timeout/error rates return below threshold, the connection is healthy or intentionally disabled, and audit events show no new restart suppression or capacity deferrals.

### Catalog publication

Discovery keeps the last descriptor when pages repeat a tool name. Catalog rows
are written in transactions of at most 500 tools. Refresh preserves existing row
IDs, first-seen timestamps, operator-disabled actions, and unchanged pending
reviews. Publication locks the application before the connection, as setup
finalization and removal do. Provider discovery runs before these locks.

Each completed chunk remains committed if a later chunk fails. Default-profile
synchronization runs in a separate transaction after catalog publication. A
failure there rolls back the profile changes without removing discovered tools.
Retry the catalog refresh after correcting the failure.

## Verification Coverage

Automated coverage includes:

- A synthetic degraded runtime-health scenario in `server/src/__tests__/tool-access-service.test.ts` that creates a stale running slot, degraded connection, timeout event, capacity deferral, and restart suppression.
- A durable audit-write failure scenario in `server/src/__tests__/tool-access-service.test.ts` that verifies `mcp_runtime_audit_write_failures` fires from the counter path.
- A gateway runtime recovery scenario in `server/src/__tests__/tool-gateway.test.ts` that recovers a stuck local stdio slot before reuse.
- PostgreSQL catalog publication tests in `server/src/__tests__/tool-catalog-publication.test.ts` cover 250 and 2,500 tools, overlapping pages, preserved choices, partial failure, and publication lock contention.
