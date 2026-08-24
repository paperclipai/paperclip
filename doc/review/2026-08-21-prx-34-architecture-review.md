# PRX-34: Architecture Review — M&A Pipeline Decision-Support Platform

**Reviewer:** CTO (Agent 47a4a604)
**Date:** 2026-08-21
**Document Sources Reviewed:**
- `STARTINGPOINT.md` v0.2.0 — Full product spec with 10 architecture decisions
- `PROJECT-DESCRIPTION.md` — Condensed project description for build planning
- `docs/ma-pipeline-operating-manual.md` v1.0 — Domain narrative (16 stages, 13 gates)
- `AGENTS.md` — Project-level agent guidelines

---

## 1. Architecture Decisions Review

The architecture document defines 10 interview-driven decisions (AD-1 through AD-10) that supersede an earlier self-interview extraction. These replaced the original D1-D9 numbering from the PROJECT-DESCRIPTION. I have reviewed both sets.

### AD-1 / D1: Multi-dimensional candidate comparison as core value prop

**Assessment:** Sound.

Security is the founder's lens, but the tool correctly generalizes to ALL dimensions (financial, legal, governance, compliance, operational). This prevents the tool from being a one-trick security screener and makes it a genuine decision-support platform. The decision to keep security as one risk bucket inside a unified scoring model rather than a separate track avoids the architectural trap of building bespoke evaluation paths per dimension.

**Concern:** The "all dimensions equal" framing could inadvertently underweight security in the UI if not carefully designed. The two-axis model (fit vs. risk) naturally elevates risk as a first-class axis regardless of which dimension contributes to it, which mitigates this concern. No change requested.

### AD-2 / D2: Dimension-agnostic assessment engine

**Assessment:** Sound — this is the right architectural choice.

Making assessments data rather than code is the key insight that keeps the system extensible without rewrites. Workstream → Assessment → Question Tree → Questions is a clean hierarchy that maps well to both the domain model and a database schema (JSONB for flexible tree structures).

**Recommendation:** Add versioning to assessment templates. If the security question bank is updated between deals, existing assessments-in-progress should reference the version they were started against. This is not a v1 blocker but should be in the roadmap.

### AD-3: Multi-candidate from the start

**Assessment:** Sound.

Designing for N candidates from day one avoids a painful migration when the second candidate arrives mid-deal. The single-candidate case is just N=1; no special-casing needed. The comparison dashboard already assumes N candidates, so the data model and API should follow suit.

### AD-4 / D3: Tree-based adaptive assessment with two-source answering

**Assessment:** Sound.

Skip logic (questions open only when a prior gating question indicates risk) is essential for a workable UX — a flat 200-question security survey would never be completed. The two-source model (seller ASSERTION vs. expert EVIDENCE) correctly encodes the manual's Rule #4 as a first-class data concept rather than a process discipline.

**Design question:** How is "undetermined" resolved — does the assessment block completion until all questions reach pass/fail, or can it be submitted with undetermined items (which would lower confidence)? The spec suggests the latter (confidence drops when assertion and evidence conflict), but this should be explicit in the data model. No change requested for v1, but clarify during build.

### AD-5: Research is the question bank

**Assessment:** Sound.

Grounding the security assessment in three parallel research reports (~28 risk categories, ~40 red-flag signals, each tied to a real case) gives the tree evidentiary weight. The five-branch structure (Breach History, People & Governance, Technology & Infrastructure, Compliance & Regulatory, Contracts & Insurance) covers the major risk surfaces. The anchor-cases approach (Yahoo, Marriott, Equifax, etc.) provides concrete scoring anchors.

**Minor concern:** The research was conducted before the live interview; the question tree needs to be validated against the manual's Stage 12 diligence workstreams (W1-W8) to ensure no gaps. Open question OQ-4 (who authors the full question tree) should be resolved before build phase B begins.

### AD-6: Workstream → Assessment → Question-Tree hierarchy

**Assessment:** Sound.

This hierarchy cleanly decomposes the domain. W7 (IT/Security) holding both a security assessment and a separate IT-focused assessment is a good design — they evaluate different risk surfaces under the same workstream.

**Recommendation:** Ensure the data model supports an assessment belonging to exactly one workstream (not shared), and that workstream weights (established in Phase 2) apply identically across candidates. This is implied by AD-8 but should be enforced at the schema level.

### AD-7: Build order A → B → C

**Assessment:** Sound.

The build order correctly fronts the user-visible shell (intake) before the engine (assessment) before the payoff (dashboard). This is pragmatic sizing for a live client deal. The assessment engine is correctly positioned as the "plumbing" that enables the dashboard.

**Risk:** If the dashboard (C) proves harder than estimated, the live deal may be usable with just intake + assessment (A + B) while C is completed. The architecture should support this — the assessment data model should be accessible via API even before the comparison dashboard is built.

### AD-8 / D1 rev: Two-phase scoring, two-axis comparison

**Assessment:** Sound.

This is the most architecturally significant decision and it is correct. The two-axis model (Phase 1 business fit as a ceiling, Phase 2 risk as an independent incrementing axis) avoids the common mistake of collapsing two fundamentally different dimensions into one number. The semantic 2×2 quadrant (Proceed / Strong-but-dangerous / Safe-but-wrong / Walk) makes the tradeoff visible rather than hidden.

**Design integrity check:** The "only one 10" rule and the "drop requirements that don't differentiate" rule are critical to making the scores meaningful. These must be enforced at the computation layer, not just recommended in the UI. If the business logic can produce two 10s on the same requirement, the entire scoring model breaks.

**Minor concern:** The cross-candidate bias detection (text interpretation to compare expert scores across candidates) is described as a feature but has no spec for how it works. This is ambitious for v1 and could produce false positives that undermine confidence. Recommend deferring automated bias detection to v1.1 and surfacing raw scores side-by-side for human comparison in v1.

### AD-9: API-first web app, local-first today, container-deployed tomorrow

**Assessment:** Sound.

Next.js/React for the primary web app, with a clean REST API for future Flutter mobile client, is a pragmatic stack choice. The "local now, container later" deployment model matches the live-deal urgency.

**Concern:** The architecture mentions "dedicated Obsidian vault (filesystem) — mounted directory". This coupling to a local filesystem Obsidian vault complicates container deployment significantly. Either:
1. The vault path must be a configurable volume mount (not hardcoded), or
2. The vault integration should be abstracted behind an interface so a cloud-backed note store can replace it later, or
3. The vault requirement should be re-examined — is Obsidian integration a v1 necessity, or can it be deferred to v1.1?

The spec says the vault path is "hardcoded + validated on startup" which is fragile. **Change request:** Make the vault path a configuration value (environment variable or config file), not a compile-time constant. Validate it at startup but allow override without a code change.

### AD-10: AI-assisted requirements capture

**Assessment:** Sound in concept, high-risk in execution.

The pipeline (voice/text → synthesize → interview → extract → stack-rank → weights) is ambitious. The key risk is LLM hallucination in the synthesis step. The spec correctly addresses this: "synthesized text is always shown to the user for confirmation before extraction." This user-in-the-loop guard is non-negotiable.

**Concern:** The pairwise stack-ranking step ("Is X more or less important than Y?") for N requirements is O(N²) comparisons. For 10 requirements that's 45 comparisons; for 20 it's 190. The UX must handle this gracefully — either batch the comparisons, use a tournament bracket, or cap the number of WANT requirements. No change requested for v1 but plan for the UX load.

---

## 2. Entity Scoping Invariant

**The invariant:** Every record carries non-nullable immutable scope (`thesis_id`, `deal_id`, `entity_id`). No cross-deal reference path. Multiple legal entities within a deal are distinct Entity records; every datum is attributed to a specific entity.

**Assessment:** This is a correctness invariant, and the architecture correctly treats it as such.

### Gaps Identified

1. **Gap: Entity discovery at intake.** When a candidate is first entered, the entity structure is unknown. The intake captures a single company record (legal name, DBA, type). At what point are subsidiary entities discovered and modeled? Is this manual (facilitator adds entities as discovered) or driven by AI enrichment? The data model requires `entity_id` on every datum, but the entity creation workflow is underspecified.

2. **Gap: Entity hierarchy.** The spec says "multiple legal entities within a deal are distinct Entity records" but does not model parent-child relationships between entities. A subsidiary's data needs to be attributable to the subsidiary entity while also being roll-up-visible at the parent/candidate level. The current Entity model may need a `parent_entity_id` or a candidate-level aggregation query that collects across entities.

3. **Gap: Cross-entity comparison.** When comparing candidates, do we compare at the candidate level (aggregated across entities) or at the entity level? The comparison dashboard seems to assume candidate-level comparison, but the data model scopes everything to entity_id. The aggregation logic that rolls entity-level data up to candidate-level needs to be defined.

4. **Gap: Vault isolation enforcement.** The spec says the Obsidian vault path is "hardcoded + validated on startup." For a containerized deployment, this means the vault is a filesystem dependency that must be mounted. How is cross-deal isolation enforced within the vault? The spec mentions a directory hierarchy (`thesis-<slug>/candidates/<code-name>/entities/<entity-name>/`) but this is filesystem convention, not platform enforcement. A misconfigured sync tool or manual file move could leak data between directories.

**Recommendations:**
- Document the entity discovery workflow (manual vs. AI-assisted)
- Add `parent_entity_id` to the Entity model for hierarchy support
- Define candidate-level aggregation queries for the comparison dashboard
- For vault isolation: document that the vault directory structure is a convention, not a security boundary, and that the primary isolation mechanism is the database scope invariants

---

## 3. Tech Stack Choices

| Layer | Choice | Assessment |
|-------|--------|------------|
| Frontend | Next.js / React | Sound. Mature ecosystem, fast build. |
| API/Backend | Next.js API routes (or separate Node service) | Adequate for v1. If the API grows beyond what Next.js API routes comfortably handle, extract to a standalone Express/Fastify service. |
| Database | PostgreSQL with JSONB | Sound. Relational for structured entities, JSONB for flexible assessment trees. Row-level security can enforce multi-tenant isolation. |
| ORM | Prisma or Drizzle | Both are type-safe and adequate. Drizzle is lighter and performs better with raw SQL when needed. Prisma's migration tooling is more mature. No strong preference. |
| Auth | NextAuth / Clerk / custom | **Deferred decision (OQ-1).** Multi-tenant with invited-expert model is non-trivial. Clerk or Auth0 would get this right faster than a custom solution. Recommend against custom auth for v1. |
| AI synthesis | LLM API (OpenRouter) | Pragmatic. **Cost concern:** Unmonitored LLM calls during requirements capture could surprise on cost. Implement a token budget and expose cost-per-session in the UI. |
| Voice-to-text | Web Speech API / Whisper | Adequate. Web Speech API is free and works in modern browsers. Whisper would need server-side processing — defer to v1.1 unless voice quality is unacceptable. |
| Notes | Dedicated Obsidian vault (filesystem) | **Highest risk choice.** See entity scoping gaps above. Recommend abstracting the note store behind an interface so the implementation can be swapped without architectural change. |
| Testing | Vitest + Testing Library + Playwright | Industry standard. No concerns. |
| Deployment | Local dev → Docker container | Sound for v1. **Missing:** CI/CD pipeline. For a solo operator, even a simple `docker build && docker push && ssh deploy` script would prevent manual-deployment errors. |

### Key Concerns

1. **Obsidian vault coupling** is the most architecturally constraining choice. If this is non-negotiable for Ben, it must be abstracted behind a clean interface so the app doesn't depend on a local filesystem. Recommend a `NoteStore` interface with a `LocalObsidianStore` implementation.

2. **Auth provider deferred (OQ-1).** Multi-tenant + invited expert roles + just-in-time escalation is architecturally significant. This decision affects the entire permission model. It should be resolved before any code is written, not during build.

3. **No mention of rate limiting, error handling strategy, or observability** (logging, metrics, tracing). For a tool handling live M&A deal data, operational visibility matters. Add structured logging from day one.

---

## 4. Assessment Engine Design

### Is the dimension-agnostic approach correct?

**Yes.** This is the strongest architectural decision in the document.

The engine treats Workstream, Assessment, and Question Tree as data. This means:
- Adding a new risk dimension (e.g., financial, legal) = populate a new assessment template; zero engine changes
- Modifying question weights = data update, not code change
- Running the same assessment across multiple candidates = parameterized query, not duplicated logic
- The scoring model (Phase 2 risk axis) is a generic computation over assessment data

### Design Verification

The hierarchy is clean:
```
Workstream (W1-W8)
  └─ Assessment (populated question bank)
      └─ Question Tree (gating questions with skip logic)
          └─ Question (pass/fail/undetermined + numeric risk 1-10)
```

The two-source model (ASSERTION vs. EVIDENCE per answer) integrates naturally:
- Each answer carries `evidence_level: "assertion" | "evidence"` and `source` (string for evidence, null for assertion)
- Confidence computation: agreement between assertion and evidence raises confidence; conflict drops it
- The expert's answer is authoritative; the seller's input feeds the confidence signal

### Recommendations

1. **Question tree versioning.** Assessment templates will evolve. Each assessment run should reference the template version it was started against, so historical scores remain meaningful.

2. **Scoring function as explicit business logic.** The risk score rollup (question → assessment → workstream → total) must be a pure function: `score(answers, weights) → numeric_score`. Test exhaustively. Do not bury the scoring logic in UI components or API routes.

3. **Transaction boundary for assessment completion.** When an expert completes an assessment, all answers should be committed atomically. Partial assessment saves should be allowed (draft state) but a completed assessment should be all-or-nothing.

4. **Skip logic engine.** The skip logic (gating question + branches) is a small DAG evaluator. Model it as a directed graph where each node is a question with a `gate_if` predicate. The engine evaluates reachable nodes only. This is testable in isolation.

5. **Undetermined state resolution.** Define what happens when an assessment is submitted with undetermined questions. Options:
   - Block submission (all questions must be pass/fail)
   - Allow submission with undetermined items, which set confidence to 0 for those items
   - Allow submission, confidence reflects the pass/fail ratio over answered questions only
   
   Recommend option 3 with a visible indicator of how many questions remain unanswered.

---

## 5. Overall Assessment

### What's Strong

- **Two-axis scoring model** is the right architectural centerpiece. It correctly separates _what we want_ (fit) from _what we fear_ (risk) and never collapses them.
- **Dimension-agnostic assessment engine** is well-designed and extensible. Making assessments data rather than code is the key architectural insight.
- **Entity scoping invariant** is correctly identified as a correctness requirement, not a privacy feature.
- **Build order** (A → B → C) is pragmatically sized to the live client deal.
- **User-in-the-loop guards** (synthesized text confirmed before commit, gates recommend but humans decide) are correctly non-negotiable.

### What Needs Attention

1. **Obsidian vault coupling** — Abstract behind an interface; make vault path configurable; document that filesystem isolation is convention, not security boundary.
2. **Auth decision (OQ-1)** — Must be resolved before any code is written; it affects the entire permission model.
3. **Entity discovery workflow** — Underspecified. How and when are subsidiary entities discovered and added?
4. **Cross-entity aggregation** — How does entity-level data roll up to candidate-level for the comparison dashboard?
5. **LLM cost governance** — Implement token budgets and cost-per-session visibility.

### Change Requests

1. **CR-1:** Abstract Obsidian vault behind a `NoteStore` interface with a configurable vault path (env var, not hardcoded constant).
2. **CR-2:** Resolve auth provider (OQ-1) before build begins — it's not a deferrable decision.
3. **CR-3:** Add `parent_entity_id` to the Entity model and define candidate-level aggregation queries.
4. **CR-4:** Add structured logging and basic observability from day one.
5. **CR-5:** Defer automated cross-candidate bias detection to v1.1; surface raw scores for human comparison in v1.

### Sign-off

**Status:** Architecture approved with change requests (CR-1 through CR-5).

The architecture is sound in its core decisions. The five change requests above address concrete risks that would be costly to fix post-build. Once addressed, I am ready to proceed with implementation under this architecture.

---

*This review was produced as a durable work product for PRX-34. The findings are intended for the CEO and QA Engineer (PRX-38) as part of the Phase 3 handoff validation.*
