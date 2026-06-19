# OpenClaw Gateway Bridge Requirements

This is the contract for keeping Paperclip's `openclaw_gateway` integration alive across Paperclip image rolls and OpenClaw upgrades.

## Supported integration path

- Paperclip supports OpenClaw through the `openclaw_gateway` adapter.
- Transport is WebSocket only: `ws://` or `wss://`.
- The old OpenClaw HTTP/SSE adapter and the old OpenClaw-side `paperclip-bridge` plugin are not the supported path.
- Do not re-add `paperclip-bridge` to OpenClaw `plugins.allow` or `plugins.entries`; current integration is Paperclip-owned adapter code calling the OpenClaw gateway.

## Protocol compatibility

Paperclip must negotiate the OpenClaw gateway protocol range from the adapter source:

- `MIN_PROTOCOL_VERSION = 3`
- `PROTOCOL_VERSION = 4`

Why this matters: the live OpenClaw gateway expects protocol `4`. An image built from adapter code that advertises only `min=3 max=3` will connect and then fail with a protocol-mismatch error before any agent work starts.

Regression guard:

```bash
pnpm exec vitest run --project @paperclipai/adapter-openclaw-gateway
```

The adapter test `packages/adapters/openclaw-gateway/src/server/execute.test.ts` pins the rollback-safe range. If OpenClaw raises the required gateway protocol again, update all of these in one change:

1. `packages/adapters/openclaw-gateway/src/server/execute.ts`
2. `packages/adapters/openclaw-gateway/src/server/test.ts`
3. `packages/adapters/openclaw-gateway/src/server/execute.test.ts`
4. this document
5. the OpenClaw update checklist entry for Paperclip

## Gateway payload schema

Paperclip sends Paperclip metadata on the root `agent` request payload. The OpenClaw gateway must accept that field in its strict agent schema:

```ts
paperclip: Type.Optional(Type.Unknown())
```

Failure signature when the OpenClaw image drops this carry:

```text
invalid agent params: at root: unexpected property 'paperclip'
```

This is tracked in OpenClaw as ISSUE-045. OpenClaw image updates must verify the schema carry before promotion.

## Required adapter configuration

Minimum join/default payload:

```json
{
  "adapterType": "openclaw_gateway",
  "agentDefaultsPayload": {
    "url": "ws://<openclaw-gateway-host>:<port>",
    "headers": { "x-openclaw-token": "<gateway-token>" }
  }
}
```

Runtime requirements:

- `adapterType` must be `openclaw_gateway`.
- Gateway URL must be reachable from the Paperclip runtime pod/container.
- Auth must provide one of:
  - `authToken` / `token`
  - `headers.x-openclaw-token`
  - `headers.x-openclaw-auth` (legacy)
  - `password` (shared password mode)
- When a token is present and `authorization` is absent, the adapter derives `Authorization: Bearer <token>`.
- Device auth stays enabled by default.
- Persist `adapterConfig.devicePrivateKeyPem` after pairing; otherwise every run can look like a new device.
- `sessionKeyStrategy: "issue"` is the production default so issue work resumes in the same OpenClaw session.
- Use a long enough `waitTimeoutMs` for agent work; production agents have used `300000`.

## Image roll requirements

The Paperclip image deployed to production must be built from canonical `origin/master` containing the bridge carry. Do not rely on a one-off branch image; that is how protocol v4 was lost once already.

Before pinning a Paperclip image in `lue-kube`:

1. Paperclip `Release` workflow is green for the commit.
2. Paperclip `Docker` workflow is green for the same commit.
3. The built image digest corresponds to that exact commit.
4. `packages/adapters/openclaw-gateway` targeted gates pass locally or in CI:

```bash
pnpm exec vitest run --project @paperclipai/adapter-openclaw-gateway
pnpm --filter @paperclipai/adapter-openclaw-gateway typecheck
pnpm --filter @paperclipai/adapter-openclaw-gateway build
```

When updating `lue-kube`, pin every Paperclip runtime image reference that participates in startup/run execution to the same immutable tag+digest. At minimum this has included both the `seed-browser-toolkit` init container and the main `paperclip` container.

## Deployment smoke checks

After the lue-kube image pin is applied:

1. Confirm the running Paperclip pod image matches the Git-declared digest.
2. Confirm OpenClaw gateway logs do not show:
   - `protocol mismatch`
   - `min=3 max=3 expected=4`
   - `invalid agent params: at root: unexpected property 'paperclip'`
3. Confirm the Paperclip OpenClaw agent is not stuck in `status: error` with a stale `lastError`.
4. Run one task assigned to the OpenClaw-backed agent and confirm it reaches terminal success or a real task-level failure, not adapter/protocol failure.
5. If first run requires pairing, approve the device once and confirm subsequent runs reuse the persisted device key.

## Ownership boundary

- Paperclip owns adapter protocol negotiation, auth/header mapping, session key strategy, device key persistence, and image release correctness.
- OpenClaw owns the gateway protocol/schema and must keep accepting Paperclip metadata while the adapter sends it.
- lue-kube owns the production image pin and must not roll a Paperclip image unless the workflows and bridge smoke checks above are green.
