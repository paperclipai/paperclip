# Paperclip Dark Factory Bridge Plugin POC

Mock Paperclip plugin example for displaying Dark Factory bridge/projection state.

This package is intentionally projection-only:

- It does not modify the Paperclip Task/Issue main model.
- It does not connect to a real Dark Factory runtime.
- It does not read, write, or store secrets/tokens.
- Its namespace database stores only projection/cache/cursor/receipt/request metadata.
- Dark Factory Journal remains the truth source.

## Deterministic mock runtime adapter skeleton

This example includes a deterministic mock runtime adapter skeleton for product-main validation. It is projection-only and never connects to a real Dark Factory service. The runtime contract exports stable constants for `dark-factory-projection`, `dark-factory-journal`, and `runtime_observation`, plus mock projection, provider health, run-attempt, journal cursor, and rehydrate receipt shapes.

Boundary rules:

- Projection only — Dark Factory Journal remains truth source.
- The bridge/plugin database is limited to projection/cache/cursor/receipt/request metadata and is not an authoritative journal copy.
- Rehydrate/request paths return receipts and operator intention only; `terminalStateAdvanced` is always `false` and the mock adapter does not claim terminal success.
- The skeleton does not read secrets, call networks, mutate Paperclip Task/Issue primary models, or become a second Paperclip control plane.

UI surfaces must continue to show:

> Projection only — Dark Factory Journal remains truth source

## Phase 3 provider health / degraded / blocked hardening evidence

Phase 3 adds a deterministic provider runtime impact layer on top of the mock adapter. It keeps provider health as `runtime_observation` metadata and makes degraded, fallback, and blocked modes visible to API/UI operators without treating them as Paperclip Task terminal states.

Evidence boundaries:

- Provider runtime impact is advisory observation metadata: `paperclipTerminalState: "unchanged"` and `terminalStateAdvanced: false`.
- Blocked mode asks operators to pause external execution and reconcile against the Dark Factory Journal; it does not mark the Paperclip Issue/Task complete or failed.
- Degraded/fallback modes ask operators to retry, wait for provider recovery, or verify fallback projection before retry; they remain projection-only.
- API route responses include non-authoritative projection metadata (`source`, `truthSource`, `authoritative: false`) and receipt-only terminal-state guards.
- The UI displays provider state, runtime impact, operator action, and terminal-state invariants beside the projection disclaimer.

Local validation used for this evidence should include direct plugin `pnpm typecheck`, `pnpm build`, and `pnpm test` from this package directory.
