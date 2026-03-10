# Executive Layer Roadmap

Last updated: 2026-03-09

## Phase 1: Executive Results Board and durable records

Status: `done`

Delivered:

- executive board at `/briefings/board`
- durable `plan`, `result`, and `briefing` record model
- promotion flows from operational pages
- shared record detail surface

## Phase 2: Complete briefing product

Status: `done`

Delivered:

- dedicated briefing library at `/briefings/briefings`
- scheduled digests via `briefing_schedules`
- kind-specific generation rules for briefing kinds
- approval-aware decision synthesis on the board/generation path
- publish/generate controls on briefing detail

## Phase 3: Knowledge layer

Status: `done`

Delivered:

- lightweight first-party knowledge index
- publish durable results and briefings into knowledge
- dedicated `/knowledge` UI surface
- plugin-compatible lightweight design, not a full semantic layer

## Phase 4: Portfolio/program board

Status: `done`

Delivered:

- milestone model
- dedicated portfolio view at `/briefings/portfolio`
- project-level executive summary rows with health, budget, blocker, result, and decision context

## Phase 5: Ops hardening

Status: `partial`

Delivered:

- repo-backed checkout-aware workspace isolation
- visible workspace metadata on run and issue detail
- issue and portfolio pricing truthfulness improvements

Still needed:

- fuller checkout lifecycle management
- wider pricing-state propagation on every remaining cost surface
- deeper attribution normalization review across all scheduled/system flows
