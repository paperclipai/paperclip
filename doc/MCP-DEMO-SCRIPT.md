# MCP Access Governance Demo Script

This is the end-to-end demo for the MCP Access Governance launch. It walks the three required cases — **read**, **approval-gated write**, **denied/destructive** — against the real [`@paperclipai/kv-demo-mcp-server`](../packages/kv-demo-mcp-server/README.md) package. The server is a standalone Node process that exposes four key/value MCP tools and a tiny web UI over the same in-memory store, so you can call a tool from an agent and watch the value appear in a browser tab in real time.

Audience: CTO sign-off, QA repro, and the recorded walkthrough that goes with the release notes. Time to run live: about 10 minutes.

Pair this script with [MCP-ACCESS-GOVERNANCE.md](./MCP-ACCESS-GOVERNANCE.md) for concepts and the full reference, and the [package README](../packages/kv-demo-mcp-server/README.md) for the server itself.

## Prerequisites

Before you start the recording:

- Paperclip running in `local_trusted` or `authenticated/private` mode. Public mode is fine as long as the Paperclip process can reach `http://127.0.0.1:8848` (we connect over `remote_http`, so no trusted runtime worker is required).
- A company with at least one agent identity to act as the caller. That agent must have an **active heartbeat run** for the gateway-call steps (Steps 6, 7, 9, 11). The simplest way to keep one alive during recording is to assign a placeholder task to the agent before the demo starts; the agent's heartbeat run stays in `running` while it works.
- The KV demo server package built (`pnpm --filter @paperclipai/kv-demo-mcp-server build`).
- Board API key (`$BOARD_API_KEY`) exported. Company ID (`$COMPANY_ID`) exported. Agent ID (`$AGENT_ID`) for the caller exported.
- Paperclip URL (`$PAPERCLIP_URL`) exported.
- The Tools & Access UI open at `/<prefix>/companies/<companyId>/tools`.
- A browser tab open on the **Values UI** at `http://127.0.0.1:8848/` (you will open this in Step 1).

All API requests use `Authorization: Bearer $BOARD_API_KEY` for board calls. Gateway calls use a dedicated session token via the `X-Paperclip-Tool-Gateway-Token` header — they do not use `Authorization`. See Step 5 for how the token is minted.

## Step 0 — Frame the demo

Spoken intro:

> "Paperclip ships an MCP gateway that sits between every agent and every upstream tool. Three things happen on every call: we pick the tool against a profile, we evaluate policies, and we record an audit event. I'm going to connect a tiny key/value MCP server I'm running on this laptop, then run a read, a write that needs approval, and a destructive call that gets denied. The KV server has a web UI on the same port that shows its values — so when the agent's write lands, you'll see it appear in the browser. The data lives in the server; the policy decisions and the audit log live in Paperclip."

Show the Tools & Access overview tab. Point at:

- Applications count = 0
- Connections count = 0
- Slots = 0

## Step 1 — Start the KV demo server

In a side terminal, launch the server and leave it running for the rest of the demo:

```sh
pnpm --filter @paperclipai/kv-demo-mcp-server start
```

Expected stderr:

```
KV demo MCP server listening on http://127.0.0.1:8848
  MCP endpoint:  http://127.0.0.1:8848/mcp
  Values UI:     http://127.0.0.1:8848/
  JSON state:    http://127.0.0.1:8848/api/state
  Auth:          none (set KV_DEMO_TOKEN to require a shared secret).
```

Open `http://127.0.0.1:8848/` in a browser tab. The Values UI shows an empty table and "Revision 0". Drop this tab next to the Tools & Access UI so the camera sees both at once.

> The KV demo holds state in a single in-memory `Map` shared by the MCP tools and the Values UI. That is why we connect it over `remote_http` and not `local_stdio`: stdio would spawn one supervised child process per runtime slot, each with its own empty `Map`, and the UI would never see what the agent wrote. For the transport policy in production, see [MCP-ACCESS-GOVERNANCE.md → Local trusted deployment](./MCP-ACCESS-GOVERNANCE.md#local-trusted-deployment).

## Step 2 — Connect the KV server through the wizard

This is the user-facing path. Open **Apps → Connect an app → Connect with a link**, paste `http://127.0.0.1:8848/mcp`, name it "KV demo", and finish the wizard with **reads allowed, `kv_set` ask-first, `kv_delete` quarantined**. The wizard pings the server, imports the catalog, and quarantines `kv_delete` automatically because the MCP server tags it `destructiveHint: true`.

API equivalent for the recording (the wizard hits these two routes back-to-back):

```sh
CONNECT=$(curl -fsS -X POST \
  -H "Authorization: Bearer $BOARD_API_KEY" \
  -H "Content-Type: application/json" \
  "$PAPERCLIP_URL/api/companies/$COMPANY_ID/tools/apps/connect" \
  -d '{
    "link": "http://127.0.0.1:8848/mcp",
    "name": "KV demo"
  }')
echo "$CONNECT" | jq '{
  connectionId,
  applicationId: .application.id,
  catalogCount: (.catalog | length),
  readOnlyTools: [.actions.readOnly[].toolName],
  writeTools: [.actions.canMakeChanges[].toolName]
}'

export CONNECTION_ID=$(jq -r '.connectionId' <<<"$CONNECT")
export APPLICATION_ID=$(jq -r '.application.id' <<<"$CONNECT")
export READ_ENTRY_IDS=$(jq -c '[.catalog[] | select(.toolName=="kv_get" or .toolName=="kv_list") | .id]' <<<"$CONNECT")
export WRITE_ENTRY_ID=$(jq -r '.catalog[] | select(.toolName=="kv_set") | .id' <<<"$CONNECT")
```

Expected: four catalog entries (`kv_list`, `kv_get`, `kv_set`, `kv_delete`). On the UI Catalog view, `kv_delete` shows the **Quarantined** badge — point at it on the recording.

Finish the wizard (allow reads, ask-first on `kv_set`, leave `kv_delete` quarantined):

```sh
curl -fsS -X POST \
  -H "Authorization: Bearer $BOARD_API_KEY" \
  -H "Content-Type: application/json" \
  "$PAPERCLIP_URL/api/companies/$COMPANY_ID/tools/apps/$CONNECTION_ID/finish" \
  -d '{
    "enabledCatalogEntryIds": '"$READ_ENTRY_IDS"',
    "askFirstCatalogEntryIds": ["'"$WRITE_ENTRY_ID"'"],
    "access": "all_agents"
  }' | jq '{
    connectionStatus: .connection.status,
    profileId: .profile.id,
    profileBindings: (.profileBindings | length),
    askFirstPolicies: (.policies | length)
  }'

export PROFILE_ID=$(curl -fsS \
  -H "Authorization: Bearer $BOARD_API_KEY" \
  "$PAPERCLIP_URL/api/companies/$COMPANY_ID/tools/profiles/effective/agents/$AGENT_ID" \
  | jq -r '.profileIds[0]')
```

Expected: `connectionStatus: "active"`, one profile bound to the company, one `require_approval` policy generated for `kv_set`.

## Step 3 — Confirm the effective profile

```sh
curl -fsS \
  -H "Authorization: Bearer $BOARD_API_KEY" \
  "$PAPERCLIP_URL/api/companies/$COMPANY_ID/tools/profiles/effective/agents/$AGENT_ID" \
  | jq '{profileIds, allowedToolNames}'
```

Expected: `allowedToolNames` contains `kv_get`, `kv_list`, and `kv_set` (the wizard added the ask-first tool to the allow set; the policy is what gates it). `kv_delete` is absent because the catalog entry is quarantined.

## Step 4 — Mint a gateway session for the demo agent

Gateway sessions are scoped to an active heartbeat run. When a board key mints the session, the request body must carry `companyId`, `agentId`, and `runId`. The run must be in `running` status and must belong to the same agent and company.

Grab the most recent active run for the demo agent:

```sh
export RUN_ID=$(curl -fsS \
  -H "Authorization: Bearer $BOARD_API_KEY" \
  "$PAPERCLIP_URL/api/companies/$COMPANY_ID/heartbeat-runs?agentId=$AGENT_ID&limit=20" \
  | jq -r '[.[] | select(.status == "running")] | first | .id')

test -n "$RUN_ID" || { echo "No active run for agent — start one before recording"; exit 1; }
```

Mint the session:

```sh
SESSION=$(curl -fsS -X POST \
  -H "Authorization: Bearer $BOARD_API_KEY" \
  -H "Content-Type: application/json" \
  "$PAPERCLIP_URL/api/tool-gateway/sessions" \
  -d '{
    "companyId": "'"$COMPANY_ID"'",
    "agentId": "'"$AGENT_ID"'",
    "runId": "'"$RUN_ID"'"
  }')
echo "$SESSION" | jq '{sessionId, expiresAt, toolsUrl, callUrl}'
export GATEWAY_TOKEN=$(jq -r '.token' <<<"$SESSION")
```

In production, the agent obtains this token from its own run bootstrap (agent JWTs auto-populate `companyId`/`agentId`/`runId`). The board-keyed shortcut here is for the recording so the camera stays in one shell.

## Step 5 — The read tool (allowed)

Gateway calls use the session token via `X-Paperclip-Tool-Gateway-Token`. The body uses `tool` (string) and `parameters` (object).

```sh
curl -fsS -X POST \
  -H "X-Paperclip-Tool-Gateway-Token: $GATEWAY_TOKEN" \
  -H "Content-Type: application/json" \
  "$PAPERCLIP_URL/api/tool-gateway/tools/call" \
  -d '{ "tool": "kv_list", "parameters": {} }' \
  | jq '{invocationId, status, tool, result}'
```

Expected: `status: "completed"`, the empty `entries` array nested inside `result.content[0].text` (or the MCP tool result envelope you wired the agent up to parse), and a UUID `invocationId`. Latency is single-digit ms.

Switch to the **Audit** tab in the UI. Refresh. The newest row is `tool_gateway.call_completed` for `kv_list` with `decision: allow`. Point at it on the recording.

## Step 6 — The destructive tool (denied)

```sh
curl -i -X POST \
  -H "X-Paperclip-Tool-Gateway-Token: $GATEWAY_TOKEN" \
  -H "Content-Type: application/json" \
  "$PAPERCLIP_URL/api/tool-gateway/tools/call" \
  -d '{ "tool": "kv_delete", "parameters": { "key": "demo/launch" } }'
```

Expected: an HTTP `403` or `404` response with a JSON body shaped like:

```json
{
  "error": "<explanation from the policy decision>",
  "reasonCode": "quarantined_catalog_entry",
  "invocationId": "...",
  "tool": "kv_delete",
  "decision": "deny",
  "matchedPolicyIds": []
}
```

Either `quarantined_catalog_entry` (catalog quarantine, the path we set up in Step 2) or `deny_default` (profile excludes the tool) is the correct deny path. The agent does not get a stack trace — just the reason code. The audit log gets a `tool_gateway.call_denied` event with the same reason code. Refresh the audit tab.

Spoken note:

> "The agent doesn't know whether the tool was denied by the profile, by a policy, or by quarantine. It just knows the call failed and the reason code. The operator sees the full decision in the audit row. The KV server was never touched — the gateway short-circuited before the request left Paperclip."

## Step 7 — The agent call that triggers approval

`kv_set` is in the allow set but carries an ask-first `require_approval` policy from Step 2. The first call returns HTTP `409` with `reasonCode: "approval_required"` and an `actionRequestId` in the body. Use `-w` (or capture status separately) so the recording shows the 409 explicitly:

```sh
CALL=$(curl -sS -w '\n%{http_code}' -X POST \
  -H "X-Paperclip-Tool-Gateway-Token: $GATEWAY_TOKEN" \
  -H "Content-Type: application/json" \
  "$PAPERCLIP_URL/api/tool-gateway/tools/call" \
  -d '{ "tool": "kv_set", "parameters": { "key": "demo/launch", "value": "shipped" } }')

STATUS=$(echo "$CALL" | tail -1)
BODY=$(echo "$CALL" | sed '$d')
echo "HTTP $STATUS"
echo "$BODY" | jq '{error, reasonCode, invocationId, actionRequestId, interactionId, tool, argumentsHash}'
export ACTION_REQUEST_ID=$(jq -r '.actionRequestId' <<<"$BODY")
```

Expected: `HTTP 409`, `reasonCode: "approval_required"`, an `actionRequestId`, an `argumentsHash` (canonical hash of the reviewed arguments), and an `interactionId` for the linked issue-thread interaction. The agent's run is paused on this exact tool call until a decision lands.

In the UI, switch to the **Audit** tab and find the approval card. Point at the signed arguments (`{"key":"demo/launch","value":"shipped"}`), the requesting agent, the run, and the expiry. Glance at the Values UI tab — still empty. Nothing reached the KV server yet because approval has not landed.

## Step 8 — Approve the action

Approve via the API for the recording (the UI button does the same thing). The approval endpoint requires `companyId` (in the body or as a query parameter):

```sh
curl -fsS -X POST \
  -H "Authorization: Bearer $BOARD_API_KEY" \
  -H "Content-Type: application/json" \
  "$PAPERCLIP_URL/api/tool-gateway/action-requests/$ACTION_REQUEST_ID/approve" \
  -d '{ "companyId": "'"$COMPANY_ID"'" }' \
  | jq '{id, status, resolvedAt, resolvedByUserId, canonicalArgumentsHash}'
```

Expected: `status: "approved"` and `resolvedAt` set. The agent call has not run yet — approval marks the action request ready to be consumed. The Values UI is still empty.

## Step 9 — Retry the call with the approved action request

The agent retries the same call with `approvedActionRequestId` set to the action request it received in Step 7. The gateway re-validates that the canonical arguments hash matches what was approved, then executes the tool against the live KV server.

```sh
curl -fsS -X POST \
  -H "X-Paperclip-Tool-Gateway-Token: $GATEWAY_TOKEN" \
  -H "Content-Type: application/json" \
  "$PAPERCLIP_URL/api/tool-gateway/tools/call" \
  -d '{
    "tool": "kv_set",
    "parameters": { "key": "demo/launch", "value": "shipped" },
    "approvedActionRequestId": "'"$ACTION_REQUEST_ID"'"
  }' \
  | jq '{invocationId, status, tool, result}'
```

Expected: `status: "completed"`. Within two seconds, the Values UI table shows a new row `demo/launch = shipped`, revision incremented. Point the camera at the Values UI. The audit log gets a `tool_gateway.call_allowed` event followed by a `tool_gateway.call_completed` event, both linked to the same `actionRequestId`.

If you change the `parameters` between Step 7 and Step 9, the retry fails with `reasonCode: "signed_arguments_mismatch"` — the approval is for the exact reviewed arguments, not the next call shape.

## Step 10 — Confirm the read sees the new value (round trip)

Replay the read to close the loop — the agent's view of the world now matches the operator's:

```sh
curl -fsS -X POST \
  -H "X-Paperclip-Tool-Gateway-Token: $GATEWAY_TOKEN" \
  -H "Content-Type: application/json" \
  "$PAPERCLIP_URL/api/tool-gateway/tools/call" \
  -d '{ "tool": "kv_get", "parameters": { "key": "demo/launch" } }' \
  | jq '{invocationId, status, tool, result}'
```

Expected: `status: "completed"`, `result` content shows `{ "found": true, "key": "demo/launch", "value": "shipped", "updatedAt": "…" }`. One more `tool_gateway.call_completed` row lands in the audit feed with `decision: allow`.

## Step 11 — Promote the approval to a trust rule (optional)

Skip this on a 5-minute recording. Include it for the 10-minute version because it shows the operator-side automation story.

```sh
curl -fsS -X POST \
  -H "Authorization: Bearer $BOARD_API_KEY" \
  -H "Content-Type: application/json" \
  "$PAPERCLIP_URL/api/companies/$COMPANY_ID/tools/action-requests/$ACTION_REQUEST_ID/trust-rule" \
  -d '{
    "name": "Trust kv_set demo/launch from the demo agent",
    "approvalThreshold": 2,
    "scope": { "includeAgent": true, "includeTool": true },
    "argumentFilters": { "exactHash": null, "allowAny": false, "fieldEquals": { "key": "demo/launch" } },
    "expiresAt": "2026-09-01T00:00:00.000Z"
  }' \
  | jq '{id, policyType, priority, config: {trustRule: .config.trustRule}}'
```

Trust rules are policies of type `trust_rule`. They derive from a specific approved action request and stop applying when the upstream tool's schema hash changes — covered in [MCP-ACCESS-GOVERNANCE.md#approval-flow-and-trust-rules](./MCP-ACCESS-GOVERNANCE.md#approval-flow-and-trust-rules).

Spoken note:

> "A trust rule converts a one-time approval into a steady-state allow scoped to the same actor and the same argument shape. If the upstream tool changes its schema, the trust rule stops matching and we go back to approval. That's intentional — an approval is for a specific argument shape, not for the next version of the tool."

## Step 12 — Audit summary

Pull the audit timeline for the demo:

```sh
curl -fsS \
  -H "Authorization: Bearer $BOARD_API_KEY" \
  "$PAPERCLIP_URL/api/tool-gateway/audit?companyId=$COMPANY_ID&limit=20" \
  | jq '[.[] | {createdAt, action, tool: .details.tool, decision: .details.decision, reasonCode: .details.reasonCode}]'
```

Expected rows, newest first:

1. `tool_gateway.call_completed` — `kv_get`, `allow` (Step 10 round-trip read)
2. `tool_gateway.call_completed` — `kv_set`, `allow` (Step 9 retry)
3. `tool_gateway.call_allowed` — `kv_set`, `approved` (Step 9 entry into execution)
4. `tool_gateway.approval_requested` — `kv_set`, `require_approval` (Step 7 approval card)
5. `tool_gateway.call_denied` — `kv_delete`, `deny`, with `reasonCode` of `quarantined_catalog_entry` or `deny_default` (Step 6)
6. `tool_gateway.call_completed` — `kv_list`, `allow` (Step 5)

Close on the audit tab next to the Values UI. Three required cases visible in a single screen: a read that landed, a write that took an approval round-trip and you can see the resulting value in the browser, and a destructive call that was denied with a reason. End of recording.

## Cleanup

The KV demo is intentionally disposable. There are two layers of state to clean up.

### Demo state (the values themselves)

The KV server keeps state in process memory. Restart the server to drop everything:

```sh
# In the side terminal running the KV server, press Ctrl+C, then start it again.
pnpm --filter @paperclipai/kv-demo-mcp-server start
```

The next `kv_list` call returns an empty `entries` array. The Values UI shows the empty table again. Paperclip's audit history is untouched — it still records that the calls happened, just against a server that has since reset.

If the port is still bound after `Ctrl+C` (the process is gone but TCP timewait is pending), find any leftover process and stop it:

```sh
lsof -nP -iTCP:8848 -sTCP:LISTEN
kill <pid>
```

### Paperclip-side cleanup (for a fully clean state)

Run these if you want the connection and application out of the way as well. Skip them if you plan to keep the demo around for repeat recordings; the smoke replay still works as long as the KV server is running.

```sh
# Revoke the trust rule (if you created one in Step 11)
curl -fsS -X POST -H "Authorization: Bearer $BOARD_API_KEY" -H "Content-Type: application/json" \
  "$PAPERCLIP_URL/api/companies/$COMPANY_ID/tools/trust-rules/$TRUST_RULE_POLICY_ID/revoke" \
  -d '{ "reason": "Demo cleanup." }' | jq '{id, enabled}'

# Disable the connection
curl -fsS -X PATCH -H "Authorization: Bearer $BOARD_API_KEY" -H "Content-Type: application/json" \
  "$PAPERCLIP_URL/api/tool-connections/$CONNECTION_ID" \
  -d '{ "enabled": false, "status": "disabled" }' | jq '{id, enabled, status}'

# Archive the application
curl -fsS -X PATCH -H "Authorization: Bearer $BOARD_API_KEY" -H "Content-Type: application/json" \
  "$PAPERCLIP_URL/api/tool-applications/$APPLICATION_ID" \
  -d '{ "status": "archived" }' | jq '{id, status}'
```

Audit history is retained; the connection and application stay archived for the record.

## What this proves

- **Read** path: the read-only catalog entries, the wizard-built profile, and the gateway audit row line up. Gateway-token header, `tool`/`parameters` body, `status: "completed"` on success.
- **Approval-gated write** path: profile inclusion + `require_approval` policy + HTTP `409` `approval_required` carrying `actionRequestId` + board-key approval scoped to `companyId` + retry with `approvedActionRequestId` + audit closure + a visible state change in the Values UI. Trust rule promotion (Step 11) bridges the human-in-the-loop step to a steady-state allow without losing the audit trail.
- **Denied / destructive** path: catalog quarantine on first sight (driven by `destructiveHint: true` on the MCP tool annotation), and a clean deny HTTP response with `reasonCode` at the gateway. The agent sees a failed call; the operator sees the reason in the audit row; the KV server never sees the request at all.

## What lives where

The demo is also the clearest way to show the data boundary between Paperclip and the upstream MCP server.

| Concern | Stored in the KV demo server | Stored in Paperclip |
| --- | --- | --- |
| Key/value entries | In-memory `Map`, lost on restart. | Not stored. The gateway only sees the MCP request/response envelope. |
| Connection record (URL, optional token) | Not stored. | Persisted in `tool_connections`. The optional `KV_DEMO_TOKEN` becomes a secret. |
| Profile / policy / binding decisions | Not stored. | Persisted under `tool_profiles`, `tool_policies`, `tool_profile_bindings`. |
| Approval action requests | Not stored. | Persisted under `tool_action_requests`, linked to issue-thread interactions. |
| Audit rows per call | Not stored. | Persisted under `tool_call_events`. Append-only. |

This is the contract the launch ships. If a future change loosens any of these — silent allow on a destructive tool, an approval that doesn't audit, a denied call without a reason code, or a retry that ignores the canonical-arguments hash — the demo will fail and so will QA.
