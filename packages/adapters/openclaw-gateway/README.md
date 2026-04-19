# OpenClaw Gateway Adapter

This document describes how `@paperclipai/adapter-openclaw-gateway` invokes OpenClaw over the Gateway protocol.

## Transport

This adapter always uses WebSocket gateway transport.

- URL must be `ws://` or `wss://`
- Connect flow follows gateway protocol:
1. receive `connect.challenge`
2. send `req connect` (protocol/client/auth/device payload)
3. send `req agent`
4. wait for completion via `req agent.wait`
5. stream `event agent` frames into Paperclip logs/transcript parsing

## Auth Modes

Gateway credentials can be provided in any of these ways:

- `authToken` / `token` in adapter config
- `headers.x-openclaw-token`
- `headers.x-openclaw-auth` (legacy)
- `password` (shared password mode)

When a token is present and `authorization` header is missing, the adapter derives `Authorization: Bearer <token>`.

## Device Auth

By default the adapter sends a signed `device` payload in `connect` params.

- set `disableDeviceAuth=true` to omit device signing
- set `devicePrivateKeyPem` to pin a stable signing key
- without `devicePrivateKeyPem`, the adapter generates an ephemeral Ed25519 keypair per run
- when `autoPairOnFirstConnect` is enabled (default), the adapter handles one initial `pairing required` by calling `device.pair.list` + `device.pair.approve` over shared auth, then retries once.

## Session Strategy

The adapter supports the same session routing model as HTTP OpenClaw mode:

- `sessionKeyStrategy=issue|fixed|run`
- `sessionKey` is used when strategy is `fixed`

Resolved session key is sent as `agent.sessionKey`.

## Recommended Paperclip Role

For live Paperclip companies, treat OpenClaw as an ops-manager agent rather than the CEO.

- use a stable agent name such as `OpenClawOps`
- enable heartbeat on the agent
- grant `tasks:assign` when you want manager-mode delegation
- rely on the heartbeat workflow to inspect company state, create child issues, and nudge `@CEO` only when work is stalled

## Payload Mapping

The agent request is built as:

- required fields:
  - `message` (wake text plus optional `payloadTemplate.message`/`payloadTemplate.text` prefix)
  - `idempotencyKey` (Paperclip `runId`)
  - `sessionKey` (resolved strategy)
- optional additions:
  - all `payloadTemplate` fields merged in
  - `agentId` from config if set and not already in template

Paperclip wake context is delivered in two ways:

- inside `message` as environment hints plus the structured wake payload JSON
- in a top-level `paperclip` field when the gateway accepts it

If the gateway rejects the top-level `paperclip` field as incompatible, the adapter retries once without that field for compatibility.

The default wake workflow is:

1. `GET /api/agents/me`
2. `GET /api/companies/{companyId}/dashboard`
3. `GET /api/agents/me/inbox-lite`
4. `GET /api/issues/{issueId}/heartbeat-context` for the chosen issue

For company-wide fallback targeting, use `GET /api/companies/{companyId}/issues?status=todo,in_progress,blocked&limit=50` rather than `/api/issues?...`.

## Timeouts

- `timeoutSec` controls adapter-level request budget
- `waitTimeoutMs` controls `agent.wait.timeoutMs`

If `agent.wait` returns `timeout`, adapter returns `openclaw_gateway_wait_timeout`.

## Log Format

Structured gateway event logs use:

- `[openclaw-gateway] ...` for lifecycle/system logs
- `[openclaw-gateway:event] run=<id> stream=<stream> data=<json>` for `event agent` frames

UI/CLI parsers consume these lines to render transcript updates.
