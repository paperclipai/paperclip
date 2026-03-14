# Cursor Cloud Agent Adapter — Technical Plan

## Overview

This document defines the V1 design for a Paperclip adapter that integrates with
Cursor Background Agents via the Cursor REST API.

Primary references:

- https://docs.cursor.com/background-agent/api/overview
- https://docs.cursor.com/background-agent/api
- https://docs.cursor.com/background-agent/api/webhooks

Unlike `claude_local` and `codex_local`, this adapter is not a local subprocess.
It is a remote orchestration adapter with:

1. launch/follow-up over HTTP
2. webhook-driven status updates when possible
3. polling fallback for reliability
4. synthesized stdout events for Paperclip UI/CLI

## Key V1 Decisions

1. **Auth to Cursor API** uses `Authorization: Bearer <CURSOR_API_KEY>`.
2. **Callback URL** must be publicly reachable by Cursor VMs:
   - local: Tailscale URL
   - prod: public server URL
3. **Agent callback auth to Paperclip** uses a bootstrap exchange flow (no long-lived Paperclip key in prompt).
4. **Webhooks are V1**, polling remains fallback.
5. **Skill delivery** is fetch-on-demand from Paperclip endpoints, not full SKILL.md prompt injection.

---

## Cursor API Reference (Current)

Base URL: `https://api.cursor.com`

Authentication header:

- `Authorization: Bearer <CURSOR_API_KEY>`

Core endpoints:

| Endpoint | Method | Purpose |
|---|---|---|
| `/v0/agents` | POST | Launch agent |
| `/v0/agents/{id}` | GET | Agent status |
| `/v0/agents/{id}/conversation` | GET | Conversation history |
| `/v0/agents/{id}/followup` | POST | Follow-up prompt |
| `/v0/agents/{id}/stop` | POST | Stop/pause running agent |
| `/v0/models` | GET | Recommended model list |
| `/v0/me` | GET | API key metadata |
| `/v0/repositories` | GET | Accessible repos (strictly rate-limited) |

Status handling policy for adapter:

- Treat `CREATING` and `RUNNING` as non-terminal.
- Treat `FINISHED` as success terminal.
- Treat `ERROR` as failure terminal.
- Treat unknown non-active statuses as terminal failure and preserve raw status in `resultJson`.

Webhook facts relevant to V1:

- Cursor emits `statusChange` webhooks.
- Terminal webhook statuses include `ERROR` and `FINISHED`.
- Webhook signatures use HMAC SHA256 (`X-Webhook-Signature: sha256=...`).

Operational limits:

- `/v0/repositories`: 1 req/user/min, 30 req/user/hour.
- MCP not supported in Cursor background agents.

---

## Package Structure

```
packages/adapters/cursor-cloud/
├── package.json
├── tsconfig.json
└── src/
    ├── index.ts
    ├── api.ts
    ├── server/
    │   ├── index.ts
    │   ├── execute.ts
    │   ├── parse.ts
    │   ├── test.ts
    │   └── webhook.ts
    ├── ui/
    │   ├── index.ts
    │   ├── parse-stdout.ts
    │   └── build-config.ts
    └── cli/
        ├── index.ts
        └── format-event.ts
```

`package.json` uses standard four exports (`.`, `./server`, `./ui`, `./cli`).

---

## API Client (`src/api.ts`)

`src/api.ts` is a typed wrapper over Cursor endpoints.

```ts
interface CursorClientConfig {
  apiKey: string;
  baseUrl?: string; // default https://api.cursor.com
}

interface CursorAgent {
  id: string;
  name: string;
  status: "CREATING" | "RUNNING" | "FINISHED" | "ERROR" | string;
  source: { repository: string; ref: string };
  target: {
    branchName?: string;
    prUrl?: string;
    url?: string;
    autoCreatePr?: boolean;
    openAsCursorGithubApp?: boolean;
    skipReviewerRequest?: boolean;
  };
  summary?: string;
  createdAt: string;
}
```

Client requirements:

- send `Authorization: Bearer ...` on all requests
- throw typed `CursorApiError` with `status`, parsed body, and request context
- preserve raw unknown fields for debugging in error metadata

---

## Adapter Config Contract (`src/index.ts`)

```ts
export const type = "cursor_cloud";
export const label = "Cursor Cloud Agent";
```

V1 config fields:

- `repository` (required): GitHub repo URL
- `ref` (optional, default `main`)
- `model` (optional, allow empty = auto)
- `autoCreatePr` (optional, default `false`)
- `branchName` (optional)
- `promptTemplate`
- `pollIntervalSec` (optional, default `10`)
- `timeoutSec` (optional, default `0`)
- `graceSec` (optional, default `20`)
- `paperclipPublicUrl` (optional override; else `PAPERCLIP_PUBLIC_URL` env)
- `enableWebhooks` (optional, default `true`)
- `env.CURSOR_API_KEY` (required, secret_ref preferred)
- `env.CURSOR_WEBHOOK_SECRET` (required if `enableWebhooks=true`, min 32)

Important: do not store Cursor key in plain `apiKey` top-level field.
Use `adapterConfig.env` so secret references are supported by existing secret-resolution flow.

---

## Paperclip Callback + Auth Flow (V1)

Cursor agents run remotely, so we cannot inject local env like `PAPERCLIP_API_KEY`.

### Public URL

The adapter must resolve a callback base URL in this order:

1. `adapterConfig.paperclipPublicUrl`
2. `process.env.PAPERCLIP_PUBLIC_URL`

If empty, fail `testEnvironment` and runtime execution with a clear error.

### Bootstrap Exchange

Goal: avoid putting long-lived Paperclip credentials in prompt text.

Flow:

1. Before launch/follow-up, Paperclip mints a one-time bootstrap token bound to:
   - `agentId`
   - `companyId`
   - `runId`
   - short TTL (for example 10 minutes)
2. Adapter includes only:
   - `paperclipPublicUrl`
   - exchange endpoint path
   - bootstrap token
3. Cursor agent calls:
   - `POST /api/agent-auth/exchange`
4. Paperclip validates bootstrap token and returns a run-scoped bearer JWT.
5. Cursor agent uses returned bearer token for all Paperclip API calls.

This keeps long-lived keys out of prompt and supports clean revocation by TTL.

---

## Skills Delivery Strategy (V1)

Do not inline full SKILL.md content into the prompt.

Instead:

1. Prompt includes a compact instruction to fetch skills from Paperclip.
2. After auth exchange, agent fetches:
   - `GET /api/skills/index`
   - `GET /api/skills/paperclip`
   - `GET /api/skills/paperclip-create-agent` when needed
3. Agent loads full skill content on demand.

Benefits:

- avoids prompt bloat
- keeps skill docs centrally updatable
- aligns with how local adapters expose skills as discoverable procedures

---

## Execution Flow (`src/server/execute.ts`)

### Step 1: Resolve Config and Secrets

- parse adapter config via `asString/asBoolean/asNumber/parseObject`
- resolve `env.CURSOR_API_KEY`
- resolve `paperclipPublicUrl`
- validate webhook secret when webhooks enabled

### Step 2: Session Resolution

Session identity is Cursor `agentId` (stored in `sessionParams`).
Reuse only when repository matches.

### Step 3: Render Prompt

Render template as usual, then append a compact callback block:

- public Paperclip URL
- bootstrap exchange endpoint
- bootstrap token
- skill index endpoint
- required run header behavior

### Step 4: Launch/Follow-up

- on resume: `POST /followup`
- else: `POST /agents`
- include webhook object when enabled:
  - `url: <paperclipPublicUrl>/api/adapters/cursor-cloud/webhooks`
  - `secret: CURSOR_WEBHOOK_SECRET`

### Step 5: Progress + Completion

Use hybrid strategy:

- webhook events are primary status signal
- polling is fallback and transcript source (`/conversation`)

Emit synthetic events to stdout (`init`, `status`, `assistant`, `user`, `result`).

Completion logic:

- success: `status === FINISHED`
- failure: `status === ERROR` or unknown terminal
- timeout: stop agent, mark timedOut

### Step 6: Result Mapping

`AdapterExecutionResult`:

- `exitCode: 0` on success, `1` on terminal failure
- `errorMessage` populated on failure/timeout
- `sessionParams: { agentId, repository }`
- `provider: "cursor"`
- `usage` and `costUsd`: unavailable/null
- `resultJson`: include raw status/target/conversation snapshot

Also ensure `result` event is emitted to stdout before return.

---

## Webhook Handling (`src/server/webhook.ts` + server route)

Add a server endpoint to receive Cursor webhook deliveries.

Responsibilities:

1. Verify HMAC signature from `X-Webhook-Signature`.
2. Deduplicate by `X-Webhook-ID`.
3. Validate event type (`statusChange`).
4. Route by Cursor `agentId` to active Paperclip run context.
5. Append `heartbeat_run_events` entries for audit/debug.
6. Update in-memory run signal so execute loop can short-circuit quickly.

Security:

- reject invalid signature (`401`)
- reject malformed payload (`400`)
- always return quickly after persistence (`2xx`)

---

## Environment Test (`src/server/test.ts`)

Checks:

1. `CURSOR_API_KEY` present
2. key validity via `GET /v0/me`
3. repository configured and URL shape valid
4. model exists (if set) via `/v0/models`
5. `paperclipPublicUrl` present and reachable shape-valid
6. webhook secret present/length-valid when webhooks enabled

Repository-access verification via `/v0/repositories` should be optional due strict rate limits.
Use a warning-level check only when an explicit `verifyRepositoryAccess` option is set.

---

## UI + CLI

### UI parser (`src/ui/parse-stdout.ts`)

Handle event types:

- `init`
- `status`
- `assistant`
- `user`
- `result`
- fallback `stdout`

On failure results, set `isError=true` and include error text.

### Config builder (`src/ui/build-config.ts`)

- map `CreateConfigValues.url -> repository`
- preserve env binding shape (`plain`/`secret_ref`)
- include defaults (`pollIntervalSec`, `timeoutSec`, `graceSec`, `enableWebhooks`)

### Adapter fields (`ui/src/adapters/cursor-cloud/config-fields.tsx`)

Add controls for:

- repository
- ref
- model
- autoCreatePr
- branchName
- poll interval
- timeout/grace
- paperclip public URL override
- enable webhooks
- env bindings for `CURSOR_API_KEY` and `CURSOR_WEBHOOK_SECRET`

### CLI formatter (`src/cli/format-event.ts`)

Format synthetic events similarly to local adapters.
Highlight terminal failures clearly.

---

## Server Registration and Cross-Layer Contract Sync

### Adapter registration

- `server/src/adapters/registry.ts`
- `ui/src/adapters/registry.ts`
- `cli/src/adapters/registry.ts`

### Shared contract updates (required)

- add `cursor_cloud` to `packages/shared/src/constants.ts` (`AGENT_ADAPTER_TYPES`)
- ensure validators accept it (`packages/shared/src/validators/agent.ts`)
- update UI labels/maps where adapter names are enumerated, including:
  - `ui/src/components/agent-config-primitives.tsx`
  - `ui/src/components/AgentProperties.tsx`
  - `ui/src/pages/Agents.tsx`
- consider onboarding wizard support for adapter selection (`ui/src/components/OnboardingWizard.tsx`)

Without these updates, create/edit flows will reject the new adapter even if package code exists.

---

## Cancellation Semantics

Long-polling HTTP adapters must support run cancellation.

V1 requirement:

- register a cancellation handler per running adapter invocation
- `cancelRun` should invoke that handler (abort fetch/poll loop + optional Cursor stop call)

Current process-only cancellation maps are insufficient by themselves for Cursor.

---

## Comparison with `claude_local`

| Aspect | `claude_local` | `cursor_cloud` |
|---|---|---|
| Execution model | local subprocess | remote API |
| Updates | stream-json stdout | webhook + polling + synthesized stdout |
| Session id | Claude session id | Cursor agent id |
| Skill delivery | local skill dir injection | authenticated fetch from Paperclip skill endpoints |
| Paperclip auth | injected local run JWT env var | bootstrap token exchange -> run JWT |
| Cancellation | OS signals | abort polling + Cursor stop endpoint |
| Usage/cost | rich | not exposed by Cursor API |

---

## V1 Limitations

1. Cursor does not expose token/cost usage in API responses.
2. Conversation stream is text-only (`user_message`/`assistant_message`).
3. MCP/tool-call granularity is unavailable.
4. Webhooks currently deliver status-change events, not full transcript deltas.

---

## Future Enhancements

1. Reduce polling frequency further when webhook reliability is high.
2. Attach image payloads from Paperclip context.
3. Add richer PR metadata surfacing in Paperclip UI.
4. Add webhook replay UI for debugging.

---

## Implementation Checklist

### Adapter package

- [ ] `packages/adapters/cursor-cloud/package.json` exports wired
- [ ] `packages/adapters/cursor-cloud/tsconfig.json`
- [ ] `src/index.ts` metadata + configuration doc
- [ ] `src/api.ts` bearer-auth client + typed errors
- [ ] `src/server/execute.ts` hybrid webhook/poll orchestration
- [ ] `src/server/parse.ts` stream parser + not-found detection
- [ ] `src/server/test.ts` env diagnostics
- [ ] `src/server/webhook.ts` signature verification + payload helpers
- [ ] `src/server/index.ts` exports + session codec
- [ ] `src/ui/parse-stdout.ts`
- [ ] `src/ui/build-config.ts`
- [ ] `src/ui/index.ts`
- [ ] `src/cli/format-event.ts`
- [ ] `src/cli/index.ts`

### App integration

- [ ] register adapter in server/ui/cli registries
- [ ] add `cursor_cloud` to shared adapter constants/validators
- [ ] add adapter labels in UI surfaces
- [ ] add Cursor webhook route on server (`/api/adapters/cursor-cloud/webhooks`)
- [ ] add auth exchange route (`/api/agent-auth/exchange`)
- [ ] add skill serving routes (`/api/skills/index`, `/api/skills/:name`)
- [ ] add generic cancellation hook for non-subprocess adapters

### Tests

- [ ] api client auth/error mapping
- [ ] terminal status mapping (`FINISHED`, `ERROR`, unknown terminal)
- [ ] session codec round-trip
- [ ] config builder env binding handling
- [ ] webhook signature verification + dedupe
- [ ] bootstrap exchange happy path + expired/invalid token

### Verification

- [ ] `pnpm -r typecheck`
- [ ] `pnpm test:run`
- [ ] `pnpm build`
