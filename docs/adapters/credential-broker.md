---
title: Credential Broker
---

# Credential Broker

The credential broker is the subsystem that keeps OAuth bearer tokens out of
agent process memory. Instead of handing the agent a plaintext bearer, the
broker exposes a host-allowlisted forward proxy and injects credentials at
the TLS boundary — the agent references the credential by an opaque
placeholder and never sees the real token. This is the agentic-secrets pattern
adopted by Infisical Agent Vault, AgentSecrets, and exe.dev's integrations.

> **M1 status — plumbing only.** This page documents the contract surfaces
> shipped in milestone 1. Behavior is **unchanged** from the OAuth backbone
> (#5805) until the feature flag is turned on. The actual broker (the
> in-process forward proxy with per-task ephemeral CA) lands in M2.

## How it fits together

Three **delivery modes** cover every Paperclip runtime:

| Mode | Where the bearer lives | Threat coverage |
|---|---|---|
| `env` | Agent process env | Operator-trusted runtimes only |
| `paperclip-broker` | Broker process only | Paperclip-spawned sandboxes |
| `byo-broker` | Operator's broker process | Externally-hired agents that opt in |

The mode is chosen per dispatch by a **smart resolver**. When the
`credentialDelivery` field on an agent config is unset (the common case),
the resolver picks the strongest mode the runtime supports — `paperclip-broker`
if a broker is registered and reachable, `byo-broker` if the connection has
push targets, otherwise `env` with a warn-log.

Operators can override on a per-agent basis by setting `credentialDelivery`
explicitly in the agent's adapter config:

```yaml
credentialDelivery: env             # opt out, accept plaintext bearer
credentialDelivery: paperclip-broker # require the in-tree broker
credentialDelivery: byo-broker      # require operator-supplied broker
```

## Enabling in M1 (preview)

Set `PAPERCLIP_FEATURE_CREDENTIAL_BROKER=1` to activate the smart resolver.
With this flag on and no broker registered (the M1 state), the resolver
always decides `env` and emits a structured warn-log:

```
WARN credential broker fell back to plaintext env delivery
  event=credential-broker-fallback-to-env
  reason=provider_not_broker_compatible
  bindings=[{"envVarName":"GITHUB_TOKEN","connectionId":"…"}]
  hint=… (reason-specific remediation)
```

This is the M1 observability hook: operators can grep their log stream for
`credential-broker-fallback-to-env` to see exactly which runs would benefit
from broker rollout once M2 ships.

For high-assurance deployments that want the resolver to refuse rather than
fall back, set both flags:

```
PAPERCLIP_FEATURE_CREDENTIAL_BROKER=1
PAPERCLIP_REQUIRE_BROKER=1
```

In that mode the resolver throws `CredentialBrokerRequiredError` instead of
returning a plaintext bearer. Agents that explicitly set
`credentialDelivery: env` on their config are still allowed through — operator
intent overrides strict mode.

## What ships in this PR (M1 + M2 + partial M3)

**M1 — plumbing & contract (behavior-neutral with flag off):**
- Optional `credentialDelivery` field on the `AdapterConfig` Zod schema.
- `broker_targets` JSONB column on `oauth_connections` for BYO push targets.
- `broker-targets` CRUD service (callers wired in a later PR).
- `registerCredentialBroker()` plugin SDK extension slot.
- `@paperclipai/credential-broker-builtin` package scaffold.
- Smart resolver wired into `resolveAdapterConfigForRuntime`, gated by
  the feature flag.
- Per-provider `broker:` block in `server/oauth-providers/*.yaml`.

**M2 — real broker:**
- Per-session ephemeral CA (RSA-2048, validity clamped to ≤24h) + leaf
  signing cached per host.
- TLS-MITM HTTP CONNECT proxy listener — host-allowlisted, session-token
  authenticated, strips placeholders, injects `Authorization: Bearer
  <real>` for matched hosts.
- In-memory session store with bearer cache + per-company fan-out.
- `CredentialBroker` interface implemented + self-registration via
  `@paperclipai/credential-broker-builtin/register`.
- End-to-end test against a stub HTTPS upstream: real bearer reaches
  upstream, agent only ever sees the placeholder.
- Server imports `/register` at bootstrap; `resolveAdapterConfigForRuntime`
  returns a `brokerSession` payload when the resolver picks
  `paperclip-broker` (with `PAPERCLIP_FEATURE_CREDENTIAL_BROKER=1`).
- GitHub flipped to `broker.supported: true`.

**M3 — partial:**
- `brokerSession` reserved on `AdapterExecutionTargetProcessOptions` so
  sandbox runtimes can consume it uniformly.
- Refresh worker pushes rotated access tokens into the broker's bearer
  cache (built-in target; BYO push deferred).

## What's intentionally deferred to follow-up PRs

These are non-blocking because the feature flag is **off by default** —
the broker exists and works, but no production traffic flows through it
until an operator opts in. Default-on flipping is gated on the sandbox
runtime wiring below.

- **Sandbox runtime fan-out** — wire `cloudflare`, `daytona`, `e2b`,
  `exe-dev` sandbox provider plugins (and the local-subprocess driver)
  to mount `brokerSession.caCertPem` and merge HTTPS_PROXY + CA-trust
  env on spawn. Without this, the resolver mints sessions and replaces
  oauth-token env values with placeholders, but agent processes don't
  know to use the proxy — so default-on would actively break things.
- **Standalone broker mode** — same broker code, listener moved out of
  the server process for k8s deployments. Default loopback-only embedded
  mode unblocks local-dev.
- **BYO push-target REST API + Settings UI** — operators that want to
  bring their own broker (Agent Vault, custom mitm) need an endpoint to
  register push URLs. The DB schema + service layer ship in this PR;
  the routes + UI follow.
- **EnvVarEditor resolved-mode chip** — surface the resolver's decision
  on the agent-config form so operators can preview what'll happen.
- **Multi-provider rollout** — Slack, Linear, Notion, Atlassian, Google
  Workspace, Microsoft Graph each get smoke-tested against the broker
  and flipped to `broker.supported: true`. GitHub is the M2 reference.
- **Default-on flag flip** — `PAPERCLIP_FEATURE_CREDENTIAL_BROKER=1` as
  the default. Gated on sandbox runtime wiring.
- **External-adapter coordination** — upstream PRs to
  `hermes-paperclip-adapter` and the OpenClaw gateway documenting the
  BYO push-target setup recipe.

## Spec & plan

- [Design spec](../superpowers/specs/2026-05-12-credential-broker-design.md)
- [M1 implementation plan](../superpowers/plans/2026-05-12-credential-broker-m1-plan.md)
