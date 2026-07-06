# Cross-Cut (user-directed) — The Code-Knowledge Flywheel

> Piggybacks on **idea 065** (Software-Building & Self-Hosting) by giving it a memory: the
> **llm-wiki / Knowledge System (idea 060)** stores reusable code snippets, patterns, and
> *architectural* knowledge so each build is faster, more consistent, and — when self-hosting — the
> system progressively *learns its own architecture*.

**A different cut:** the thematic combos treat knowledge (combo 11) and software-building (idea 065) as
separate stacks. This one fuses them into a **flywheel**: building produces curated code knowledge →
knowledge makes the next build cheaper and more consistent → especially for self-hosting, the system's
model of *its own* codebase deepens every commit, accelerating the Part-C bootstrap.

**Synthesizes:** 060 Knowledge System (llm-wiki) · 065 Software-Building & Self-Hosting ·
037 cache-stable context · 028 handoff briefings *(builds on thematic combo 11 + idea 065)*

## Industry grounding (web research, June 2026)

The combination matches where autonomous coding has landed — and tells us *how* to build the memory:

- **Hybrid vector + graph retrieval is now state of the art for code.** "Modern coding agents use hybrid
  retrieval combining vector search for semantically relevant entry points with graph traversal to
  follow call chains and dependency relationships — answers pure vector RAG cannot produce." → the
  architecture layer below must be a **code graph**, not just chunked text.
- **Persistent codebase memory + spec-driven workflows:** "specs and architecture notes become part of
  the agent's persistent memory" agents reference during implementation. → llm-wiki holds canonical
  specs/architecture as authoritative docs (idea 060's authority model) injected into build context.
- **Agents should fit existing patterns:** "good agents generate code that fits existing patterns —
  naming conventions, error handling style, architectural patterns." → the snippet/pattern library's
  whole purpose is *consistency*, not just reuse.
- **Multi-scope memory:** writes tagged with identity scopes, composed/ranked at retrieval — aligns with
  idea 060's org/company/team scope tiers and the attribution key of cross-cut 03.

## The unified idea — three knowledge layers, one engine

Extend the llm-wiki (already the planned home for accumulation + curation + retrieval) with three
code-aware layers that the software-building capability (065) both *writes to* and *reads from*:

1. **Snippet & pattern library (reuse).** When a work product is accepted, the curator (`wiki-maintainer`
   / `wiki-lint`) extracts reusable, generalized snippets and patterns — tagged by language, purpose,
   and the convention they embody — instead of every agent re-deriving the same auth guard, retry
   wrapper, or test scaffold. Retrieved at build time so new code *matches* existing style.
2. **Architecture graph (understanding).** A hybrid index of the codebase itself — modules, call chains,
   dependencies, data flows — built from the engineering workspace (065 Part A) using local embeddings
   (idea 008) for the vector side and a parsed dependency/call graph for the traversal side. This is the
   layer that answers "where does X live, what calls it, what breaks if I change it?" — the question
   pure-vector RAG can't.
3. **Canonical specs & conventions (authority).** Architecture decisions, API contracts, coding
   standards, and DoD (idea 058) live as *canonical* docs (idea 060 authority tier), auto-injected into
   every build agent's context — kept cache-stable (idea 037) since they change slowly. The "spec-driven
   memory" the research describes.

Agents retrieve from all three before writing code (an extension of the handoff-briefing pattern, idea
028, to "briefing from institutional code memory"), and the curator writes new learnings back after
each accepted change.

## Why this makes 065 dramatically more doable (esp. the Part-C bootstrap)

065's self-hosting bootstrap builds capability "rung by rung." A code-knowledge flywheel is what makes
the ratchet *compound*: each rung the system builds is **indexed into its own architecture graph**, so
when it builds the next rung it already understands the code it's extending — less re-reading, fewer
contradictions, faster convergence. The system isn't just adding features to itself; it's
**accumulating an ever-better map of itself**. This is the knowledge-side complement to the
self-improving loop of cross-cut 02 (which captures *outcomes*); here we capture *code & structure*.

It also directly attacks the most expensive failure of autonomous coding — re-solving solved problems
and writing code that fights the existing architecture — by making prior solutions and the current
structure *retrievable* rather than rediscovered.

## Phasing

1. **Canonical specs/conventions layer** (idea 060 authority tier + context injection) — highest value,
   lowest risk; gives build agents the standards immediately. Ship first.
2. **Snippet/pattern extraction** into the wiki on work-product accept, with curation (`wiki-lint`).
3. **Architecture graph**: code embeddings (local, 008) + parsed dependency/call graph; hybrid retrieval
   tool exposed to build agents ("what calls this? where should this go?").
4. **Self-hosting feedback**: point all three at Paperclip's own repo so the bootstrap (065 Part C)
   compounds — every shipped rung enriches the self-model.

## Ratings

- **Difficulty:** Medium–High — layers 1–2 reuse the planned knowledge engine (combo 11) and are
  mostly curation + injection. The architecture graph (layer 3) is the harder piece: building and
  *keeping fresh* a hybrid vector+graph code index across languages (parsing, incremental re-index on
  commit) is real work, best treated as best-effort per language. Curation quality is the perennial risk
  — a snippet library full of rot is worse than none, so the `wiki-lint` gate matters.
- **Estimated time to complete:** ~4–6 engineer-weeks atop combo 11 + idea 065 Part A existing
  (layer 3 ≈ half of that).
- **Importance:** 8/10 — it's the difference between software-building that stays flat and software-
  building that *compounds*; for self-hosting (065) it's close to essential, since a system that builds
  itself must understand itself. High leverage, but depends on 060 and 065 Part A being underway.

## Sources

- [Persistent Codebase Memory for Coding Agents 2026 — Cognee](https://www.cognee.ai/blog/guides/ai-coding-agent-persistent-codebase-memory)
- [State of AI Agent Memory 2026 — mem0](https://mem0.ai/blog/state-of-ai-agent-memory-2026)
- [The State of AI Coding Agents (2026) — Dave Patten](https://medium.com/@dave-patten/the-state-of-ai-coding-agents-2026-from-pair-programming-to-autonomous-ai-teams-b11f2b39232a)
- [AI Coding Agents in 2026: How They Work — Plus8Soft](https://plus8soft.com/blog/ai-coding-agents/)
