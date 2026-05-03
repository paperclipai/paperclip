# Cursor SDK Adapter — Technical Plan

**Status:** Draft
**Date:** 2026-05-03
**Supersedes:** [`2026-02-23-cursor-cloud-adapter.md`](./2026-02-23-cursor-cloud-adapter.md)

## Overview

This plan defines a new Paperclip adapter, `cursor_sdk`, built on the official
[`@cursor/sdk`](https://cursor.com/docs/sdk/typescript) (public beta, Cursor TS SDK).

The SDK is a single client surface that can drive Cursor agents in three runtime modes:

1. **Local** — runs the agent in-process on the Paperclip host against a local working dir
2. **Cloud (Cursor-managed)** — runs the agent in a Cursor-hosted VM, repo cloned remotely
3. **Self-hosted Cloud** — same as cloud but against a customer-managed VM pool

The SDK exposes:

- typed agent lifecycle (`Agent.create` / `Agent.resume` / `Agent.list` / `Agent.archive`)
- typed run lifecycle (`run.stream()`, `run.wait()`, `run.cancel()`, `run.onDidChangeStatus()`)
- a discriminated `SDKMessage` event stream (system/user/assistant/thinking/tool_call/status/task/request)
- catalog APIs (`Cursor.me`, `Cursor.models.list`, `Cursor.repositories.list`)
- typed errors (`AuthenticationError`, `RateLimitError`, `ConfigurationError`, `IntegrationNotConnectedError`, `NetworkError`, `UnknownAgentError`, `UnsupportedRunOperationError`)
- programmatic MCP server config, subagents, artifacts, session env vars

Because the SDK already handles transport, streaming, cancellation, and signature work,
the adapter shrinks dramatically vs. the 2026-02-23 plan.

---

## Paperclip Architecture Alignment

This plan must conform to Paperclip's existing adapter contract; it is not greenfield.

### Adapter contract (canonical, from `cursor-local`)

Every built-in adapter is a workspace package `@paperclipai/adapter-<name>` with this exact
exports shape:

```jsonc
{
  "exports": {
    ".":         "./src/index.ts",      // type, label, models, modelProfiles, agentConfigurationDoc
    "./server":  "./src/server/index.ts", // execute, testEnvironment, sessionCodec, (skill helpers)
    "./ui":      "./src/ui/index.ts",   // parseStdoutLine, ConfigFields, buildAdapterConfig
    "./cli":     "./src/cli/index.ts"   // printStreamEvent
  }
}
```

`server.execute` receives an `AdapterExecutionContext` and returns an
`AdapterExecutionResult` from `@paperclipai/adapter-utils`. The cursor-sdk adapter MUST
match that signature byte-for-byte; do not invent a parallel interface.

Key context fields the new adapter must respect (sourced from `cursor-local`'s execute):

| Field | Source | Behavior we must preserve |
|---|---|---|
| `runId, agent, runtime, config, context, onLog, onMeta, onSpawn, authToken` | `AdapterExecutionContext` | Standard plumbing — pass through unchanged. |
| `executionTarget` / `executionTransport.remoteExecution` | ctx | `readAdapterExecutionTarget(...)`; remote-target mode (E2B-style) needs `prepareAdapterExecutionTargetRuntime`, `runAdapterExecutionTargetProcess`, optional `startAdapterExecutionTargetPaperclipBridge`. **For V1, cursor-sdk supports only `local` execution targets.** Remote-target use is out of scope for V1 because the SDK already handles cloud transport itself; layering remote-target on top is redundant. |
| `context.paperclipWorkspace` | ctx | resolves cwd, workspaceId, repoUrl, repoRef, agentHome — feed into both runtime config and session codec. |
| `context.paperclipWorkspaces` (hint list) | ctx | persisted as `PAPERCLIP_WORKSPACES_JSON` env (only relevant if we expose env to SDK; cloud env vars cannot start with `CURSOR_` but `PAPERCLIP_*` is fine). |
| `context.paperclipWake` | ctx | render via `renderPaperclipWakePrompt(... { resumedSession })` and join into prompt sections via `joinPromptSections`. |
| `context.paperclipSessionHandoffMarkdown` | ctx | append as a prompt section. |
| `authToken` (Paperclip API token) | ctx | populates `PAPERCLIP_API_KEY` env when no explicit one configured. For cloud runtime this becomes a `cloud.envVars.PAPERCLIP_API_KEY` entry (allowed: doesn't start with `CURSOR_`). |
| `runtime.sessionId` / `runtime.sessionParams` | ctx | drives resume policy via the session codec. |

Helpers we must reuse (don't reinvent):

- `asString`, `asNumber`, `asStringArray`, `parseObject` — config parsing
- `buildPaperclipEnv(agent)` — base PAPERCLIP_* env
- `applyPaperclipWorkspaceEnv` — workspace identity env
- `renderTemplate`, `renderPaperclipWakePrompt`, `joinPromptSections`,
  `DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE` — prompt assembly
- `inferOpenAiCompatibleBiller` + the `billingType: "api" | "subscription"` discriminator
- `buildInvocationEnvForLogs` (only for the non-SDK path; SDK runs in-process so there's
  no spawned command to log — we still call `onMeta` with adapter/model/cwd/prompt info)

### Session codec shape

`sessionCodec` mirrors `cursor-local`:

```ts
{ sessionId, cwd?, workspaceId?, repoUrl?, repoRef?, remoteExecution? }
```

For `cursor-sdk`, `sessionId` is the SDK's `agentId`. For cloud runs we additionally
carry `repoUrl`/`repoRef` so resume only happens when the repo identity matches.

### Streaming event format

The Paperclip UI/CLI parsers consume **one JSON object per stdout line** (NDJSON). The
new adapter does not spawn a subprocess, so we simulate that line stream by calling
`onLog("stdout", JSON.stringify(event) + "\n")` for each `SDKMessage`. Event shape stays
compatible with `cursor-local`'s parser where event types overlap (`init`, `assistant`,
`user`, `result`); new SDK-only event types (`thinking`, `tool_call`, `task`, `request`,
`status`) are emitted with the SDK's discriminant under a stable `type` key and parsed
by the new `parse-stdout.ts`.

### Shared constants and registry surface

Paperclip enforces adapter-type as a non-empty string (see `agent-type.ts`), so `cursor_sdk`
will load even before constants are updated. But to keep the type discoverable and
documented as a built-in, V1 still updates:

1. `packages/shared/src/constants.ts` — add `"cursor_sdk"` to `AGENT_ADAPTER_TYPES`
2. `packages/shared/src/index.ts` — re-export if needed (already wildcard)
3. `server/src/adapters/registry.ts` — register module
4. `ui/src/adapters/registry.ts` — register UI module
5. `cli/src/adapters/registry.ts` — register CLI module
6. `ui/src/components/agent-config-primitives.tsx`, `AgentProperties.tsx`,
   `pages/Agents.tsx`, `OnboardingWizard.tsx` — label maps (only files with explicit
   `cursor` entries)

### Verification rules from AGENTS.md

- Default verification before claiming work done: `pnpm test` (Vitest only)
- For PR-ready hand-off: `pnpm -r typecheck && pnpm test:run && pnpm build`
- During development: smallest targeted check first — typecheck the new package + the
  three packages it touches before running the full repo
- Repo-rule: keep changes company-scoped (no behavior change here — adapter-level)
- Repo-rule: contracts synchronized across `db / shared / server / ui` (no schema change
  in V1, only constants + registries)

---

## Backwards Compatibility (Hard Requirement)

**No existing Paperclip agent may break.** Specifically:

| Existing surface | Status |
|---|---|
| `packages/adapters/cursor-local` (adapter type `cursor`) | **Untouched.** Keep code, config schema, CLI subprocess flow, model fallback list, `--resume`/`--yolo` behavior, `~/.cursor/skills` injection, E2B `~/.local/bin/cursor-agent` resolution. |
| `cursor` adapter type in shared constants/validators | Stays. |
| `cursor-local` registry entries (server/ui/cli) | Stay. |
| Existing agent rows with `adapterType: "cursor"` | Continue resolving to `cursor-local` with no migration step. |

The new SDK adapter is **additive**:

- New package: `packages/adapters/cursor-sdk`
- New adapter type: `cursor_sdk`
- New shared-constants entry, new registry rows in server/ui/cli
- New label: `"Cursor SDK"` (visually distinct from `"Cursor CLI (local)"`)

A migration path from `cursor` → `cursor_sdk` is documented but never automatic. V1 ships
both adapters in parallel; we only consider deprecating `cursor-local` after the SDK
adapter has been stable in production for at least one release cycle and the SDK leaves
public beta.

### Shared code policy

To avoid drift, two pieces of `cursor-local` code may be lifted into a shared internal
helper at `packages/adapters/cursor-shared/src/`:

- model-id catalog + profile defaults (the `CURSOR_FALLBACK_MODEL_IDS` list)
- `agentConfigurationDoc` template fragments common to both adapters

`cursor-local` keeps re-exporting the same public API; only its internals import from
`cursor-shared`. If extraction risks any behavior change, **skip it for V1** and accept
the duplication.

---

## SDK Reference Cheat Sheet

Package: `@cursor/sdk` (public beta — APIs may change before GA).

### Auth

```ts
// from CURSOR_API_KEY env var, or pass apiKey explicitly
import { Agent, Cursor } from "@cursor/sdk";
```

Supported keys: User API keys (Dashboard → Integrations) and Service Account API keys
(Team settings). Team Admin keys are not yet supported.

### Lifecycle

```ts
const agent = await Agent.create({ model, local | cloud, mcpServers, agents, ... });
const resumed = await Agent.resume(agentId, partialOptions);
const oneShot = await Agent.prompt("do X", options); // create + send + wait

await Agent.list({...}); await Agent.get(agentId); await Agent.archive(agentId);
await Agent.listRuns(agentId); await Agent.getRun(runId);

const run = await agent.send(message, { onDelta, onStep });
for await (const ev of run.stream()) { /* SDKMessage */ }
const result = await run.wait();        // RunResult
await run.cancel();                      // typed cancellation
const turns = await run.conversation();
run.onDidChangeStatus((s) => {...});
```

### Runtime config

```ts
// LOCAL (in-process, files on disk)
local: {
  cwd?: string | string[];
  settingSources?: ("project" | "user" | "team" | "mdm" | "plugins" | "all")[];
  sandboxOptions?: { enabled: boolean };
}

// CLOUD (Cursor-hosted)
cloud: {
  env?: { type: "cloud" | "pool" | "machine"; name?: string };
  repos: { url: string; startingRef?: string; prUrl?: string }[];
  workOnCurrentBranch?: boolean;
  autoCreatePR?: boolean;
  skipReviewerRequest?: boolean;
  envVars?: Record<string, string>; // session env, encrypted at rest, cannot start with CURSOR_
}
```

### Catalog

```ts
await Cursor.me();                  // SDKUser { apiKeyName, userEmail?, createdAt }
await Cursor.models.list();         // SDKModel[] with parameters + variants
await Cursor.repositories.list();   // SDKRepository[] (rate-limited, cache aggressively)
```

### Errors

`CursorAgentError` base with `isRetryable`, `code`, `cause`, `protoErrorCode`. Subtypes:
`AuthenticationError`, `RateLimitError`, `ConfigurationError`,
`IntegrationNotConnectedError` (carries `provider` + `helpUrl`), `NetworkError`,
`UnknownAgentError`, `UnsupportedRunOperationError`.

### Disposal

```ts
await using agent = await Agent.create({...}); // auto-disposed on block exit
// or explicit:
await agent[Symbol.asyncDispose]();
agent.close();      // fire-and-forget
await agent.reload(); // re-read filesystem config without disposing
```

---

## Adapter Config Contract (`src/index.ts`)

```ts
export const type = "cursor_sdk";
export const label = "Cursor SDK";
```

V1 config fields:

**Common**
- `runtime` (required): `"local" | "cloud" | "self_hosted"` — selects mode
- `model` (optional, allow empty = SDK auto)
- `modelParams` (optional `Record<string,string>`): forwarded as `ModelParameterValue[]`
- `promptTemplate`
- `instructionsFilePath` (optional, mirrors `cursor-local`)
- `timeoutSec` (optional, default `0`)
- `graceSec` (optional, default `20`)
- `env.CURSOR_API_KEY` (required, secret_ref preferred)

**`runtime: "local"`**
- `cwd` (optional, falls back to agent default)
- `settingSources` (optional, default `["project", "user", "plugins"]`)
- `sandbox` (optional bool, default `false`)

**`runtime: "cloud"` / `"self_hosted"`**
- `repository` (required): GitHub repo URL — maps to `cloud.repos[0].url`
- `ref` (optional, default `main`) → `startingRef`
- `additionalRepos` (optional `{url, startingRef?}[]`) → appended to `cloud.repos`
- `workOnCurrentBranch` (optional, default `false`)
- `autoCreatePr` (optional, default `false`)
- `skipReviewerRequest` (optional, default `false`)
- `sessionEnvVars` (optional `Record<string,string>` of secret refs) → `cloud.envVars`
- `vmEnv.type` (optional, default `"cloud"`): `"cloud" | "pool" | "machine"`
- `vmEnv.name` (required when `vmEnv.type !== "cloud"`)

**Optional advanced**
- `mcpServers` (optional, JSON object) — forwarded to SDK
- `subagents` (optional `Record<string, SubagentDef>`)
- `hooks` — **not in V1**. Hooks are file-based per SDK; document `.cursor/hooks.json` in the configuration doc.
- `enableCallback` (optional, default `false`) — opt-in for skill/Paperclip API callback (see below)

Secret handling: `CURSOR_API_KEY` and any `sessionEnvVars` use `adapterConfig.env` so the
existing secret-resolution flow handles `secret_ref`. Never store the key in a
top-level `apiKey` field.

---

## Why most of the old plan goes away

| 2026-02-23 plan element | 2026-05-03 disposition |
|---|---|
| Hand-rolled `src/api.ts` REST client + typed errors | **Removed.** SDK provides both. |
| Polling loop on `/v0/agents/{id}` | **Removed.** Use `run.stream()` + `run.onDidChangeStatus()`. |
| Webhook receiver + HMAC verification | **Removed from V1 default path.** Streaming is push-based via SDK. Webhooks become an *opt-in* fallback for very long runs where the Paperclip server may restart mid-run (see "Resilience" below). |
| Bootstrap auth exchange + `/api/agent-auth/exchange` | **Demoted to optional.** Only required if cloud agents need to call back into Paperclip APIs (e.g. for skill fetch, artifact push). Gated by `enableCallback: true`. Local runtime never needs it. |
| Custom synthetic stdout event format (`init`/`status`/`assistant`/`user`/`result`) | **Replaced.** Map SDK `SDKMessage` events directly. Keep the same wire format internally so `parse-stdout.ts` and CLI formatter changes stay minimal. |
| Hardcoded model list | **Replaced** with dynamic `Cursor.models.list()` cached per-org for ~5 min, with the `cursor-local` fallback list as offline default. |
| Manual cancellation handler registration | Still required at the Paperclip layer, but the handler simply calls `run.cancel()` then `agent[Symbol.asyncDispose]()`. |

---

## Package Structure

```
packages/adapters/cursor-sdk/
├── package.json            # exports: ".", "./server", "./ui", "./cli"
├── tsconfig.json
└── src/
    ├── index.ts            # type/label/agentConfigurationDoc/models/profiles
    ├── runtime.ts          # buildRuntimeOptions(config) -> { local } | { cloud }
    ├── events.ts           # SDKMessage -> Paperclip stdout event mapping
    ├── server/
    │   ├── index.ts
    │   ├── execute.ts      # main run orchestration via SDK
    │   ├── session.ts      # agentId persistence + resume policy
    │   ├── test.ts         # env diagnostics
    │   ├── callback.ts     # OPTIONAL: bootstrap exchange + skill route helpers
    │   └── webhook.ts      # OPTIONAL: long-run resilience fallback
    ├── ui/
    │   ├── index.ts
    │   ├── parse-stdout.ts
    │   └── build-config.ts
    └── cli/
        ├── index.ts
        └── format-event.ts
```

If `cursor-shared` is extracted, also:

```
packages/adapters/cursor-shared/
├── package.json
└── src/
    ├── models.ts           # CURSOR_FALLBACK_MODEL_IDS + profile defaults
    └── doc-fragments.ts
```

---

## Execution Flow (`src/server/execute.ts`)

### Step 1: Resolve config + secrets
- parse adapter config
- resolve `CURSOR_API_KEY`
- if `runtime === "cloud" | "self_hosted"`: resolve `sessionEnvVars`
- validate required fields per runtime mode

### Step 2: Build SDK options
Delegate to `runtime.ts`:
- model + modelParams
- runtime block (`local: {...}` or `cloud: {...}`)
- mcpServers (forwarded)
- subagents (forwarded as `agents`)

### Step 3: Resolve session
- session identity is SDK `agentId` (stored in `sessionParams`)
- reuse policy:
  - `runtime: "local"` — reuse only when `cwd` matches stored cwd
  - `runtime: "cloud"` — reuse only when `repository` matches
- on reuse: `Agent.resume(agentId, partialOptions)`
- else: `Agent.create(options)`

### Step 4: Render prompt
- standard template render
- if `enableCallback: true`: append a compact callback block (public URL + bootstrap token + skill index endpoint)
- else: no callback section, agent runs self-contained

### Step 5: Send + stream
```ts
const run = await agent.send(prompt, {
  onDelta: ({ update }) => emitDelta(update),
});

run.onDidChangeStatus((s) => emitStatus(s));

for await (const ev of run.stream()) {
  emitSdkMessage(ev);  // map to Paperclip stdout event
}

const result = await run.wait();
```

### Step 6: Map events to Paperclip stdout
`events.ts` maps each SDK `SDKMessage.type` to the existing Paperclip event format used by
`cursor-local`:

| SDKMessage.type | Paperclip event | Notes |
|---|---|---|
| `system` | `init` | include model + tools list |
| `user` | `user` | echo |
| `assistant` | `assistant` | text + tool-use blocks |
| `thinking` | `assistant` (subtype `thinking`) | so existing UI parsers don't choke |
| `tool_call` | `tool_call` | new event subtype |
| `status` | `status` | cloud lifecycle (CREATING/RUNNING/FINISHED/ERROR/CANCELLED/EXPIRED) |
| `task` | `task` | new event subtype |
| `request` | `request` | awaiting input/approval |

### Step 7: Result mapping
`AdapterExecutionResult`:
- `exitCode: 0` on `RunStatus === "finished"`, `1` on `error`/`cancelled`
- `errorMessage` from `CursorAgentError.message` when applicable
- `sessionParams: { agentId, repository?, cwd? }`
- `provider: "cursor"`
- `usage` / `costUsd` — still null (SDK does not expose token usage in run result; revisit when SDK adds it)
- `resultJson`: include `{ status, result, durationMs, git, conversationSnapshot }`

### Step 8: Cleanup
Always `await agent[Symbol.asyncDispose]()` in `finally`. Use `await using` where the
control flow allows.

---

## Cancellation

Register a per-run cancellation handler that:

1. calls `await run.cancel()` (typed; SDK handles transport)
2. calls `await agent[Symbol.asyncDispose]()` to release resources
3. emits a final `status` event with `cancelled` so the UI updates

This still requires the generic non-subprocess cancellation hook the old plan flagged
(`server/src/...` — exact location TBD when implementing). That hook is still on the
critical-path checklist.

---

## Resilience: optional webhook fallback

For runs that may exceed the Paperclip server's process lifetime (deploys, restarts), a
streaming-only model loses the connection. V1 ships **two** resilience patterns:

1. **Default:** on reconnect/restart, look up persisted `agentId`, call `Agent.get(agentId)`
   to read terminal status, then `agent.listRuns()` + `Agent.getRun(runId)` to recover the
   final state. No webhooks.
2. **Opt-in webhook fallback:** if `cloud.webhookUrl` is configured (out-of-band), the
   server can also accept Cursor `statusChange` webhooks to wake up a recovery worker
   sooner. This reuses the original plan's HMAC verification design as `webhook.ts`.
   Off by default; documented but not required for V1.

---

## Skills Delivery Strategy

### Local runtime
Same as `cursor-local`: ensure `~/.cursor/skills` is populated. We can lift this routine
into `cursor-shared` so both adapters reuse one copy.

### Cloud runtime
Two supported delivery modes:

1. **Repo-committed (preferred for V1):** skills live under `.cursor/skills/` in the
   target repo. SDK auto-loads them. Zero callback infrastructure needed.
2. **Paperclip-hosted (opt-in via `enableCallback`):** the agent fetches skill content
   from Paperclip's API at runtime via the bootstrap exchange flow described in the
   superseded plan. Implement only when a customer asks for it.

Document both in the adapter configuration doc; default to (1) until there's a real (2)
ask.

---

## Environment Test (`src/server/test.ts`)

Checks:
1. `CURSOR_API_KEY` present
2. key validity via `Cursor.me()`
3. model exists (when set) via `Cursor.models.list()` (cached)
4. **runtime-specific:**
   - local: `cwd` resolves and is writable
   - cloud: `repository` URL well-formed; optionally probe `Cursor.repositories.list()` *only* when an explicit `verifyRepositoryAccess` flag is set (rate-limited: 1/min, 30/hr per user)
5. when `enableCallback: true`: `paperclipPublicUrl` resolvable and bootstrap secret length-valid

---

## UI + CLI

### `src/ui/parse-stdout.ts`
Handle the same event vocabulary as `cursor-local` plus the new subtypes (`thinking`,
`tool_call`, `task`, `request`). Render terminal failures with `isError=true`.

### `src/ui/build-config.ts`
Map `CreateConfigValues` to adapter config:
- top-level `runtime` selector
- show/hide local-only vs cloud-only fields by `runtime`
- env binding shape preserved (`plain` / `secret_ref`)

### `ui/src/adapters/cursor-sdk/config-fields.tsx`
Form controls grouped:
- **Common:** runtime, model, model params, prompt template, instructions file, timeout, grace, `CURSOR_API_KEY`
- **Local:** cwd, settingSources (multi-select), sandbox toggle
- **Cloud:** repository, ref, additionalRepos, workOnCurrentBranch, autoCreatePr, skipReviewerRequest, vmEnv {type, name}, sessionEnvVars (env-style list)
- **Advanced:** mcpServers (JSON editor), subagents, enableCallback, paperclipPublicUrl

### `src/cli/format-event.ts`
Mirror `cursor-local` formatting; add lines for `thinking`, `tool_call`, `task`,
`request`, and `status` lifecycle.

---

## Server Registration & Cross-Layer Sync

### Adapter registration
- `server/src/adapters/registry.ts` — register `cursor_sdk` next to `cursor`
- `ui/src/adapters/registry.ts`
- `cli/src/adapters/registry.ts`

### Shared contract updates
- `packages/shared/src/constants.ts` — add `cursor_sdk` to `AGENT_ADAPTER_TYPES` (do **not** remove `cursor`)
- `packages/shared/src/validators/agent.ts` — accept new type
- UI label maps in:
  - `ui/src/components/agent-config-primitives.tsx`
  - `ui/src/components/AgentProperties.tsx`
  - `ui/src/pages/Agents.tsx`
  - `ui/src/components/OnboardingWizard.tsx` (add option, do not change default)

### Optional routes (only when `enableCallback: true`)
- `POST /api/adapters/cursor-sdk/webhooks` — HMAC-verified statusChange receiver (resilience fallback)
- `POST /api/agent-auth/exchange` — bootstrap → run-scoped JWT
- `GET /api/skills/index` and `GET /api/skills/:name`

These routes are shared infrastructure if/when other remote adapters need them.

---

## Comparison Matrix

| Aspect | `cursor` (cursor-local, unchanged) | `cursor_sdk` local | `cursor_sdk` cloud |
|---|---|---|---|
| Transport | `cursor-agent` CLI subprocess | `@cursor/sdk` in-process | `@cursor/sdk` → Cursor cloud |
| Streaming | stdout `--output-format stream-json` | `run.stream()` | `run.stream()` |
| Resume | `--resume` flag | `Agent.resume(agentId)` | `Agent.resume(agentId)` |
| Cancellation | OS signal | `run.cancel()` + dispose | `run.cancel()` + dispose |
| Skills | `~/.cursor/skills` injection | same + SDK auto-load | repo `.cursor/skills/` (preferred) or callback |
| MCP | inherits CLI behavior | inline `mcpServers` config | inline + dashboard-managed |
| Subagents | inherits CLI behavior | `agents` config + `.cursor/agents/*.md` | same |
| Models | hardcoded fallback list | `Cursor.models.list()` + fallback | `Cursor.models.list()` + fallback |
| Errors | parsed from stderr | typed `CursorAgentError` subclasses | typed `CursorAgentError` subclasses |
| Auth | uses logged-in CLI session | `CURSOR_API_KEY` | `CURSOR_API_KEY` |
| Usage/cost | not exposed | not exposed (revisit) | not exposed (revisit) |

---

## V1 Limitations

1. **No token/cost usage** in run results (SDK doesn't expose it; revisit when added).
2. **Inline `mcpServers` not persisted across `Agent.resume()`** — if the run is resumed,
   re-pass mcpServers explicitly. Document this.
3. **Artifact download not implemented for local agents** in current SDK; `listArtifacts`
   returns empty — surface as "cloud-only" in UI.
4. **`local.settingSources` doesn't apply to cloud agents.**
5. **Hooks file-based only** (`.cursor/hooks.json`) — no programmatic hook config.
6. **Tool call schema is unstable** — render `args`/`result` as opaque JSON in UI.
7. **`/v0/repositories` rate limit** (1/min, 30/hr per user) — only call behind explicit
   `verifyRepositoryAccess` flag.
8. **Public beta SDK** — pin `@cursor/sdk` to a known-good minor; track release notes for
   breaking changes.

---

## Future Enhancements

1. Lift cursor-local skill injection + model catalog into `cursor-shared`.
2. Surface `Run.git` (branch + PR URL) in Paperclip run detail UI.
3. Add a "Migrate to SDK" wizard once SDK leaves beta.
4. Wire `Cursor.repositories.list()` into the agent-create UI as a typeahead.
5. Add per-org `Cursor.me()` health check to the org settings page.
6. Subagent template library shipped via `.cursor/agents/*.md`.
7. Webhook-based resilience worker (when needed for long cloud runs across deploys).
8. Self-hosted VM pool registration UX.

---

## Implementation Checklist

### Adapter package
- [ ] `packages/adapters/cursor-sdk/package.json` — exports `.`, `./server`, `./ui`, `./cli`; depends on `@cursor/sdk`
- [ ] `packages/adapters/cursor-sdk/tsconfig.json`
- [ ] `src/index.ts` — type/label/`agentConfigurationDoc`/model profiles
- [ ] `src/runtime.ts` — `buildRuntimeOptions(config)` for local/cloud/self_hosted
- [ ] `src/events.ts` — `SDKMessage` → Paperclip event mapping
- [ ] `src/server/execute.ts` — `Agent.create`/`resume` + `run.stream()` orchestration
- [ ] `src/server/session.ts` — agentId persistence + resume policy
- [ ] `src/server/test.ts` — env diagnostics via `Cursor.me()` / `models.list()`
- [ ] `src/server/index.ts` — exports + session codec
- [ ] `src/ui/parse-stdout.ts`
- [ ] `src/ui/build-config.ts`
- [ ] `src/ui/index.ts`
- [ ] `src/cli/format-event.ts`
- [ ] `src/cli/index.ts`

### Optional (only if `enableCallback`)
- [ ] `src/server/callback.ts` — bootstrap exchange helpers
- [ ] `src/server/webhook.ts` — HMAC verification for resilience fallback
- [ ] server route: `/api/adapters/cursor-sdk/webhooks`
- [ ] server route: `/api/agent-auth/exchange`
- [ ] server routes: `/api/skills/index`, `/api/skills/:name`

### App integration
- [ ] register `cursor_sdk` in server/ui/cli registries (do not touch `cursor` registration)
- [ ] add `cursor_sdk` to shared adapter constants/validators
- [ ] add label `"Cursor SDK"` in UI surfaces (keep `"Cursor CLI (local)"` for `cursor`)
- [ ] add generic non-subprocess cancellation hook (calls `run.cancel()` + dispose)

### Backwards-compatibility verification
- [ ] existing agents with `adapterType: "cursor"` continue to load and run unchanged
- [ ] no migration code touches `cursor-local` source
- [ ] `cursor-local` tests still pass without modification
- [ ] new `cursor_sdk` adapter does not collide with `cursor` registry key, label, or default model

### Tests
- [ ] runtime option builder: each `runtime` mode → expected SDK options shape
- [ ] event mapper: each `SDKMessage.type` → expected Paperclip event
- [ ] terminal status mapping (`finished`/`error`/`cancelled`)
- [ ] session codec round-trip (agentId + repository/cwd discrimination)
- [ ] config builder env binding handling (plain + secret_ref)
- [ ] error classification: `AuthenticationError`/`RateLimitError`/etc → `AdapterExecutionResult`
- [ ] resume reuse policy: matches/mismatches on cwd (local) and repository (cloud)
- [ ] cancellation: `run.cancel()` invoked + agent disposed
- [ ] (if implemented) webhook signature verification + dedupe
- [ ] (if implemented) bootstrap exchange happy path + expired/invalid token

### Verification
- [ ] `pnpm -r typecheck`
- [ ] `pnpm test:run`
- [ ] `pnpm build`
- [ ] manual smoke: create agent with `runtime: "local"`, run prompt end-to-end
- [ ] manual smoke: create agent with `runtime: "cloud"` against a test repo, run prompt end-to-end, verify resume
