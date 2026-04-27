# Phase 21: Obsidian Bidirectional Knowledge Sync - Context

**Gathered:** 2026-04-25  
**Status:** Ready for planning

<domain>
## Phase Boundary

Phase 21 upgrades the existing Knowledge Bridge from export/import preview into an operator-approved bidirectional sync workflow. RT2 remains the source of truth. Obsidian-compatible markdown is an inspection and local-edit surface; only approved import candidates and explicit conflict decisions may write back into RT2-controlled wiki/graph storage.

</domain>

<decisions>
## Implementation Decisions

### Source of Truth
- **D-01:** RT2 DB, event projector, wiki pages, graph nodes, graph edges, and audit records remain canonical.
- **D-02:** Local vault paths and markdown files are not treated as high-contention business truth.

### Writer Flow
- **D-03:** Vault writer settings store `vaultName`, root path, export folder, writer mode, export target path, and dry-run result.
- **D-04:** Web runtime exposes a dry-run contract first; actual local filesystem writes remain guarded because a server cannot safely write an operator's desktop vault without an approved local bridge.

### Import and Conflict Flow
- **D-05:** Import preview must split changes into `wiki_page`, `graph_node`, and `graph_edge` candidates.
- **D-06:** Only approved import candidates apply to RT2-controlled storage.
- **D-07:** Vault wikilinks import as `AMBIGUOUS` graph relationships until reviewed.
- **D-08:** Conflicts resolve through `rt2_wins`, `vault_wins`, or `manual_merge`, with decision reason and audit id.

### the agent's Discretion
- UI layout, candidate defaults, and fallback route coverage may follow existing `Knowledge > Bridge` patterns.

</decisions>

<canonical_refs>
## Canonical References

### Product Direction
- `.planning/ROADMAP.md` - Phase 21 goal and success criteria.
- `.planning/REQUIREMENTS.md` - `KNOW-02`, `KNOW-03`, `KNOW-04`.
- `AGENTS.md` - RT2 source-of-truth and wikiLLM/Graphify rules.

### Prior Knowledge Work
- `.planning/phases/17-knowledge-bridge-completion/17-VALIDATION.md` - Phase 17 residual risk explicitly assigns local writer and conflict resolution to Phase 21.
- `.planning/DEVPLAN-ALIGNMENT.md` - Knowledge gap and alignment status.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `server/src/services/rt2-knowledge-projector.ts` already owns wiki projection, vault export, and import preview parsing.
- `server/src/routes/rt2-knowledge.ts` already exposes company-scoped knowledge routes.
- `ui/src/pages/rt2/KnowledgePage.tsx` already has the `Bridge` tab, projection action, vault export, import preview, and graph evidence.

### Established Patterns
- Company-scoped route access uses `assertCompanyAccess`.
- Shared contracts live in `packages/shared/src/types/rt2-knowledge.ts` and `packages/shared/src/validators/rt2-knowledge.ts`.
- Important mutations should log activity.

### Integration Points
- Add schema for vault settings and sync decisions under `packages/db/src/schema`.
- Extend the knowledge service with writer settings, dry-run, import apply, and conflict resolution.
- Extend the Bridge UI rather than creating another page.

</code_context>

<specifics>
## Specific Ideas

Obsidian compatibility means markdown frontmatter remains inspectable, but RT2 controls the actual write-back and graph confidence. Vault-imported wikilinks must not be presented as verified facts.

</specifics>

<deferred>
## Deferred Ideas

- A desktop/local bridge daemon that physically writes files into an operator machine's Obsidian vault.
- File watcher based continuous sync.

</deferred>

---

*Phase: 21-obsidian-bidirectional-knowledge-sync*  
*Context gathered: 2026-04-25*
