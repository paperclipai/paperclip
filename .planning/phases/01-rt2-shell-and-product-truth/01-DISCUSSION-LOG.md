# Phase 1: RT2 Shell and Product Truth - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in `01-CONTEXT.md` — this log preserves the alternatives considered.

**Date:** 2026-04-24
**Phase:** 1-RT2 Shell and Product Truth
**Mode:** `--auto --chain`
**Areas discussed:** landing route, primary navigation taxonomy, knowledge composition, Paperclip boundary, route promotion/hiding, One-Liner reuse

---

## Area: Landing Route

**Question:** What should the default company landing route be once RT2 becomes the primary shell?

| Option | Description | Recommended |
|--------|-------------|-------------|
| `/:companyPrefix/one-liner` | Make low-friction capture the first operator landing and let the shell grow from RT2 work entry | Yes |
| `/:companyPrefix/dashboard` | Keep the current Paperclip dashboard as the first landing and only relabel nav | |
| `/:companyPrefix/projects/:id` | Make project detail the entry point and keep RT2 nested under project tabs | |

**Auto choice:** `/:companyPrefix/one-liner`
**Notes:** The roadmap explicitly says the default landing must become an RT2 shell, and the codebase already has reusable RT2 capture flow through `NewIssueDialog` plus `DialogContext`.

---

## Area: Primary Navigation Taxonomy

**Question:** Which routes become first-class navigation in Phase 1?

| Option | Description | Recommended |
|--------|-------------|-------------|
| `One-Liner`, `Knowledge`, `Marketplace`, `P&L`, `Org`, `Governance` | Match the milestone requirements and RT2 positioning directly | Yes |
| Keep Paperclip nav and add RT2 items below it | Lower implementation cost, but product identity remains Paperclip-first | |
| Promote only `One-Liner` and `Knowledge` now, defer the rest | Smaller slice, but fails the stated Phase 1 success criteria | |

**Auto choice:** `One-Liner`, `Knowledge`, `Marketplace`, `P&L`, `Org`, `Governance`
**Notes:** `IDENT-01` names this navigation set directly, so anything narrower would undercut the milestone.

---

## Area: Knowledge Composition

**Question:** How should existing RT2 daily/wiki/graph capabilities appear in the new shell?

| Option | Description | Recommended |
|--------|-------------|-------------|
| Single `Knowledge` route with internal subviews for daily, wiki, and graph | Promotes one RT2 concept while reusing existing brownfield panels | Yes |
| Separate primary nav items for daily, wiki, and graph | Exposes implementation fragments instead of a coherent product concept | |
| Keep them only inside `ProjectDetail` tabs | Preserves current nesting and fails the shell reframing goal | |

**Auto choice:** Single `Knowledge` route with internal subviews
**Notes:** The code already has separate panels; this phase should compose them into a product surface instead of multiplying top-level nav items.

---

## Area: Paperclip Boundary

**Question:** What happens to existing Paperclip pages after RT2 becomes the primary shell?

| Option | Description | Recommended |
|--------|-------------|-------------|
| Keep them reachable through a secondary control-plane path that preserves company context | Preserves useful operator/admin depth without letting it define the product shell | Yes |
| Leave all current Paperclip pages in the primary nav beside RT2 routes | Easiest transition, but keeps the app Paperclip-first | |
| Hide most legacy screens entirely | Breaks operator workflows and removes useful brownfield capability | |

**Auto choice:** Secondary control-plane path with company-preserving links
**Notes:** `IDENT-02` requires movement into underlying Paperclip views without losing company context. Demotion, not deletion, matches that requirement.

---

## Area: Promotion and Hiding

**Question:** Which current routes should be promoted or hidden in Phase 1?

| Option | Description | Recommended |
|--------|-------------|-------------|
| Promote Marketplace/P&L/Org/Governance, hide lab routes from primary nav, keep stub-heavy collaboration/quality/rewards contextual only | Promotes truthful RT2 surfaces while avoiding fake product depth | Yes |
| Promote every existing RT2 tab to top-level nav | Creates a broad but misleading shell because several panels are stub-backed | |
| Keep everything where it is and only restyle labels | Minimal churn, but does not change the product truth | |

**Auto choice:** Promote truthful surfaces, hide lab routes, keep stub-heavy panels contextual only
**Notes:** `Rt2CollaborationPanel`, `Rt2QualityPanel`, and `rt2-collaboration` service still depend on stub or placeholder data, while marketplace/P&L/governance already have real route surfaces.

---

## Area: One-Liner Reuse Strategy

**Question:** How should Phase 1 expose the new One-Liner without duplicating unfinished Phase 2 logic?

| Option | Description | Recommended |
|--------|-------------|-------------|
| Reuse `NewIssueDialog` and `DialogContext` as the first One-Liner entry point | Reuses current RT2-aware capture path and keeps Phase 1 focused on shell truth | Yes |
| Build a brand-new freeform parser and draft composer now | Pulls Phase 2 work into Phase 1 and expands scope sharply | |
| Make One-Liner a static placeholder page with no capture action | Satisfies routing but fails the operator loop | |

**Auto choice:** Reuse `NewIssueDialog` and `DialogContext`
**Notes:** Existing RT2 defaults already support task/todo mode, deliverable title, and capacity. Phase 2 can deepen parsing without replacing the shell decision.

---

## the agent's Discretion

- Exact page layout and typography for the new RT2 pages
- The final label for the secondary Paperclip path (`Control Plane`, `Back Office`, or similar)
- Mobile prioritization and overflow handling once six RT2 routes become primary
- Whether the first One-Liner page uses an inline composer, a launcher card, or both

