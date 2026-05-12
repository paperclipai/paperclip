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

## What ships in M1

- An optional `credentialDelivery` field on the `AdapterConfig` Zod schema.
- A `broker_targets` JSONB column on `oauth_connections` for BYO push targets.
- The `broker-targets` CRUD service (callers added in M3).
- The `registerCredentialBroker()` plugin SDK extension slot.
- The `@paperclipai/credential-broker-builtin` package as a placeholder
  (real implementation lands in M2).
- The smart resolver wired into `resolveAdapterConfigForRuntime`, gated by
  the feature flag.
- A per-provider `broker:` block in `server/oauth-providers/*.yaml`, all set
  to `supported: false` for M1. M3 flips them per-provider as each is
  validated end-to-end against the built-in broker.

## What lands later

- **M2**: the in-tree built-in broker — per-task ephemeral CA, loopback HTTP
  CONNECT listener, header injection, session store. Wires into the local
  subprocess sandbox runtime. Flips GitHub to `broker.supported: true`.
- **M3**: fan-out across the remote sandbox runtimes (e2b, daytona,
  kubernetes), standalone broker deploy mode, BYO push-target API and UI,
  refresh-worker push, EnvVarEditor resolved-mode preview, multi-provider
  rollout, default-on flip of the feature flag, upstream coordination for
  the externally-hired agent adapters (Hermes, OpenClaw).

## Spec & plan

- [Design spec](../superpowers/specs/2026-05-12-credential-broker-design.md)
- [M1 implementation plan](../superpowers/plans/2026-05-12-credential-broker-m1-plan.md)
