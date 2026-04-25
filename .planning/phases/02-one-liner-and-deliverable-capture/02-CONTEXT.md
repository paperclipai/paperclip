# Phase 2: One-Liner and Deliverable Capture - Context

**Gathered:** 2026-04-24
**Status:** Ready for planning

<domain>
## Phase Boundary

Turn the RT2 One-Liner from a shell entry point into the primary work-input loop. This phase covers freeform input capture, draft structuring, deliverable/base-price capture, and keyboard-first access. It does not yet introduce the full append-only CQRS event stream, Multica runtime execution, or knowledge graph projection rebuilds.

</domain>

<decisions>
## Implementation Decisions

### Input and capture model
- **D-01:** The company-level `/:companyPrefix/one-liner` route becomes the canonical entry point for RT2 work logging.
- **D-02:** One input submission must produce a structured draft that covers task/todo intent, daily-log text, deliverable title, and base-price fields before commit.
- **D-03:** Phase 2 keeps a human review step before commit. The One-Liner does not silently persist final RT2 records on first parse.

### Parser strategy
- **D-04:** Phase 2 starts with a deterministic parser and explicit field extraction rather than depending on a remote LLM call to make the primary input loop usable.
- **D-05:** Ambiguous input is allowed, but the draft must surface the ambiguity clearly instead of fabricating high-confidence structure.
- **D-06:** The resulting draft contract should be able to evolve into command/event writes in Phase 4 without changing the main UI entry flow again.

### Reuse and reconstruction
- **D-07:** Reuse existing RT2 capture primitives only where they still match the new draft contract; do not keep `NewIssueDialog` as the long-term core if it forces Paperclip-shaped fields.
- **D-08:** Introduce a dedicated RT2 One-Liner draft surface instead of routing the final interaction back through the legacy issue dialog once the parser exists.
- **D-09:** Selective reuse is still preferred underneath: company scoping, issue/task persistence helpers, and existing RT2 field names can be reused if they remain truthful.

### Deliverables and economics
- **D-10:** Deliverable definition is first-class in Phase 2. The user must be able to capture deliverable title and base-price data from the first draft review surface.
- **D-11:** Base-price capture can be nullable only when the user explicitly leaves it unset; it must not disappear because parsing failed to notice it.
- **D-12:** The Phase 2 output remains a draft/commit loop, not a full ledger-backed economic system. Ledger truth stays in later phases.

### Shell behavior
- **D-13:** The One-Liner must be reachable through keyboard-first affordances from the RT2 shell, not only by clicking into a page body CTA.
- **D-14:** The same One-Liner draft flow should work from the main page, command palette, and any company-scoped quick-create entry without diverging behavior.

### the agent's Discretion
- Exact parsing heuristics and phrasing rules for the first deterministic draft engine
- Whether the draft UI is inline on the page, modal-first, or split-panel, as long as keyboard-first flow stays fast
- Whether deliverable/base-price fields appear in a compact summary row or a richer review card

</decisions>

<specifics>
## Specific Ideas

- A One-Liner input should feel closer to “log what happened / what will happen / what this produces” than to filing a Paperclip issue.
- The draft should prefer a compact review loop over a large multi-section form.
- Deterministic parsing is acceptable if it keeps the flow fast and trustworthy; fake intelligence is not.
- Phase 2 should produce a stable draft contract that can later become a command/event input without rebuilding the UI again.

</specifics>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Milestone source of truth
- `.planning/PROJECT.md`
- `.planning/REQUIREMENTS.md`
- `.planning/ROADMAP.md`
- `.planning/STATE.md`
- `.planning/phases/01-rt2-shell-and-product-truth/01-CONTEXT.md`
- `.planning/phases/01-rt2-shell-and-product-truth/02-SUMMARY.md`

### Product and repo constraints
- `AGENTS.md`
- `doc/PRODUCT.md`
- `doc/SPEC-implementation.md`

### Current RT2 shell and capture code
- `ui/src/pages/rt2/OneLinerPage.tsx`
- `ui/src/components/NewIssueDialog.tsx`
- `ui/src/context/DialogContext.tsx`
- `ui/src/components/CommandPalette.tsx`
- `ui/src/lib/company-routes.ts`
- `ui/src/App.tsx`

### RT2 and issue/domain assets that may be reused
- `packages/shared/src/*`
- `server/src/routes/*`
- `server/src/services/*`
- `packages/db/src/schema/*`

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- The RT2 shell route already exists and is now the canonical landing path.
- `NewIssueDialog` and `DialogContext` are useful migration assets for field naming, company-scoped creation, and quick-launch behavior.
- Existing RT2 page chrome and command palette integration can host the new draft flow without reopening shell routing work.

### Established Patterns
- Company-prefixed routes remain canonical.
- Global quick actions are already exposed through shared shell context/providers.
- Brownfield backend/domain assets are safest to reuse when they preserve company scope and audit expectations.

### Integration Points
- `ui/src/pages/rt2/OneLinerPage.tsx` should become the main draft interaction surface.
- `ui/src/components/NewIssueDialog.tsx` is the main migration source for existing RT2 fields and current capture defaults.
- `ui/src/components/CommandPalette.tsx` and shell chrome should expose the same One-Liner flow.
- `packages/shared`, `server`, and `packages/db` must stay synchronized if draft/persisted contracts change.

</code_context>

<deferred>
## Deferred Ideas

- Multica-backed execution lifecycle linkage — Phase 3
- Append-only command/event write model and projectors — Phase 4
- wikiLLM/Graphify cumulative knowledge projection — Phase 5
- Jarvis/search/quality truthfulness — Phase 6
- Amoeba ledger/marketplace operationalization — Phase 7

</deferred>

---

*Phase: 02-one-liner-and-deliverable-capture*
*Context gathered: 2026-04-24*
