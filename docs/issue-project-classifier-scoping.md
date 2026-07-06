# One-click project auto-classification: scoping (rules vs. model)

**Goal:** a one-click action that suggests a project for an *unclassified* issue
(`issues.project_id IS NULL`) and applies it with a single click, with manual
override always available.

---

## Recommendation (TL;DR)

**Ship a deterministic rules/heuristic engine first (v1); add an optional LLM
tie-breaker later as a bounded escalation — not as the primary path.**

Rationale, grounded in evaluation on a real small-fleet workspace (5 projects,
13 unclassified issues at time of writing):

1. **Cost & latency.** The rules engine is a pure function — zero marginal cost,
   sub-millisecond, runs inline on the issues list. An LLM call per unclassified
   issue is a recurring spend and a latency/availability dependency for a
   *low-priority convenience* feature.
2. **Explainability builds one-click trust.** The heuristic returns the exact
   `matchedTerms` that drove the suggestion ("Overlaps on: os, ai, sandbox").
   A user will not one-click-apply a black-box label; they will one-click an
   explained one.
3. **Determinism is testable & safe.** Same inputs → same suggestion. The engine
   is fully unit-tested and degrades safely (see precision below).
4. **The data is small.** A handful of projects is a k-way classification with
   strong lexical anchors (project names are usually descriptive). This is
   squarely in heuristic territory; a model is overkill until project count and
   semantic ambiguity grow.

An LLM earns its place **only** as an escalation for the residual ambiguous
cases (near-ties), behind a flag, with the heuristic as the always-on default.

---

## The heuristic engine

`server/src/services/issue-project-classifier.ts` — pure, dependency-free.

- **Per-project term profile** from project name (×3), description (×2), and the
  text of issues already filed under it (title ×1, desc ×0.5, capped).
- **TF-IDF-style weighted overlap** between the issue text (title ×2, desc ×1)
  and each project profile. IDF across project profiles suppresses ubiquitous
  boilerplate ("review", "fix", "runs"), so generic terms don't dominate.
- **Saturating anchor weight** `pw/(pw+2) ∈ [0,1)` so a project can't win purely
  by anchor volume, and the final **score is bounded in [0,1]**.
- **Unicode-aware tokenizer** — keeps Hangul and other non-Latin scripts, so
  non-English issues and projects classify too.
- **Conservative one-click gate:** a pre-selected default is offered only when the
  top score clears a floor (`minScore`) **and** beats the runner-up by a margin
  (`minMargin`). Otherwise the UI shows ranked options with **no** default —
  ambiguity degrades to manual pick, never a confident-but-wrong auto-apply.
- Excludes archived/paused projects and configurable catch-all buckets (e.g. an
  "Uncategorized / Done" tracker project) from suggestions.

### Evaluation profile (13 live unclassified issues, 5 projects)

| Outcome | Count | Behavior |
|---|---|---|
| Confident one-click default | 6/13 | Top suggestion clears floor + margin |
| Ranked options, no default | 7/13 | Near-tie / weak signal → manual pick |

Representative outcomes:

- An adapter-runtime bug ("…adapter … terminal disposition") → the agent-ops
  project (0.44); matched terms: run, adapter, disposition.
- A sandboxing spike ("launcher wrapper forces sandbox flag") → the OS/PoC
  project (0.29); matched terms: os, sandbox.
- A Korean-language legal-track issue matched on Korean terms (0.20), showing
  the Unicode tokenizer working end-to-end.
- A cross-cutting security chore ("Rotate leaked API key") scored a near-tie
  (0.28 vs 0.26) → **no default**, shown as ranked options. (Correct: a
  cross-cutting task has no clear home; forcing a guess would erode trust.)

This is the intended profile: **high-precision auto-suggest where the signal is
clear, graceful manual fallback where it isn't** — not maximal coverage.

---

## Delivery phases

- **Phase 1:** classifier module + unit tests.
- **Phase 2:** `GET /api/issues/:id/project-suggestions` endpoint — loads company
  projects + anchor issues, returns ranked suggestions + `topConfident`.
- **Phase 3:** UI — on an unclassified issue, a one-click suggestion chip
  pre-filled with `topConfident` (with the matched-term "why"), plus a dropdown
  of ranked alternatives for manual override. Apply = existing
  `PATCH /api/issues/:id { projectId }` (no new mutation surface needed).
- **Phase 4 (optional, flagged):** LLM tie-breaker invoked *only* for the
  no-confident-default residual, returning a choice constrained to the candidate
  project ids. Off by default; opt-in per company.

## Open questions

1. Should one-click apply also be allowed in **bulk** (classify all confident
   unclassified issues at once), or strictly per-issue?
2. Which catch-all/tracker projects should be excluded from suggestions by
   default, and where is that configured?
