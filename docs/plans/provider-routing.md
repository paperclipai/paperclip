# Provider Routing — Operator Reference

## Overview

Provider routing allows Paperclip to fall back to an alternative LLM provider
when the primary provider (Claude / Anthropic) is quota-exhausted. Fallback is
restricted to safe, low-risk agents and task types only.

**Current stage: 0 (config only — zero behavioral change)**

---

## Deterministic Routing Precedence

Every routing decision follows this strict priority chain. The first matching
rule wins. This ordering is enforced as a linear chain of guard clauses in
`resolveProviderForRun()`.

```
Priority 1: Human override
  Agent-level providerRoutingOverride: "force_primary" | "force_fallback" | "auto"

Priority 2: Kill switch
  PAPERCLIP_DISABLE_PROVIDER_ROUTING=1  OR  enableProviderRoutingFallback === false

Priority 3: Budget cap
  maxFallbackSpendPerDayUsd / maxFallbackRunsPerHour / maxFallbackRunsPerDay

Priority 4: Circuit breaker
  providerRoutingCircuitBreakerTriggered + cooldown window

Priority 5: Hard-blocked context
  Approvals, wallet, credentials, SSH, deployment, infrastructure, permissions, governance

Priority 6: Eligibility policy
  Agent name allowlist + role denylist + task-risk classification

Priority 7: Provider availability
  Is primary provider quota-exhausted?

Priority 8: Fallback credentials
  Is OPENROUTER_API_KEY (or configured credentialEnvKey) set?

Priority 9: Fallback route
  All gates passed → route to fallback provider
```

---

## Task-Risk Classification

| Class | Fallback allowed | Examples |
|-|-|-|
| `safe_readonly` | Yes | Read-only queries, QA scans |
| `monitoring` | Yes | Heartbeat, liveness, watchdog |
| `reporting` | Yes | Trust scoring, evaluation |
| `drafting` | Yes | Content creation, review drafts |
| `governance` | **No** | Approvals, policy, permissions |
| `infrastructure` | **No** | SSH, sandbox bypass, env mutation |
| `financial` | **No** | Wallet, billing, budget |
| `deployment` | **No** | Deploy, release, rollout |

Unknown / unclassified tasks default to `governance` (fail-closed).

---

## Provider Confidence Levels

| Level | Meaning |
|-|-|
| `full` | Primary provider, normal operation |
| `degraded` | Primary experiencing errors or budget cap hit |
| `emergency_fallback` | Running on fallback provider |

---

## Configuration

### Instance experimental settings

| Key | Type | Default | Description |
|-|-|-|-|
| `enableProviderRoutingFallback` | boolean | `false` | Master enable flag |
| `providerRoutingStage` | 0-3 | `0` | Rollout stage |
| `providerRoutingFallbackModel` | string | `deepseek/deepseek-coder` | Fallback model ID |
| `providerRoutingMaxFallbackSpendPerDayUsd` | number | `5` | Daily budget cap |
| `providerRoutingMaxFallbackRunsPerHour` | number | `20` | Hourly run cap |
| `providerRoutingMaxFallbackRunsPerDay` | number | `100` | Daily run cap |
| `providerRoutingCircuitBreakerCooldownMinutes` | number | `60` | Cooldown after trip |

### Environment variables

| Variable | Required | Description |
|-|-|-|
| `OPENROUTER_API_KEY` | Stage 2+ | API key for fallback provider |
| `PAPERCLIP_DISABLE_PROVIDER_ROUTING` | No | Set to `1` to kill-switch |

---

## Rollback

Three independent methods — any one is sufficient:

1. **Settings**: Set `enableProviderRoutingFallback: false` or `providerRoutingStage: 0`
2. **Env var**: Set `PAPERCLIP_DISABLE_PROVIDER_ROUTING=1`
3. **Credentials**: Remove `OPENROUTER_API_KEY`

Takes effect on the next heartbeat cycle. In-flight runs are unaffected.

---

## Rollout Stages

| Stage | Behavior |
|-|-|
| 0 | Config + types only. No routing evaluation in production path. |
| 1 | Evaluate routing decisions, log to NDJSON. Always use primary. |
| 2 | Stage 1 + write to activity_log, validate credentials. Still primary only. |
| 3 | Live fallback for allowlisted agents (TrustScore, WatchDog, Content Strategist). |

---

## Circuit Breaker

Trips when fallback provider produces repeated failures:

| Condition | Threshold | Window |
|-|-|-|
| Consecutive execution failures | 3 | 30 min |
| Malformed responses | 3 | 30 min |
| Hallucinated tool calls | 2 | 60 min |
| Cost spike (>5x agent median) | 1 | Immediate |

Cooldown: configurable (default 60 min). Resets on server restart.

---

## Observability

All routing decisions logged to:
- Run NDJSON stream (`provider_routing.decision` events)
- Activity log (Stage 2+)
- Board exports (governance section)

Key metrics queryable from existing tables:
- Fallback frequency (`heartbeat_runs.contextSnapshot`)
- Quota exhaustion frequency (`heartbeat_runs.errorCode`)
- Provider cost comparison (`cost_events.biller`)
- Circuit breaker trips (`activity_log`)
- Budget cap hits (`activity_log`)

---

## Files

| File | Purpose |
|-|-|
| `server/src/services/provider-routing-policy.ts` | Task-risk classification, eligibility gates |
| `server/src/services/provider-routing.ts` | Routing decisions, circuit breaker, budget checks |
| `packages/shared/src/validators/instance.ts` | Settings schema |
| `packages/adapters/claude-local/src/server/parse.ts` | Quota exhaustion detection |
