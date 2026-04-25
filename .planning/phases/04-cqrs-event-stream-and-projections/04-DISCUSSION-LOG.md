# Phase 4: CQRS Event Stream and Projections - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in `04-CONTEXT.md`.

**Date:** 2026-04-24T14:30:00+09:00
**Phase:** 04-cqrs-event-stream-and-projections
**Mode:** auto
**Areas analyzed:** Event stream ownership, event contract, projector model, read model scope, mutation integration

## Auto-Selected Decisions

### Event stream ownership

| Option | Description | Selected |
|--------|-------------|----------|
| Dedicated RT2 domain event stream | Durable append-only source of truth for RT2 writes | yes |
| Reuse activity log as source of truth | Faster but mixes audit/feed semantics with domain events | no |
| Reuse plugin/live event bus | Not durable or replay-oriented enough for CQRS | no |

**Selected:** Dedicated RT2 domain event stream.
**Reason:** Phase 4 requires replayable source-of-truth writes, not only notification or activity feed records.

### Event contract

| Option | Description | Selected |
|--------|-------------|----------|
| Versioned shared event payloads | Keeps DB, server, API, and projector contracts synchronized | yes |
| Loose JSON payloads only | Faster but weakens replay safety and downstream planning | no |

**Selected:** Versioned shared event payloads with idempotency/correlation fields.

### Projector model

| Option | Description | Selected |
|--------|-------------|----------|
| Explicit checkpoints and processed-event tracking | Supports replay/resume without duplicate side effects | yes |
| Fire-and-forget route updates | Current pattern, but not sufficient for CQRS | no |

**Selected:** Explicit projector checkpoint and processed-event state.

### Read model scope

| Option | Description | Selected |
|--------|-------------|----------|
| First-slice projectors over existing RT2 read models | Proves CQRS without completing future knowledge/economy systems | yes |
| Full wikiLLM/Graphify/economy implementation now | Scope creep into Phases 5 and 7 | no |

**Selected:** Implement replay-safe projection surfaces and simple existing read-model updates only.

### Mutation integration

| Option | Description | Selected |
|--------|-------------|----------|
| Wrap RT2 write services | Keeps event semantics close to business mutations | yes |
| Keep route-level publish calls as business events | Duplicates event logic and weakens source-of-truth boundary | no |

**Selected:** Integrate through `rt2TaskEngineService` and `rt2TaskExecutionService`; route-level live events become outputs/bridges.

## Deferred Ideas

- Full wikiLLM cumulative page generation and Graphify inference are deferred to Phase 5.
- Jarvis/search/quality intelligence over projected knowledge is deferred to Phase 6.
- Complete amoeba reward and marketplace economics are deferred to Phase 7.
