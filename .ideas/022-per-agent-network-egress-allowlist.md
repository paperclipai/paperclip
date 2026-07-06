# 022 — Per-Agent Network Egress Allow-Listing

## Suggestion

Paperclip controls *what runtimes* an agent may use (`execution-allowlist.ts` maps
driver/provider/policy → allow/deny) and has a containment notion for untrusted agents
(`low-trust-runtime-containment.ts`). What it doesn't control is **where an agent can talk on
the network**. An autonomous agent executing code or shell commands can reach any host on the
internet — which is the primary data-exfiltration and supply-chain risk for an AI workforce.
"This agent may only reach `api.anthropic.com`, `github.com`, and our internal API" is a basic
control that doesn't exist yet.

Add **per-agent (and per-trust-tier) network egress allow-listing**: declare the destinations an
agent's runs may contact, and deny the rest at the runtime boundary.

## How it could be achieved

1. **Egress policy model.** Add an `egressAllowlist` (domains/IP ranges/ports) to an agent's
   execution policy, with sensible defaults per trust tier — a `probation`/low-trust agent
   (ideas 009, `source-trust.ts`) gets a tight default; a senior agent gets a broader one.
2. **Enforce at the containment layer.** This is what `low-trust-runtime-containment.ts` and the
   sandbox runtime (`sandbox-provider-runtime.ts`, `plugin-runtime-sandbox.ts`) are positioned
   to do. Depending on runtime: a proxy that only forwards allow-listed hosts, container network
   policy, or DNS/firewall rules injected into the sandbox.
3. **Default-deny for low trust, default-allow for trusted.** Make the strict mode opt-in per
   company so it doesn't break existing setups, but ship a recommended baseline allowlist
   (model providers, package registries, the Paperclip control plane).
4. **Observability.** Log blocked egress attempts to `activity-log.ts`. A spike of blocked
   destinations is a strong compromise/misconfiguration signal and complements outbound
   secret-leak scanning (idea 020) — together they cover "secret leaving in content" and
   "secret leaving over the wire."
5. **Allowlist authoring help.** Offer a "learning mode" that records the destinations an agent
   actually contacts over a trial period, then proposes an allowlist — so operators don't have
   to author one blind.

## Perceived complexity

**Medium–High.** The policy model and UI are straightforward, but *enforcement* is genuinely
hard and runtime-dependent: a local `process` adapter on the host machine can't be network-
contained as cleanly as a real sandbox/container, so this lands first and best for sandboxed /
cloud runtimes (which the roadmap is already moving toward) and is best-effort for bare local
processes. Scope honestly: deliver strong enforcement where the runtime supports it, and surface
clearly where egress control is *not* available so operators aren't lulled into false security.
