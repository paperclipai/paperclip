# Phase 7: Amoeba Economy, Collaboration, and Marketplace - Context

**Gathered:** 2026-04-25
**Status:** Ready for planning

<domain>
## Phase Boundary

Phase 7 completes the v2.0 RT2 refoundation milestone by making economy, collaboration rewards, and marketplace views come from live RT2 work evidence. The implementation must connect approved/finalized deliverable evaluation, task participation, work products, reputation rows, and marketplace listings into company-scoped operational surfaces.

</domain>

<decisions>
## Implementation Decisions

### Economic Source of Truth
- **D-01:** P&L should be reconstructed from live ledger and approved/finalized deliverable evidence. Manual income and expense endpoints may remain, but dashboard data must not depend on hand-entered shell rows.
- **D-02:** Approved deliverables count as revenue only when the quality row is active/finalized and manager-approved or auto-approved.
- **D-03:** Actor attribution uses task participants first, then issue assignee fields, so collaborative work can be split across contributors.

### Marketplace Evidence
- **D-04:** Marketplace listings should expose live performance evidence: deliverable count, average quality, reputation, pricing, and subscription count.
- **D-05:** Listing ranking may keep existing rating sort, but response payloads must include RT2 evidence so UI and API consumers can distinguish empty catalog rows from proven agents.

### Collaboration Rewards
- **D-06:** Collaboration rewards should be computable from persisted task participant + work product evidence, not only explicit UI-submitted collaboration events.
- **D-07:** Reward derivation must be company-scoped and idempotent enough for repeated reads/rebuilds to avoid duplicate collaboration events.

### the agent's Discretion
- Keep implementation focused on service/API and first-class RT2 UI surfaces. Avoid new payment flows, public marketplace scope, or large schema rewrites unless required for correctness.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Product and Roadmap
- `.planning/ROADMAP.md` - Phase 7 goal, requirements, and success criteria.
- `.planning/REQUIREMENTS.md` - ECON-02, MKT-01, and COLLAB-01 definitions.
- `AGENTS.md` - RealTycoon2 identity, economy, collaboration, marketplace, and governance rules.

### Prior Phase Contracts
- `.planning/phases/04-cqrs-event-stream-and-projections/04-CONTEXT.md` - company-scoped events and projector direction.
- `.planning/phases/05-wikillm-and-graphify-knowledge-core/05-CONTEXT.md` - knowledge evidence and graph provenance expectations.
- `.planning/phases/06-jarvis-quality-and-hybrid-search/06-CONTEXT.md` - explicit Shadow, Co-Pilot, Auto quality modes and evidence-backed AI behavior.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `server/src/services/rt2-personal-pnl.ts` - existing P&L and coin ledger service.
- `server/src/services/rt2-collaboration-rewards.ts` - existing reward and collaboration event service.
- `server/src/services/rt2-agent-marketplace.ts` - existing listing, BYOA, and subscription service.
- `issueWorkProducts`, `rt2QualityScores`, `rt2V33TaskProfiles`, and `rt2V33TaskParticipants` - live RT2 evidence tables needed for Phase 7.

### Established Patterns
- RT2 routes are company-scoped and call `assertCompanyAccess`.
- Embedded Postgres tests seed companies/projects/issues/work products directly and mount only the relevant routes.
- RT2 UI pages use React Query and `ui/src/api/*` wrappers for company-scoped API reads.

### Integration Points
- P&L route: `/companies/:companyId/rt2/pnl` and `/summary`.
- Marketplace route: current public listing routes plus company-scoped listing creation/subscription routes.
- Collaboration rewards route: `/companies/:companyId/rt2/collaboration/*`.

</code_context>

<specifics>
## Specific Ideas

No separate user-selected variants. `--auto` chose ledger/evidence-backed defaults aligned with the roadmap and AGENTS.md.

</specifics>

<deferred>
## Deferred Ideas

- Public/open external marketplace beyond trusted company ecosystems remains out of scope.
- Real billing, payment settlement, and native mobile economy surfaces remain out of scope for this phase.

</deferred>

---

*Phase: 07-amoeba-economy-collaboration-and-marketplace*
*Context gathered: 2026-04-25*
