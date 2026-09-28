# Single-use execution grants

An execution grant lets a named agent apply one approved agent configuration
change without a second board approval. It does not give the agent general edit
rights. The agent's normal API permission, host sandbox, and external service
permission checks still apply.

## Set the company policy

A board actor appoints an active Decision Steward with
`PUT /api/companies/:companyId/execution-grant-policy` and a JSON body of
`{"stewardAgentId":"<agent-id>"}`. Agents cannot change this policy. The route
returns its `version`. Each later appointment increments that version and makes
older grants unusable. `GET` on the same path reads the current policy.

## Approve an exact request

The proposer first reads the target agent and its latest config revision from
`GET /api/agents/:id` and `GET /api/agents/:id/config-revisions`. Use `null` for
`targetRevisionId` when no revision exists. The proposal's `targetUpdatedAt`
must equal the target agent's `updatedAt` at issuance.

The proposed `executionGrant` has version `1`, a named `executorAgentId`, the
`targetAgentId`, operation `agent_config:update`, the target revision and update
time, the exact `requestBody`, a `requestHash`, an `expiresAt` timestamp, and the
current policy version. Compute the SHA-256 hash of the JSON object
`{method, path, body, targetUpdatedAt}`. Set `method` to `PATCH`, `path` to
`/api/agents/<target-id>`, and `body` to the exact PATCH body. Recursively sort
object keys with JavaScript `localeCompare`; preserve array order. For example,
an API client running on Node.js can use:

```js
import { createHash } from "node:crypto";

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)]));
  }
  return value;
}

const requestHash = createHash("sha256")
  .update(JSON.stringify({
    method: "PATCH", path: `/api/agents/${targetAgentId}`,
    body: canonicalize(requestBody), targetUpdatedAt,
  }))
  .digest("hex");
```

This matches `executionGrantRequestHash` in
`server/src/services/execution-grant-contract.ts`. The hash binds the HTTP
method, target path, canonical JSON body, and target update time. Generate
`detailsMarkdown` with `executionGrantApprovalDetails(request)`
from `@paperclipai/shared`; the API rejects approval text that differs from this
exact display.

Submit the request through either of these existing decision paths:

- **Steward decision:** Create a `request_confirmation` interaction on the issue
  with `payload.executionGrant` and `payload.detailsMarkdown`, addressed to the
  appointed Steward. The Steward must accept it. The proposer, Steward, and
  executor must be distinct agents.
- **Board decision:** Create a `request_board_approval` approval linked to the
  issue with the same two payload fields. A board user must approve it. Board
  decisions produce the same grant type.

For either decision path, the proposer and executor must be distinct agents.

Approval records and interaction details are readable to actors with access to
the issue. Grant requests therefore accept only display-safe profile fields,
selected adapter settings, typed runtime AI connection bindings, and managed
secret references in adapter environment bindings. Put secret values through
the managed secret flow before proposing a grant. Plaintext env values,
arbitrary nested adapter or runtime fields, permission changes, and changes to
the appointed Steward are outside this grant path.

## Issue and consume the grant

The named executor must have an active Paperclip run and company-scoped agent
authentication. In that run, call
`POST /api/issues/:issueId/execution-grants` with
`{"decisionKind":"agent","decisionId":"<accepted-interaction-id>"}` or use
`"board"` and the approved board approval ID. The API checks the decision,
approver, target freshness, request hash, expiry, and policy version, then returns
the grant ID. A consumed decision cannot issue another grant.

Apply the approved body with `PATCH /api/agents/:targetAgentId` and the header
`X-Paperclip-Execution-Grant: <grant-id>`. Send the exact body from the approved
request. The API checks the executor's current run and ordinary update
permissions, then consumes the grant and applies the agent update in one
transaction. A failed update rolls back consumption. Replay, a changed body,
an expired grant, a changed target or policy, and an attempt to edit the Steward
are denied. A new approval is required after any such change.

The grant never changes the host sandbox or external service permissions. A
reviewed release and live one-use check remain operator tasks after deployment.
