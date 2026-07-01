# MCP Access Governance Demo Script

This is the end-to-end demo for the MCP Access Governance launch. It walks the three required cases — **read**, **approval-gated write**, **denied/destructive** — against the bundled `paperclip.synthetic-todo-kv` fixture. The fixture ships in the Paperclip build; no upstream MCP server is required.

Audience: CTO sign-off, QA repro, and the recorded walkthrough that goes with the release notes. Time to run live: about 10 minutes.

Pair this script with [MCP-ACCESS-GOVERNANCE.md](./MCP-ACCESS-GOVERNANCE.md) for concepts and the full reference.

## Prerequisites

Before you start the recording:

- Paperclip running in `local_trusted` or `authenticated/private` mode. Public mode is fine for the demo as long as a trusted runtime host is configured (see [MCP-ACCESS-GOVERNANCE.md#local-trusted-deployment](./MCP-ACCESS-GOVERNANCE.md#local-trusted-deployment)).
- A company with at least one agent identity to act as the caller. That agent must have an **active heartbeat run** for the gateway-call steps (Steps 5, 6, 8, 10). The simplest way to keep one alive during recording is to assign a placeholder task to the agent before the demo starts; the agent's heartbeat run stays in `running` while it works.
- Board API key (`$BOARD_API_KEY`) exported. Company ID (`$COMPANY_ID`) exported. Agent ID (`$AGENT_ID`) for the caller exported.
- Paperclip URL (`$PAPERCLIP_URL`) exported.
- The Tools & Access UI open at `/<prefix>/companies/<companyId>/tools`.

All API requests use `Authorization: Bearer $BOARD_API_KEY` for board calls. Gateway calls use a dedicated session token via the `X-Paperclip-Tool-Gateway-Token` header — they do not use `Authorization`. See Step 4 for how the token is minted.

## Step 0 — Frame the demo

Spoken intro:

> "Paperclip ships with an MCP gateway that sits between every agent and every upstream tool. Three things happen on every call: we pick the tool against a profile, we evaluate policies, and we record an audit event. I'm going to run a read, then a write that needs approval, then a destructive call that gets denied. Everything you see is the bundled fixture — no upstream server is involved, so any failure is on us."

Show the Tools & Access overview tab. Point at:
- Applications count = 0
- Connections count = 0
- Slots = 0

## Step 1 — Install the example

Switch to the **Examples** tab. Click **Install** on *Safe read-only Todo / KV fixture*. The UI shows the application, connection, and profile being created.

API equivalent for the recording:

```sh
INSTALL=$(curl -fsS -X POST \
  -H "Authorization: Bearer $BOARD_API_KEY" \
  -H "Content-Type: application/json" \
  "$PAPERCLIP_URL/api/companies/$COMPANY_ID/tools/examples/safe-read-only-todo-kv/install" \
  -d '{}')
echo "$INSTALL" | jq '{applicationId: .application.id, connectionId: .connection.id, profileId: .profile.id, catalogCount: (.catalog | length)}'

export APPLICATION_ID=$(jq -r '.application.id' <<<"$INSTALL")
export CONNECTION_ID=$(jq -r '.connection.id' <<<"$INSTALL")
export PROFILE_ID=$(jq -r '.profile.id' <<<"$INSTALL")
```

Quick check on the UI Catalog view: the bundled tools are listed, with destructive entries flagged and quarantined. Point at the quarantine badge.

## Step 2 — Run the bundled smoke

Before any agent call, prove the install is healthy. The smoke endpoint runs a read decision and a deny decision through the policy engine and writes audit events, all under the board key.

```sh
curl -fsS -X POST \
  -H "Authorization: Bearer $BOARD_API_KEY" \
  -H "Content-Type: application/json" \
  "$PAPERCLIP_URL/api/companies/$COMPANY_ID/tools/examples/safe-read-only-todo-kv/smoke" \
  -d '{}' \
  | jq '{ok, checks: [.checks[] | {name, ok, decision, reasonCode}]}'
```

Expected: `ok: true` with three green checks: `allow_read_tool`, `deny_write_tool`, `audit_written`. If any check is false, fix it before recording the rest — the gateway path won't work either.

## Step 3 — Bind the read-only profile to your demo agent

The example installs a profile that allows only the read-only tools. The installer also binds the profile to the company by default. To make the demo's effective profile unambiguous, bind it explicitly to the demo agent:

```sh
curl -fsS -X POST \
  -H "Authorization: Bearer $BOARD_API_KEY" \
  -H "Content-Type: application/json" \
  "$PAPERCLIP_URL/api/companies/$COMPANY_ID/tools/profiles/$PROFILE_ID/bind" \
  -d '{ "targetType": "agent", "targetId": "'"$AGENT_ID"'", "priority": 10 }' | jq '{id, profileId, targetType, targetId, priority}'

curl -fsS \
  -H "Authorization: Bearer $BOARD_API_KEY" \
  "$PAPERCLIP_URL/api/companies/$COMPANY_ID/tools/profiles/effective/agents/$AGENT_ID" \
  | jq '{profileIds, allowedToolNames}'
```

Expected: `allowedToolNames` contains the safe read-only tools (`list_items`, `get_value`), and nothing else.

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
  -d '{ "tool": "list_items", "parameters": {} }' \
  | jq '{invocationId, status, tool, result}'
```

Expected: `status: "completed"`, the synthetic result in `result`, and a UUID `invocationId`. Latency is single-digit ms.

Switch to the **Audit** tab in the UI. Refresh. The newest row is `tool_gateway.call_completed` for `list_items` with `decision: allow`. Point at it on the recording.

## Step 6 — The destructive tool (denied)

```sh
curl -i -X POST \
  -H "X-Paperclip-Tool-Gateway-Token: $GATEWAY_TOKEN" \
  -H "Content-Type: application/json" \
  "$PAPERCLIP_URL/api/tool-gateway/tools/call" \
  -d '{ "tool": "delete_item", "parameters": { "id": "fake" } }'
```

Expected: an HTTP `403` response with a JSON body shaped like:

```json
{
  "error": "<explanation from the policy decision>",
  "reasonCode": "quarantined_catalog_entry",
  "invocationId": "...",
  "tool": "delete_item",
  "decision": "deny",
  "matchedPolicyIds": []
}
```

Either `quarantined_catalog_entry` (catalog quarantine on first sight) or `deny_default` (read-only profile excludes the tool) is the correct deny path. The agent does not get a stack trace — just the reason code. The audit log gets a `tool_gateway.call_denied` event with the same reason code. Refresh the audit tab.

Spoken note:

> "The agent doesn't know whether the tool was denied by the profile, by a policy, or by quarantine. It just knows the call failed and the reason code. The operator sees the full decision in the audit row."

## Step 7 — Set up the approval-gated write tool

We are going to allow `create_item`, but require human approval for it. Two steps: extend the profile to include `create_item`, then add a `require_approval` policy targeting that tool.

Add `create_item` to the profile:

```sh
curl -fsS -X POST \
  -H "Authorization: Bearer $BOARD_API_KEY" \
  -H "Content-Type: application/json" \
  "$PAPERCLIP_URL/api/tool-profiles/$PROFILE_ID/entries" \
  -d '{ "selectorType": "tool_name", "toolName": "create_item", "effect": "include" }' \
  | jq '{id, selectorType, toolName, effect}'
```

Add a `require_approval` policy:

```sh
curl -fsS -X POST \
  -H "Authorization: Bearer $BOARD_API_KEY" \
  -H "Content-Type: application/json" \
  "$PAPERCLIP_URL/api/companies/$COMPANY_ID/tools/policies" \
  -d '{
    "name": "Approve every create_item",
    "policyType": "require_approval",
    "priority": 100,
    "enabled": true,
    "selectors": { "toolNames": ["create_item"] },
    "config": { "approvalReason": "Demo: create_item requires approval." }
  }' | jq '{id, policyType, enabled, priority}'
```

Dry-run the policy decision against the engine so the camera sees `require_approval` before any real call. The dry-run uses a structured `{ companyId, actor, request, runContext? }` body and returns the decision under `.decision`:

```sh
curl -fsS -X POST \
  -H "Authorization: Bearer $BOARD_API_KEY" \
  -H "Content-Type: application/json" \
  "$PAPERCLIP_URL/api/companies/$COMPANY_ID/tools/policy/test" \
  -d '{
    "companyId": "'"$COMPANY_ID"'",
    "actor": {
      "actorType": "agent",
      "actorId": "'"$AGENT_ID"'",
      "agentId": "'"$AGENT_ID"'"
    },
    "runContext": {
      "heartbeatRunId": "'"$RUN_ID"'"
    },
    "request": {
      "toolName": "create_item",
      "arguments": { "title": "Demo item" }
    }
  }' \
  | jq '{decision: .decision.decision, matchedPolicyIds: .decision.matchedPolicyIds, reasonCode: .decision.reasonCode}'
```

Expected: `decision: "require_approval"`, `matchedPolicyIds` includes the policy you just created.

## Step 8 — The agent call that triggers approval

A real gateway call now returns HTTP `409` with `reasonCode: "approval_required"` and an `actionRequestId` in the body. Use `-i` (or capture status separately) so the recording shows the 409 explicitly:

```sh
CALL=$(curl -sS -w '\n%{http_code}' -X POST \
  -H "X-Paperclip-Tool-Gateway-Token: $GATEWAY_TOKEN" \
  -H "Content-Type: application/json" \
  "$PAPERCLIP_URL/api/tool-gateway/tools/call" \
  -d '{ "tool": "create_item", "parameters": { "title": "Demo item" } }')

STATUS=$(echo "$CALL" | tail -1)
BODY=$(echo "$CALL" | sed '$d')
echo "HTTP $STATUS"
echo "$BODY" | jq '{error, reasonCode, invocationId, actionRequestId, interactionId, tool, argumentsHash}'
export ACTION_REQUEST_ID=$(jq -r '.actionRequestId' <<<"$BODY")
```

Expected: `HTTP 409`, `reasonCode: "approval_required"`, an `actionRequestId`, an `argumentsHash` (canonical hash of the reviewed arguments), and an `interactionId` for the linked issue-thread interaction. The agent's run is paused on this exact tool call until a decision lands.

In the UI, switch to the **Audit** tab and find the approval card. Point at the signed arguments, the requesting agent, the run, and the expiry.

## Step 9 — Approve the action

Approve via the API for the recording (the UI button does the same thing). The approval endpoint requires `companyId` (in the body or as a query parameter):

```sh
curl -fsS -X POST \
  -H "Authorization: Bearer $BOARD_API_KEY" \
  -H "Content-Type: application/json" \
  "$PAPERCLIP_URL/api/tool-gateway/action-requests/$ACTION_REQUEST_ID/approve" \
  -d '{ "companyId": "'"$COMPANY_ID"'" }' \
  | jq '{id, status, resolvedAt, resolvedByUserId, canonicalArgumentsHash}'
```

Expected: `status: "approved"` and `resolvedAt` set. The agent call has not run yet — approval marks the action request ready to be consumed.

## Step 10 — Retry the call with the approved action request

The agent retries the same call with `approvedActionRequestId` set to the action request it received in Step 8. The gateway re-validates that the canonical arguments hash matches what was approved, then executes the tool.

```sh
curl -fsS -X POST \
  -H "X-Paperclip-Tool-Gateway-Token: $GATEWAY_TOKEN" \
  -H "Content-Type: application/json" \
  "$PAPERCLIP_URL/api/tool-gateway/tools/call" \
  -d '{
    "tool": "create_item",
    "parameters": { "title": "Demo item" },
    "approvedActionRequestId": "'"$ACTION_REQUEST_ID"'"
  }' \
  | jq '{invocationId, status, tool, result}'
```

Expected: `status: "completed"`, with the created item in `result`. The audit log gets a `tool_gateway.call_allowed` event followed by a `tool_gateway.call_completed` event, both linked to the same `actionRequestId`.

If you change the `parameters` between Step 8 and Step 10, the retry fails with `reasonCode: "signed_arguments_mismatch"` — the approval is for the exact reviewed arguments, not the next call shape.

## Step 11 — Promote the approval to a trust rule (optional)

Skip this on a 5-minute recording. Include it for the 10-minute version because it shows the operator-side automation story.

```sh
curl -fsS -X POST \
  -H "Authorization: Bearer $BOARD_API_KEY" \
  -H "Content-Type: application/json" \
  "$PAPERCLIP_URL/api/companies/$COMPANY_ID/tools/action-requests/$ACTION_REQUEST_ID/trust-rule" \
  -d '{
    "name": "Trust create_item from the demo agent",
    "approvalThreshold": 2,
    "scope": { "includeAgent": true, "includeTool": true },
    "argumentFilters": { "exactHash": null, "allowAny": false, "fieldEquals": { "title": "Demo item" } },
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

1. `tool_gateway.call_completed` — `create_item`, `allow` (Step 10 retry)
2. `tool_gateway.call_allowed` — `create_item`, `approved` (Step 10 entry into execution)
3. `tool_gateway.approval_requested` — `create_item`, `require_approval` (Step 8 approval card)
4. `tool_gateway.call_denied` — `delete_item`, `deny`, with `reasonCode` of `quarantined_catalog_entry` or `deny_default` (Step 6)
5. `tool_gateway.call_completed` — `list_items`, `allow` (Step 5)

Close on the audit tab. Three required cases visible in a single screen: a read that landed, a write that took an approval round-trip, and a destructive call that was denied with a reason. End of recording.

## Cleanup (optional)

If you ran the demo on a long-lived environment, leave the example installed — the bundled smoke (`POST …/examples/safe-read-only-todo-kv/smoke`) replays the read and deny cases on demand. If you need a clean state:

```sh
# Revoke the trust rule (if you created one)
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

- **Read** path: the read-only catalog entry, the read-only profile, and the gateway audit row line up. Gateway-token header, `tool`/`parameters` body, `status: "completed"` on success.
- **Approval-gated write** path: profile inclusion + `require_approval` policy + HTTP `409` `approval_required` carrying `actionRequestId` + board-key approval scoped to `companyId` + retry with `approvedActionRequestId` + audit closure. Trust rule promotion (Step 11) bridges the human-in-the-loop step to a steady-state allow without losing the audit trail.
- **Denied / destructive** path: catalog quarantine on first sight, profile default-deny, and a clean deny HTTP response with `reasonCode` at the gateway. The agent sees a failed call; the operator sees the reason in the audit row.

This is the contract the launch ships. If a future change loosens any of these — silent allow on a destructive tool, an approval that doesn't audit, a denied call without a reason code, or a retry that ignores the canonical-arguments hash — the demo will fail and so will QA.
