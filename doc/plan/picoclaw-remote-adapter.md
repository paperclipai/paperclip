# PicoClaw Remote Adapter

Status: Draft
Date: 2026-03-13
Owners: Server + UI + CLI

## 1. Goal

Support PicoClaw instances that run on other machines, including multiple remote instances, without requiring the Paperclip server to have a local `picoclaw` binary or `~/.picoclaw/config.json`.

This document covers the smallest adapter design that is likely to work in practice.

## 2. Verified upstream facts

These points were checked against the upstream PicoClaw README on 2026-03-13:

1. PicoClaw exposes a local CLI agent entrypoint:
- `picoclaw agent -m "hello world"`

2. PicoClaw also exposes a gateway mode:
- `picoclaw gateway`
- configurable via `gateway.host` and `gateway.port`

3. The documented gateway use cases are chat/webhook style integrations and a launcher/web console, not a stable "run this agent task remotely for me" operator API.

Primary source:
- https://github.com/sipeed/picoclaw

Engineering inference:

- We should not couple a new Paperclip adapter directly to undocumented PicoClaw gateway internals.
- A direct "speak upstream PicoClaw gateway protocol" adapter would be fragile unless PicoClaw documents a stable machine-facing execution API.

## 3. Decision

Do not build a first-class Paperclip adapter that talks directly to upstream `picoclaw gateway`.

Instead, build a small authenticated bridge that runs next to PicoClaw on each remote machine, and add a dedicated Paperclip adapter that talks to that bridge over HTTP(S).

Recommended adapter name:
- `picoclaw_remote`

Reason:
- `picoclaw_gateway` would be confusing because PicoClaw already has an upstream "gateway" concept with different semantics.

## 4. Why this should work

Paperclip already supports remote invocation patterns:

1. `http` adapter for JSON-over-HTTP execution
2. `openclaw_gateway` adapter for a protocol-specific remote runtime

PicoClaw already supports the local primitive we need on the remote machine:

1. execute a prompt with `picoclaw agent`
2. select a model with `--model`
3. keep continuity with `--session`
4. inspect available models with `picoclaw model`

That means the missing piece is not agent capability. The missing piece is a stable remote control plane.

## 5. Proposed architecture

## 5.1 Components

1. Paperclip server
- invokes a new `picoclaw_remote` adapter

2. PicoClaw bridge service
- lightweight HTTP service running on the remote machine
- shells out to local `picoclaw`
- owns local filesystem access, model discovery, and session persistence for that machine

3. PicoClaw CLI
- remains unchanged

## 5.2 Trust boundary

Paperclip trusts the bridge, not raw upstream PicoClaw.

The bridge is responsible for:
- authenticating Paperclip
- validating cwd/path policy on the remote machine
- translating HTTP requests into local `picoclaw` CLI invocations
- redacting or rejecting dangerous environment/config combinations

## 5.3 One instance vs many instances

One Paperclip agent config points to one bridge base URL.

That gives clean multi-instance behavior:
- one remote host = one bridge URL
- many remote PicoClaw machines = many Paperclip agents, each with its own bridge URL

No shared cluster scheduler is required for V1.

## 6. Bridge API contract

The bridge contract should be intentionally small.

## 6.1 `GET /v1/health`

Purpose:
- verify bridge reachability
- verify local `picoclaw` command exists
- verify local PicoClaw config exists

Example response:

```json
{
  "status": "ok",
  "picoclawCommand": "picoclaw",
  "picoclawVersion": "unknown",
  "configPath": "/home/bridge/.picoclaw/config.json",
  "configPresent": true
}
```

## 6.2 `GET /v1/models`

Purpose:
- return `picoclaw model` aliases from the remote machine

Example response:

```json
{
  "models": [
    { "id": "gpt-5.4", "label": "gpt-5.4 (openai/gpt-5.4)" }
  ]
}
```

## 6.3 `POST /v1/execute`

Purpose:
- run a single Paperclip heartbeat/request against remote PicoClaw

Example request:

```json
{
  "prompt": "You are agent a1. Continue your Paperclip work.",
  "sessionId": "paperclip:a1:abcd1234",
  "cwd": "/srv/workspaces/project-x",
  "model": "gpt-5.4",
  "timeoutSec": 0,
  "graceSec": 20,
  "extraArgs": [],
  "env": {
    "PAPERCLIP_RUN_ID": "run_123"
  },
  "paperclip": {
    "agentId": "a1",
    "companyId": "c1",
    "runId": "run_123"
  }
}
```

Example response:

```json
{
  "exitCode": 0,
  "timedOut": false,
  "summary": "Done.",
  "stdout": "...\n",
  "stderr": "",
  "sessionId": "paperclip:a1:abcd1234",
  "sessionParams": {
    "sessionId": "paperclip:a1:abcd1234",
    "cwd": "/srv/workspaces/project-x"
  }
}
```

## 7. Paperclip adapter shape

## 7.1 Core config

- `url` (required): bridge base URL
- `authToken` (required): bearer or shared token
- `cwd` (optional): remote working directory fallback
- `instructionsFilePath` (optional): path on the Paperclip machine, inlined into the prompt before request
- `promptTemplate` (optional)
- `model` (optional)
- `headers` (optional)
- `timeoutSec` (optional)

## 7.2 Behavior

The adapter should:

1. preserve the same Paperclip-side prompt rendering as `picoclaw_local`
2. preserve the same stable `sessionId` strategy
3. call `GET /v1/models` for model discovery
4. call `GET /v1/health` during environment diagnostics
5. call `POST /v1/execute` for runs

## 7.3 Session semantics

Session continuity stays machine-local to the bridge.

Implication:
- the same Paperclip agent must keep talking to the same bridge URL if we want session reuse

This is acceptable for V1.

## 8. Verification plan before adapter implementation

Do this in two stages.

## 8.1 Stage 1: bridge proof using existing `http` adapter

Before adding a dedicated adapter:

1. build the bridge
2. point Paperclip's existing `http` adapter at `POST /v1/execute`
3. verify:
- remote PicoClaw execution works
- session continuity works
- remote cwd selection works
- auth works
- model selection works

If this stage fails, do not add a dedicated adapter yet.

## 8.2 Stage 2: first-class `picoclaw_remote` adapter

Once Stage 1 works:

1. add `picoclaw_remote` to shared constants
2. implement server adapter with:
- `execute`
- `testEnvironment`
- `listModels`

3. add UI adapter wiring and onboarding copy
4. add CLI stream formatting

## 9. Explicit non-goals for V1

These should not block the first remote adapter:

- cluster scheduling across many PicoClaw machines
- automatic bridge registration/discovery
- load balancing
- bi-directional streaming transport
- direct compatibility with undocumented upstream PicoClaw gateway internals

## 10. Recommendation

The next implementation step should not be "add a Paperclip adapter."

The next implementation step should be:

1. build a tiny PicoClaw bridge
2. prove it with the generic `http` adapter
3. only then add `picoclaw_remote` as a proper first-class adapter

That is the lowest-risk path and keeps the Paperclip adapter contract stable even if upstream PicoClaw changes its own gateway behavior later.
