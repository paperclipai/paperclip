# Phase 6: Jarvis, Quality, and Hybrid Search - Context

**Gathered:** 2026-04-25
**Status:** Ready for planning and execution

<domain>
## Phase Boundary

Phase 6 replaces RT2 assistant, quality, and search placeholder behavior with company-scoped, evidence-backed behavior over live RT2 task, wiki, graph, deliverable, and quality records.

</domain>

<decisions>
## Implementation Decisions

### Jarvis Grounding
- **D-01:** Jarvis answers must be grounded in company-scoped RT2 task profiles, todos, deliverables, cumulative wiki pages, graph nodes, and quality evidence.
- **D-02:** Task advice and breakdown endpoints must be company-scoped route surfaces, not global task-id-only shortcuts.

### Quality Modes
- **D-03:** Quality evaluation supports `shadow`, `copilot`, and `auto` as explicit request modes.
- **D-04:** Shadow mode stores evidence only; Co-Pilot mode stores manager-pending approval; Auto mode can approve inside the configured base-price band.

### Hybrid Search
- **D-05:** Search combines lexical matching with deterministic domain reranking across documents, cumulative wiki pages, tasks, deliverables, graph nodes, and graph edges.
- **D-06:** Results expose evidence explaining why an item ranked, so operator-facing screens are not opaque placeholder responses.

### the agent's Discretion
The implementation can use deterministic retrieval and reranking for this phase. External embedding or LLM reranker integration is deferred until the local evidence path is stable.

</decisions>

<canonical_refs>
## Canonical References

### Project Direction
- `.planning/ROADMAP.md` - Phase 6 scope and success criteria.
- `.planning/REQUIREMENTS.md` - `JARV-01`, `QUAL-01`, `QUAL-02`.
- `AGENTS.md` - RealTycoon2 identity, knowledge, Jarvis, approval, and search governance rules.

### Prior Phase Inputs
- `.planning/phases/05-wikillm-and-graphify-knowledge-core/05-SUMMARY.md` - cumulative wiki and graph projection contracts created in Phase 5.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `rt2V33TaskProfiles`, `issues`, `issueWorkProducts` - live RT2 task, todo, and deliverable evidence.
- `rt2V33WikiPages` - Phase 5 cumulative wiki pages.
- `rt2V33GraphNodes`, `rt2V33GraphEdges` - Phase 5 graph evidence.
- `rt2QualityScores`, `rt2BasePrices` - existing quality and base-price model.
- `rt2SearchIndex`, `rt2SearchLog` - search telemetry and index metadata.

### Integration Points
- `server/src/services/rt2-jarvis.ts`
- `server/src/services/rt2-auto-evaluation.ts`
- `server/src/services/rt2-hybrid-search.ts`
- `server/src/routes/rt2-jarvis.ts`
- `server/src/routes/rt2-auto-evaluation.ts`
- `server/src/routes/rt2-hybrid-search.ts`

</code_context>

<specifics>
## Specific Ideas

Operator-visible intelligence should cite live RT2 evidence instead of returning empty arrays or generic summaries.

</specifics>

<deferred>
## Deferred Ideas

- External embedding generation and LLM reranking can become a later enhancement once deterministic hybrid retrieval is stable.

</deferred>

---

*Phase: 06-jarvis-quality-and-hybrid-search*
*Context gathered: 2026-04-25*
