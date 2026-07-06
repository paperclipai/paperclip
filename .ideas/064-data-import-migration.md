# 064 — Data Import / Migration from Existing Tools

## Suggestion

Paperclip can import/export its **own** company format (`company-portability.ts`), but a code scan
finds no way to bring in work from the tools teams already use — Jira, Linear, Asana, Trello,
GitHub Issues, or a plain CSV. For anyone evaluating Paperclip, this is a hard adoption wall: their
existing backlog, projects, and history live elsewhere, and "start from an empty board and
re-create everything by hand" is a non-starter. The fastest path to value for a new user is to see
*their own work* running in Paperclip on day one.

Add **data import/migration**: map issues/projects/structure from common PM tools (and generic CSV)
into Paperclip companies, so teams can onboard their real backlog instead of starting cold.

## How it could be achieved

1. **Importers per source.** A small adapter per tool (Jira, Linear, Asana, GitHub Issues, Trello,
   CSV) that pulls issues, statuses, hierarchy, assignees, and comments via the source's API/export.
   Best delivered through the **plugin system** so importers can ship and evolve independently of
   core.
2. **Map to Paperclip's model.** Translate source concepts into Paperclip's: issues → issues,
   epics/parents → parent issues (preserving the goal-tree invariant), statuses → Paperclip
   statuses, human assignees → a placeholder/agent mapping the operator confirms. Reuse the
   portability deserialization path (`company-portability.ts`) as the write target so import lands
   through one validated seam.
3. **Assignee/agent mapping.** Since Paperclip employees are agents, imported human assignees map to
   either a "needs staffing" marker (which can auto-open a job posting, idea 048) or a chosen agent —
   an explicit step in the import wizard.
4. **Dry-run + preview.** Show what *will* be created (counts, hierarchy, any unmapped fields) before
   committing — reuse the Dry-Run philosophy (idea 004) so a big import isn't a blind, irreversible
   dump. Make the import atomic and reversible (snapshot first, idea 015).
5. **Incremental sync (later).** Optional ongoing one-way sync for teams migrating gradually, so
   Paperclip can run alongside an existing tool during a transition rather than requiring a hard
   cutover.

## Perceived complexity

**Medium.** The write target (validated company deserialization) already exists, so the work is
per-source extraction + field mapping + an import wizard, not new core machinery. Each importer is
moderate and independent (ship the highest-demand source first; CSV is the cheapest universal
fallback). The genuinely tricky parts are faithful hierarchy/status mapping across tools with
different models, the human→agent assignee gap (unique to Paperclip), and idempotent re-import.
One-time import is very achievable; incremental two-way sync is a much larger, later undertaking and
should be scoped as one-way to start.
