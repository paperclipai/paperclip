# ADR: Seat-Centric Org Model

Status: Accepted

Date: 2026-03-31

Related work:
- `TODO-2026-001391`
- `TODO-2026-001392`
- `TODO-2026-001393`
- `TODO-2026-001394`
- `TODO-2026-001395`
- `TODO-2026-001396`
- `TODO-2026-001397`
- `TODO-2026-001398`
- `TODO-2026-001399`

Reference artifact:
- `_artifacts/paperclip-seat-model/2026-03-31-seat-model-adr.md`

## Context

Paperclip previously treated `agents.reportsTo` as the official org tree and mixed business ownership with execution identity. That breaks continuity when humans attach to and detach from roles over time.

The accepted model separates:
- `Seat`: official org, governance, and business ownership node
- `Agent`: execution identity
- `Human`: attachable operator on a seat

## Decision

### Core model

- `Seat` is the official org node and does not disappear when humans detach.
- `Agent` remains the execution/runtime identity.
- `Issue`, `Project`, `Goal`, and `Routine` business ownership moves to seat-scoped fields.
- Runtime bindings, heartbeat, API keys, and cost events remain agent-centric.

### Ownership vs execution

- Issue ownership and issue execution assignee are separate concepts.
- Ownership answers who is responsible and is seat-scoped.
- Execution answers who is currently performing work and remains agent/user scoped during compatibility.

### Runtime bindings

- Runtime adapters such as OpenClaw hang off agents, not seats.
- Seats resolve to their default/current agent for execution.

### Operating modes

- `vacant`: no active human operator
- `assisted`: active human operator present
- `shadowed`: active human operator plus active shadow agent

Mode is stored and reconciled against occupancy state.

### Permission model

- Existing principal grants remain valid.
- CEO seat occupants inherit company-operating authority.
- Non-CEO seats may delegate authority via seat metadata.

### Cost attribution

Seat cost attribution priority is:
1. `manual_override`
2. `issue_owner_seat`
3. `agent_seat`

If no deterministic attribution exists, no seat attribution row is written and the system emits an alert/log signal.

## Invariants

- One active CEO seat per company
- Seat tree must be acyclic
- Cycle prevention is mandatory on writes with a depth cap of `256`
- At most one active `primary_agent` occupancy per seat
- At most one active `human_operator` occupancy per seat
- Detach leaves business ownership on the seat and reassigns open work to the fallback/default agent when required

## Compatibility plan

### Dual-write

- Legacy agent/user ownership fields remain readable during rollout.
- New write paths dual-write seat ownership fields and compatibility fields where required.

### Read switching

- Org/read paths move from agent tree to seat tree behind compatibility-safe transitions.
- Runtime behavior remains agent-centric while business ownership becomes seat-centric.

### Portability

- Company portability exports/imports seat structure, occupancy metadata, and seat-owned references in a deterministic order.

### api-go

- `api-go` accepts seat-aware compatibility payloads while keeping legacy fields in place during migration.
- Response exposure may be gated to protect mixed-version clients.

## Consequences

- Humans can attach/detach without collapsing the official org structure.
- Budgeting and ownership become stable across occupant changes.
- Runtime integrations remain compatible because execution continues to resolve through agents.
