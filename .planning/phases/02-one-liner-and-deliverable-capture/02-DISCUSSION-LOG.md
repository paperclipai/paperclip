# Phase 2: One-Liner and Deliverable Capture - Discussion Log

> **Audit trail only.** Do not use as input to planning or execution agents.
> Decisions are captured in `02-CONTEXT.md`.

**Date:** 2026-04-24
**Phase:** 2-One-Liner and Deliverable Capture
**Mode:** `--auto`
**Areas discussed:** input loop, parser strategy, migration boundary, deliverable capture, keyboard-first access

---

## Area: Primary Input Loop

**Question:** What becomes the canonical RT2 input path in Phase 2?

**Auto choice:** `/:companyPrefix/one-liner` with a structured draft review loop
**Notes:** Phase 1 already made One-Liner the shell landing. Phase 2 should deepen that same surface instead of routing work back into Paperclip-first flows.

---

## Area: Parser Strategy

**Question:** How should Phase 2 turn freeform input into a draft?

**Auto choice:** Start deterministic and explicit, not LLM-dependent
**Notes:** The primary logging loop must stay fast, predictable, and usable on every run. LLM-backed enrichment can come later once the contract is stable.

---

## Area: Migration Boundary

**Question:** Should Phase 2 keep using `NewIssueDialog` as the final interaction?

**Auto choice:** Reuse it only as migration input, not as the long-term One-Liner surface
**Notes:** The RT2 One-Liner needs its own truthful draft UX. Reusing existing field names and helper flows is fine, but the main experience should stop feeling like a Paperclip issue dialog.

---

## Area: Deliverables and Base Price

**Question:** How visible should deliverable/economic capture be in Phase 2?

**Auto choice:** First-class on the draft surface
**Notes:** Deliverable title and base price are part of the phase goal, so they cannot be hidden behind secondary edit affordances or postponed to a later screen.

---

## Area: Shell Access

**Question:** How should operators reach the One-Liner?

**Auto choice:** Same draft flow from page route and keyboard-first shell access points
**Notes:** Page body CTA alone is too slow. Command palette and company-scoped quick create should land in the same draft experience.
