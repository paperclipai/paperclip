# MCP Runtime Operations

This runbook covers Paperclip Tools & Access runtime slots for MCP connections. It is written for board and CloudOps operators responding to stuck local stdio slots, degraded remote HTTP connections, capacity deferrals, restart storms, and secret-resolution failures.

Do not print raw bearer tokens, gateway session tokens, credential headers, environment variables, or secret values while following this runbook. The APIs below return redacted state and audit metadata; keep shell tracing disabled when exporting credentials.

## Support Matrix

| Transport | Local trusted | Hosted cloud / public authenticated | Notes |
| --- | --- | --- | --- |
| `remote_http` | Supported | Supported | Preferred production path. Paperclip proxies calls through the gateway with policy, audit, timeout, and redaction controls. |
| `local_stdio` | Supported through approved templates and supervised runtime slots | Supported only when an explicitly trusted MCP runtime worker/host is configured | Set `PAPERCLIP_TRUSTED_MCP_RUNTIME_HOST` or `PAPERCLIP_TOOL_RUNTIME_TRUSTED_HOST` only for a worker that is allowed to supervise local processes. Do not enable arbitrary agent-supplied commands. |

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
- Audit write failures: listed as `not_instrumented` until a durable audit-write-failure counter lands.

## Alerts

| Alert | Severity | Suggested threshold | First responder action |
| --- | --- | --- | --- |
| `mcp_runtime_stuck_starting_slot` | Critical | Any starting slot older than 5 minutes | Inspect slot health/logs, stop the slot, restart it once, then disable the connection if it sticks again. |
| `mcp_runtime_stuck_running_slot` | Critical | Any running slot with no progress for 5 minutes | Inspect recent audit events and active calls; restart only after confirming no healthy call is still in progress. |
| `mcp_runtime_high_timeout_rate` | Warning/Critical | Warning at >=3 timeouts and >=10% in 1 hour; critical at >=10 timeouts or >=25% | Check upstream MCP health, runtime capacity, and gateway audit failures before retrying workloads. |
| `mcp_runtime_high_error_rate` | Warning/Critical | Warning at >=5 failures and >=10% in 1 hour; critical at >=10 failures or >=25% | Group audit failures by `reasonCode`, then fix credentials/config or disable the affected connection. |
| `mcp_runtime_capacity_deferrals_repeated` | Warning/Critical | Warning at >=3 capacity deferrals in 1 hour; critical at >=10 | Stop idle/stale slots, reduce noisy workloads, or raise slot caps only after confirming host capacity. |
| `mcp_runtime_restart_storm` | Warning/Critical | Warning at >=3 restarts in 1 hour; critical on any restart suppression | Stop the slot, inspect stderr/audit reason codes, and keep the connection disabled until the template/upstream is fixed. |
| `mcp_runtime_connection_health_degraded` | Warning/Critical | Any degraded/failed/missing-secret connection or disabled enabled-path connection | Run health check, refresh catalog after recovery, or keep the connection disabled and route agents to alternatives. |
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
  "$PAPERCLIP_URL/api/tool-gateway/runtime-slots/$SLOT_ID/stop" \
  -d "{\"companyId\":\"$COMPANY_ID\"}" | jq .
```

Restart once when the template/config is expected to recover:

```sh
curl -fsS -X POST \
  -H "Authorization: Bearer $BOARD_API_KEY" \
  -H "Content-Type: application/json" \
  "$PAPERCLIP_URL/api/tool-gateway/runtime-slots/$SLOT_ID/restart" \
  -d "{\"companyId\":\"$COMPANY_ID\"}" | jq .
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

## Verification Coverage

Automated coverage includes:

- A synthetic degraded runtime-health scenario in `server/src/__tests__/tool-access-service.test.ts` that creates a stale running slot, degraded connection, timeout event, capacity deferral, and restart suppression.
- A gateway runtime recovery scenario in `server/src/__tests__/tool-gateway.test.ts` that recovers a stuck local stdio slot before reuse.

Known gap: audit write failures are recommended as a production alert but do not yet have a durable failure counter. Until that lands, treat database write errors around tool access audit paths as a control-plane incident.
