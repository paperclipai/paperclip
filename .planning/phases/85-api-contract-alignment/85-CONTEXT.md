# Phase 85: API Contract Alignment - Context

**Gathered:** 2026-05-04
**Status:** Ready for planning
**Mode:** Auto-generated (discuss skipped via workflow)

<domain>
## Phase Boundary

API contract alignment — REST/WebSocket API가 RT2-native operation contract를 따르고, versioning strategy와 backward compatibility를 정의한다.

Requirements: API-01 (RT2-native API contracts), API-02 (semantic versioning + breaking change policy), API-03 (backward compatibility + migration path)

</domain>

<decisions>
## Implementation Decisions

### API Contract Structure
- **D-01:** API contracts use RT2-native operation types (task.created, execution.dispatched, etc.) as event-first design
- **D-02:** REST endpoints follow resource-based URL structure: `/api/rt2/tasks`, `/api/rt2/executions`
- **D-03:** WebSocket events mirror REST event types for real-time consistency

### Versioning Strategy
- **D-04:** Semantic versioning (MAJOR.MINOR.PATCH) — breaking changes bump MAJOR
- **D-05:** API base path includes version: `/api/v1/rt2/...` — v1 is initial RT2 contracts
- **D-06:** Breaking change policy: deprecation header + 2-minor-version sunset window

### Backward Compatibility
- **D-07:** Response envelope is stable — `{data, meta, error}` shape unchanged in v1
- **D-08:** New optional fields added without breaking existing clients
- **D-09:** Migration path documented per endpoint — fallbacks for removed fields

### the agent's Discretion
- Exact route structure and middleware ordering
- Error response format details (beyond envelope)
- Rate limiting and pagination conventions

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- RT2 domain event types already defined in `packages/shared/src/types/rt2-domain-events.ts`
- Execution attempt state machine in `packages/db/src/schema/rt2_v33_execution_attempts.ts`
- Existing API routes in `server/src/routes/` — can be extended

### Established Patterns
- API response envelope: `{data, meta, error}`
- Auth via Bearer token in Authorization header
- Company-scoped endpoints — `companyId` from JWT context

### Integration Points
- WebSocket service for live events (`server/src/services/rt2-domain-events.ts`)
- Execution service for task operations
- Knowledge projector for search/filter

</code_context>

<specifics>
## Specific Ideas

- API contracts must cover: task CRUD, execution lifecycle, deliverable management, knowledge operations
- Version negotiation via Accept header: `Accept: application/vnd.rt2.v1+json`
- Breaking changes require deprecation notice in response headers

</specifics>

<deferred>
## Deferred Ideas

- GraphQL API surface (future phase)
- gRPC migration path (out of scope for v3.4)

</deferred>

---

*Phase: 85-api-contract-alignment*
*Context gathered: 2026-05-04*
