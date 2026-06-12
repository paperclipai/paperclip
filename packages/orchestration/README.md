# @paperclipai/orchestration

A pure, tenant-agnostic LLM router. Given a `TaskDescriptor` and an injected
routing policy, it picks `(engine, model)`, scores the decision, and produces a
telemetry event — with no I/O and no clock dependency.

## Why

Adapter selection is otherwise static — one model pinned per agent. This package
decides `(engine, model)` *per task*, scaling complexity (simple → critical),
pivoting role (reasoning / orchestration / document / research / automation),
and applying blast-radius safety edges (second-pass + sign-off gates).

## Tenant-injected policy

The core ships **no routing rules**. `DEFAULT_POLICY` is empty; the routing grid
is supplied by the caller at runtime via `RouterDependencies.policy`. Task type
ids are opaque to the core — define whatever taxonomy fits your domain.

```ts
import { route, EXAMPLE_POLICY } from '@paperclipai/orchestration';

const decision = route(
  { task_type: 'strategy_positioning_board', sensitivity: 'outbound', expected_complexity: 'complex' },
  { policy: EXAMPLE_POLICY },
);
// → { engine: 'claude', model: 'claude-opus-4-7', fallback: { engine: 'chatgpt', … }, … }
```

`EXAMPLE_POLICY` (`./example-policy.ts`) is a reference table only — copy it and
adapt it to your own task taxonomy.

## What the core owns vs. what the tenant injects

| Concern | Owner |
|---|---|
| Routing grid (task_type → engine) | **Tenant** (`deps.policy`) |
| Sensitivity → complexity floor | Core (domain-neutral default) |
| Second-pass + human sign-off gates | Core (blast-radius semantics) |
| Model catalog + pricing snapshot | Core defaults (override via `selectModel` wrap) |
| Long-context promotion (>200k) | Core, gated by `deps.geminiAvailable` |

## Safety edges

- `sensitivity: outbound|regulatory|critical` floors complexity and forces a
  cross-vendor second pass; an unresolvable second pass throws
  `RouterPolicyViolationError`.
- `sensitivity: regulatory|critical` (or any critical-complexity task) sets
  `human_sign_off_required`.
- Tier 2 (`api`) requires `automation: true`, else fail-fast.

## Telemetry

`decisionToTelemetry(decision, descriptor)` lifts a decision into a
`TelemetryEvent`; emit it via `InMemoryTelemetrySink`, `LoggerTelemetrySink`, or
your own `TelemetrySink`. Outcome fields (`actual_cost_eur_cents`, `latency_ms`,
`outcome_signal`) are filled by the caller after the call resolves.
