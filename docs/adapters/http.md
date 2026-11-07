---
title: HTTP Adapter
summary: HTTP webhook adapter
---

The `http` adapter sends a webhook request to an external agent service. The agent runs externally and Paperclip just triggers it.

## When to Use

- Agent runs as an external service (cloud function, dedicated server)
- Fire-and-forget invocation model
- Integration with third-party agent platforms

## When Not to Use

- If the agent runs locally on the same machine (use `process`, `claude_local`, or `codex_local`)
- If you need stdout capture and real-time run viewing

## Configuration

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `url` | string | Yes | Webhook URL to POST to |
| `headers` | object | No | Additional HTTP headers |
| `timeoutSec` | number | No | Request timeout |
| `timeoutMs` | number | No | Request timeout in milliseconds; takes precedence over `timeoutSec` |
| `runAttestation` | boolean | No | Opt in to a signed, receiver-scoped run token; default `false` |

## How It Works

1. Paperclip sends a POST request to the configured URL
2. The request body includes the execution context (agent ID, task info, wake reason)
3. The external agent processes the request and calls back to the Paperclip API
4. Response from the webhook is captured as the run result

## Request Body

The webhook receives a JSON payload with:

```json
{
  "runId": "...",
  "agentId": "...",
  "context": {
    "taskId": "...",
    "wakeReason": "...",
    "commentId": "..."
  }
}
```

The external agent uses `PAPERCLIP_API_URL` and an API key to call back to Paperclip.

## Receiver-scoped run attestation

Set `runAttestation: true` only for an issue-scoped HTTPS webhook. The server must
have `PAPERCLIP_HTTP_RUN_ATTESTATION_KEY_FILE` pointing to an Ed25519 PEM private
key owned by its process user, in a regular file with no group or other access.
Paperclip sends `x-paperclip-run-attestation` on the POST request. It rejects
redirects, missing verified issue IDs, missing or unsafe keys, and attempts to
set this reserved header through `headers`. In attested mode, Paperclip rejects
all configured headers so static API credentials cannot be forwarded to the
receiver; the request uses only JSON content type and the attestation header.
It also rejects `payloadTemplate` and sends only `agentId`, `companyId`,
`runId`, and the server-verified `issueId` in a body limited to 2 KiB; it does
not forward the run context, runtime tools, or Paperclip API JWT.

The token is an EdDSA JWT with `typ=paperclip-http-run+jwt` and `kid` equal to
the SHA-256 digest of the public SPKI DER key. Its claims are `iss=paperclip-http-run`,
`aud=<canonical HTTPS request URL>`, `sub=<agent UUID>`, `company_id`,
`adapter_type=http`, `run_id`, `issue_id`, `iat`, `nbf`, `exp`, and a random `jti`.
It expires 120 seconds after issue. The issue ID comes from Paperclip's verified
issue lookup, not from the request body's caller-supplied context.

The receiver must pin the public key, verify the signature and all expected
claims including the exact endpoint, enforce time bounds and one-time `jti`,
and check that the run is currently active for the agent and issue before
acting. The token authenticates the invocation; it is **not** a Paperclip API
bearer token, a review vote, or authorization to sign evidence. Isolate the
Paperclip signing key from all agent runtimes before using it for independent
security reviews. A server and agent processes sharing one OS account do not
provide that isolation.
