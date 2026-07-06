---
title: Knowledge & Memory
type: concept
status: reviewed
sources: [060, 028, 056, 037, combo-11, xcombo-code-knowledge-flywheel, xcombo-13, research-sources]
updated: 2026-06-24
---

# Knowledge & Memory

A company that can't remember what it learned re-solves solved problems forever. This is the institutional
memory layer — and a recurring instance of the [[llm-wiki]] pattern *inside* the product.

## The Knowledge System (idea 060 / combo-11)

A first-class, default-on knowledge capability via **contract-in-core + default-bundled provider** (the
llm-wiki engine), in three layers:
- **Engine** — accumulate + curate (a real `wiki-lint` gate; an autoresearch librarian).
- **Authority** — scoped canonical docs (org / company / team tiers, inheritance), auto-injected into
  agent context, kept cache-stable (037).
- **Retrieval** — local embeddings → pgvector + hybrid (semantic + trigram) search, exposed as an
  agent tool ("has this been done before?").

## Continuity & learning

- **Shift-handoff briefings (028)** — when work changes hands, auto-generate a "what's done / tried /
  open" note so the receiver starts warm. (A special case of retrieval over one issue.)
- **Business experiments (056)** — hypothesis → variants → metric → recorded *validated learning* into
  the knowledge base. Turns "agents doing stuff" into "a company that learns."

## The Code-Knowledge Flywheel (xcombo-code-knowledge-flywheel)

The knowledge engine specialized for code, to power [[software-building-and-self-hosting]]: a reusable
**snippet/pattern library** (consistency), an **architecture graph** (hybrid vector + call/dependency
graph — pure vector RAG can't answer "what calls this?"), and **canonical specs/conventions** injected at
build time. For self-hosting, every rung built enriches the system's model of itself → the bootstrap
*compounds*. Grounded in 2026 persistent-codebase-memory practice.

## The Reproducible Run (xcombo-13, queued)

Session continuity (028) + cache-stable context (037) + deterministic replay ([[security-governance|provenance]])
+ captured dataset (040) → runs that resume, reproduce, and resist drift.

## Provenance

- Ideas `028,037,056,060`; combos `combo-11`, `xcombo-code-knowledge-flywheel`, queued `xcombo-13`.
- `raw/research-sources.md` → `[code-memory]`.

## Open questions for human review

- Promote the llm-wiki engine into a core *contract* (amend the "thin core" SPEC stance) vs. keep optional?
- Keep the architecture graph fresh across languages — incremental re-index on commit; best-effort scope?
- Should *this meta-wiki* and the in-product knowledge system share one engine? (see [[llm-wiki]])
