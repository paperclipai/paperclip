# 060 — Knowledge System (Built-In Accumulation, Curation & Retrieval)

> Consolidates three earlier ideas into one coherent system: the **engine** that accumulates and
> curates knowledge, the **authority model** that makes some of it canonical and scoped, and the
> **retrieval layer** that lets agents and humans find it by meaning.

## Suggestion

An agent is only as good as what it can reliably reference, yet Paperclip has no first-class,
always-present knowledge layer. The pieces exist but are scattered and optional:

- A capable knowledge **engine** already exists — but as a plugin. `plugin-llm-wiki` ships a
  `wiki-maintainer` agent, ingest/query/lint/maintain skills, wiki **spaces** with migrations,
  managed maintenance/ingest routines, and an ingestion security gate
  (`doc/plans/2026-05-06-llm-wiki-paperclip-asset-security-gate.md`). `doc/SPEC.md:513` deliberately
  keeps it out of core: *"Not a knowledge base — core has no wiki/docs/vector-DB (plugin territory)."*
- **Documents** exist but are scoped to `companyId` only — no team or org/instance scope, no
  "canonical/authoritative" designation, and no path to inject them into an agent's run context. The
  managed instruction-bundle system (`agent-instructions.ts`) has no knowledge hook.
- **Search** is keyword-only — `company-search.ts` with GIN trigram indexes (`gin_trgm_ops`) on
  issues/docs/comments. No semantic/vector retrieval, so agents can't find related-but-differently-
  worded prior work and re-solve solved problems.

Make knowledge a **first-class, default-on capability** with three layers: an **engine** that
accumulates and curates, an **authority model** of scoped canonical docs, and a **semantic
retrieval** layer — one durable, curated source of truth shared by agents and humans.

## The architecture (and the thin-core tension, addressed)

Paperclip's philosophy is "thin core, rich edges," and `SPEC.md` deliberately puts the wiki in
plugin territory. The resolution is **not** to dump a vector DB into the control plane, nor to leave
knowledge optional — it's a **contract-in-core + default-bundled provider** split (the same
batteries-included pattern Paperclip already uses for adapters):

- **Core owns the contract:** a knowledge capability — capture → curate → store → retrieve →
  serve-to-agent-context — that always exists and that *other core features may depend on*.
- **The LLM-wiki engine becomes the default first-party provider** of that contract: bundled and
  enabled by default, with the plugin seam preserved so advanced operators can swap implementations.

This keeps core thin (an interface, not a database) while guaranteeing every company has knowledge
from day one.

## Layer 1 — Engine: accumulation & curation

1. **Default-bundle the engine.** Ship `plugin-llm-wiki` (or its successor) as a built-in, enabled-
   by-default capability — no install step. Keep its proven pieces: spaces, the `wiki-maintainer`
   agent, and the ingest/query/lint/maintain skills.
2. **A curation lifecycle, not a dumping ground.** Formalize capture → **lint/curate** →
   canonicalize → serve. Promote `wiki-lint` into a real curation gate so knowledge stays
   trustworthy (rot is every wiki's failure mode). The `wiki-maintainer` agent runs curation +
   pruning on managed routines.
3. **Autoresearch maintenance.** A scheduled research/librarian agent keeps living docs current —
   refresh market/competitor briefs, fold in accumulated **learnings** from experiments (idea 056),
   postmortems (idea 057), and calibration (idea 055), and flag stale/contradicted pages. Updates
   land as revisions **proposed by autoresearch, ratified by a human or manager agent** (review via
   idea 016), so canon stays trustworthy rather than silently rewritten.

## Layer 2 — Authority: scoped, canonical SOPs & specs

4. **Three scope tiers + inheritance.** Extend documents beyond `companyId` to support **org/
   instance** and **team** scope. An agent's effective knowledge = union of *org* + *company* +
   *team* docs, with the more specific tier overriding the general (team beats company beats org).
5. **Canonical designation + versioning.** Let a doc be marked **canonical** (authoritative, pinned,
   "always reference this"), distinct from ordinary working docs. Reuse existing `document_revisions`
   for history and `document-annotations` threads for review.
6. **Auto-inject into agent context.** Wire the resolved canonical set into the managed instruction-
   bundle system so relevant SOPs/specs are present in every agent's run context by scope and role —
   kept cache-friendly (stable prefix, idea 037) since this content is stable by design. Relevance-
   scope the injected set by role/team so agents aren't drowned in docs.

## Layer 3 — Retrieval: semantic search

7. **Embed content.** Generate embeddings for issues, comments, documents, and work products on
   create/update, run on a **local model** (idea 008) so indexing is free and private.
8. **Vector store in Postgres (pgvector).** Keep the single-datastore simplicity Paperclip relies on
   (PGlite in dev) rather than adding a separate search service.
9. **Hybrid retrieval.** Combine semantic similarity with the existing trigram/keyword search
   (`company-search.ts`) so exact matches still win when they should and semantic recall fills the
   rest. Extend the search service, don't replace it.
10. **Agent-facing retrieval tool.** Expose semantic search as a tool agents call ("has this been
    done before? what do we know about X?") — turning company history into retrievable memory and
    the backbone for shift-handoff briefings (idea 028).

## Cross-cutting: shared, secure, portable

- **Shared by agents and humans** through one surface — agents ingest learnings and cite pages;
  humans browse, edit, ratify. One curated source of truth, not parallel knowledge.
- **Security gate into core.** Built-in ingestion = built-in attack surface: carry the existing
  ingestion security gate plus leak/PII scanning (ideas 020/034) as part of the core contract.
- **Citeable & legible.** Reference docs/pages by stable id (`issue-references.ts`-style) so work can
  cite the SOP/spec it followed — useful for audit (idea 023) and DoD/spec-conformance checks
  (ideas 017/058).
- **Portable.** Knowledge travels with company blueprints/exports (idea 018,
  `company-portability.ts`), so an exported company carries its institutional knowledge, and shared
  org SOPs propagate to every company in the instance.

## Perceived complexity

**Medium–High** as a whole, but cleanly phased — and most pieces already exist, so it's largely
*promotion + interface design + integration* rather than greenfield.

1. **Static three-tier canonical docs + context injection** (Layer 2) — *Medium*. Highest immediate
   value, lowest risk; ship first.
2. **Semantic retrieval** (Layer 3) — *Medium*. pgvector + local embeddings + hybrid ranking; main
   risks are index freshness/cost and ranking quality.
3. **Promote the engine to core + autoresearch curation** (Layer 1) — *Medium–High*. The hard part is
   the **architectural decision and migration**: defining the core knowledge contract without
   bloating the thin control plane, consciously amending the `SPEC.md` "plugin territory" stance, and
   migrating existing plugin installs/spaces data safely (release notes show wiki packaging/migrations
   are delicate).

Done well, these three layers are one stack — *what's authoritative* (Layer 2), *how it's found*
(Layer 3), and *the engine that accumulates and curates it* (Layer 1) — not three competing plugins.
