---
title: "MCP HTTP Token Policy"
description: "Lifecycle, scope, and audit rules for the bearer tokens that authenticate the Paperclip MCP server in --http (multi-tenant) mode."
---

# MCP HTTP Token Policy

This is the authoritative policy for the bearer tokens that authenticate the
Paperclip MCP server when it runs in `--http` (multi-tenant) mode. It covers the
token model, TTL, rotation, revocation, single-company scope, the audit trail on
issue/revoke, and the per-tool telemetry that backs anomaly detection.

It does **not** apply to `--stdio` mode, where identity is scoped by the process
environment (`PAPERCLIP_API_KEY` / `PAPERCLIP_COMPANY_ID` / `PAPERCLIP_AGENT_ID`)
of a per-turn harness spawn and no HTTP token exists.

> Status: rev 1 — NEO-296 (NEO-283 plan doc rev 1, Phase A.4). Enforcement points
> live in `packages/mcp-server/src/http.ts`; telemetry in
> `packages/mcp-server/src/telemetry.ts`.

## Token model

In `--http` mode a caller presents an opaque bearer token:

```
Authorization: Bearer <token>
```

The server resolves that token to a **binding** stored in AWS SSM Parameter Store
(a `SecureString`) at:

```
<prefix>/<token>          # prefix defaults to /paperclip/mcp/tokens,
                          # overridable via PAPERCLIP_MCP_TOKEN_PREFIX
```

The token itself is the last path segment, so it is validated against a strict
URL-safe charset (`[A-Za-z0-9._~-]{1,512}`) **before** it is used to build the
parameter name. The parameter value is a JSON object:

| Field       | Required | Meaning |
|-------------|----------|---------|
| `apiKey`    | yes      | The control-plane API key the MCP server calls the REST API with. |
| `companyId` | yes      | The single company this token may act within (see [Single-company scope](#single-company-scope)). |
| `agentId`   | no       | The acting agent identity. Recorded in telemetry as the actor; strongly recommended so calls are attributable. |
| `expiresAt` | no       | Token expiry — ISO 8601 string (preferred) or epoch milliseconds. Enforced when present (see [TTL](#ttl-and-expiry)). |
| `runId`     | no       | Optional run correlation id forwarded to the control plane on writes. |

The control-plane URL is **never** read from the token. It is pinned by the
server environment (`PAPERCLIP_API_URL`), so a token can never redirect calls to
another host. A binding that is missing `apiKey` or `companyId`, or that carries
an unparseable `expiresAt`, is rejected (fails closed).

## TTL and expiry

Tokens SHOULD carry an `expiresAt`. A token at or past its expiry is rejected as
`401 Unauthorized` on the very next request — the check is evaluated on every
call, so expiry takes effect immediately without any sweep.

- **Production default TTL: 15 minutes.** Mint short-lived tokens and re-mint as
  needed rather than issuing long-lived credentials.
- **Non-expiring tokens** (omit `expiresAt`) are permitted only for controlled,
  low-risk local/dev use and MUST NOT be issued for internet-facing exposure.
- `expiresAt` is compared against the server clock. Keep server time in sync
  (the fleet runs `chrony`/NTP); a badly skewed clock changes when tokens lapse.

Because expiry is enforced per request, **setting `expiresAt` to a past instant
is itself a valid revocation** (see [Revocation](#revocation)).

## Rotation

Rotation is **mint-new-then-retire-old**, never mutate-in-place:

1. Mint a fresh token (new random path segment) with its own SSM binding and a
   fresh `expiresAt`.
2. Hand the new token to the client and cut traffic over.
3. Delete the old token's SSM parameter.

Overlapping validity keeps callers from seeing a gap. Never edit the JSON of a
live binding to "reuse" a token string — a leaked token string stays dangerous
until its parameter is deleted, so a new secret must mean a new path.

For short (≤15 min) TTLs, rotation is largely automatic: let tokens expire and
mint replacements. Explicit rotation is for the rare longer-lived binding or an
`apiKey` change.

## Revocation

Any of the following revokes a token, effective on its next request:

- **Delete** the SSM parameter `<prefix>/<token>` (preferred — removes the
  secret entirely). The lookup fails and the server returns `401` without
  leaking whether the parameter ever existed.
- **Expire** it: set `expiresAt` to a past instant. Useful when you want to keep
  the record around briefly for audit before deleting.

Revoking the underlying control-plane `apiKey` (rotating the API credential)
invalidates every token whose binding embeds it, and is the blast-radius control
for a suspected `apiKey` compromise.

## Single-company scope

A token is bound to **exactly one company**. `companyId` is required in the
binding, and the resolved config pins that company for the whole request. There
is no "all companies" or multi-company token. Combined with the server-pinned
`apiUrl`, this means a token can only ever act as its bound company against the
one control plane. Cross-company access requires a separate token with its own
binding, TTL, and audit record.

## Audit trail on issue / revoke

SSM Parameter Store is the system of record for token issuance and revocation,
and every mutation is auditable:

- **CloudTrail** records `ssm:PutParameter` (issue/rotate) and
  `ssm:DeleteParameter` (revoke) with the caller identity, source IP, and
  timestamp. This is the durable, tamper-evident audit log for the token
  lifecycle.
- Issuance and revocation MUST go through an operator with `ssm:PutParameter` /
  `ssm:DeleteParameter` on the `<prefix>/*` path only; keep that permission
  scoped and off broad admin roles so the CloudTrail record is meaningful.
- Record each issue/revoke in the operational logbook (who, which company, which
  agent, why, TTL) alongside the CloudTrail entry, so the *reason* — which
  CloudTrail cannot capture — is retained.

Because tokens are `SecureString` parameters, their **values** never appear in
CloudTrail; only the fact and metadata of the mutation are logged.

## Per-tool telemetry

Every tool call the MCP server serves — in either transport mode — emits one
structured telemetry event, independent of the token lifecycle above, to support
audit and anomaly detection:

| Field        | Meaning |
|--------------|---------|
| `at`         | ISO 8601 emit timestamp. |
| `tool`       | MCP tool name, e.g. `paperclipUpdateIssue`. |
| `actor`      | Acting agent id from the binding/env (`null` if unscoped). |
| `company`    | Bound company id from the binding/env (`null` if unscoped). |
| `status`     | `ok` or `error`. |
| `durationMs` | Wall-clock duration of the call. |
| `errorName`  | Constructor name of the thrown error, only when `status` is `error`. |

The default sink writes one JSON line per call to **stderr** — stdout is reserved
for the MCP JSON-RPC stream in stdio mode and must never carry telemetry. The
sink is injectable (`createPaperclipMcpServer(config, { telemetry })`) so a
deployment can forward events to a log pipeline / SIEM.

Suggested anomaly signals to derive from the stream: bursts of `error` status
from one `actor`/`company`, tool-call rates well above baseline, use of a token
whose company/actor pairing is unexpected, and long-tail `durationMs` spikes.

## Operational checklist

- [ ] Mint tokens with `apiKey` + `companyId` and a ≤15 min `expiresAt` in prod.
- [ ] Store as SSM `SecureString` under `<prefix>/<token>`.
- [ ] Rotate by minting new + deleting old; never mutate a live binding.
- [ ] Revoke by deleting the parameter (or expiring it), effective next request.
- [ ] Keep `ssm:PutParameter`/`ssm:DeleteParameter` on `<prefix>/*` scoped, and
      confirm CloudTrail is capturing both.
- [ ] Log the reason for each issue/revoke in the operational logbook.
- [ ] Ship tool telemetry to the log pipeline and alert on the anomaly signals.
