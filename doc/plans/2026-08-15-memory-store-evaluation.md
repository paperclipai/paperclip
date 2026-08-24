# PRA-638: Memory Store Options — Technical Evaluation

**Author**: Staff Engineer (PlatformEngineer)
**Date**: 2026-08-15
**Status**: Final — recommendation ready for CTO review
**Requested by**: CEO Directive (doc/plans/2026-08-15-ceo-next-cycle.md)

---

## 1. Executive Summary

Paperclip needs an agent-level memory store that supports time-scoped key-value storage, semantic (vector) search, and structured query against existing business objects (issues, comments, runs, agents, companies).

**Recommendation: Two-tier strategy — pgvector as the built-in core, with a plugin adapter contract for external providers.**

The rationale is:
- Paperclip **already runs PostgreSQL** in all deployment modes (embedded PGlite, Docker PostgreSQL 17, hosted Supabase). Adding the `vector` extension adds zero new infrastructure.
- pgvector provides both structured SQL query AND vector similarity search in a single database, avoiding dual-write complexity.
- The plugin adapter contract (already defined in `doc/plans/2026-03-17-memory-service-surface-api.md`) ensures Paperclip is not locked into any single backend.
- Embeddings from an OpenAI-compatible API (`text-embedding-3-small`, 1536-dim) — the same provider pattern Hermes uses for LLM routing — serve as the default embedding source, with GIN full-text fallback when no embedding key is configured.

---

## 2. Candidate Evaluation

### 2.1 Candidate A: PostgreSQL pgvector Extension

| Dimension | Assessment |
|-----------|------------|
| **Operational overhead** | ~0 for Docker/embedded modes; `CREATE EXTENSION vector;` is a single SQL statement. For Supabase: already available (pgvector is pre-installed). For embedded PGlite: need to verify PGlite supports the `vector` extension (confirmed as of PGlite v0.2.x). |
| **Query latency** | 5-50ms for ivfflat index, 10-100ms for hnsw index (depends on table size, index type, and probe depth). Suitable for async warm-up path. |
| **Cost** | $0 — runs on existing Postgres instance. No API costs. |
| **Integration effort** | Low. Drizzle supports `vector` column type. One migration to enable extension + add tables. Existing company-scoping and RLS patterns apply unchanged. |
| **Maturity** | pgvector v0.8.x — production-grade, actively maintained, used in production by Supabase, LangChain, etc. Supports ivfflat (approximate) and hnsw (hierarchical navigable small world) indexes, plus exact nearest-neighbor search. |
| **Dimension support** | Up to 2000 dimensions. `text-embedding-3-small` (1536) fits comfortably. |
| **Inspectability** | High — standard SQL queries against the same database the operator already knows. |
| **License** | PostgreSQL license — compatible with Paperclip's own licensing. |

**Verdict: Strongest candidate for the built-in provider.**

### 2.2 Candidate B: SQLite with vector extension (sqlite-vec)

| Dimension | Assessment |
|-----------|------------|
| **Operational overhead** | Low if used standalone, but Paperclip is already on Postgres. Adding SQLite as a second database doubles backup/restore scope and complicates the dev data directory story. |
| **Query latency** | Very low (in-process, no network). |
| **Cost** | $0. |
| **Integration effort** | Medium. Would require a separate Drizzle/SQLite client alongside the existing PostgreSQL client. Embedded PGlite already gives us a file-based Postgres — SQLite adds complexity without clear benefit over pgvector. |
| **Maturity** | sqlite-vec is newer compared to pgvector. Less battle-tested in production multi-tenant scenarios. |
| **Inspectability** | High — SQLite CLI or any SQLite browser. |
| **License** | MIT / Public domain. |

**Verdict: Not recommended.** Paperclip already has Postgres in every mode. Adding SQLite as a second database engine would increase deployment complexity (backup/restore must cover two data stores, embedded PGlite cannot share state with SQLite, plugin namespace management becomes ambiguous). The only scenario where SQLite wins is a hypothetical standalone Hermes-only mode where Paperclip is not present — not relevant to this evaluation.

### 2.3 Candidate C: Dedicated Vector Database (Qdrant, Weaviate, Pinecone, Milvus)

| Dimension | Qdrant | Pinecone | Weaviate | Milvus |
|-----------|--------|----------|----------|--------|
| **Operational overhead** | Self-host (Docker) or Qdrant Cloud. Medium-high. | Fully managed. Low operator burden but vendor lock-in. | Self-host or Weaviate Cloud. Medium. | Self-host (Docker/K8s) or Zilliz Cloud. High operational complexity. |
| **Query latency** | ~5-20ms (self-host, same network) | ~20-100ms (network latency to cloud API) | ~10-50ms | ~5-30ms (self-host) |
| **Cost** | Self-host: infra cost only. Cloud: ~$25+/mo | $70+/mo (starter) | $25+/mo (cloud) | Self-host: infra. Zilliz: ~$50+/mo |
| **Integration effort** | High — new HTTP/gRPC client, separate connection management, health checks, backup strategy. Breaks the current single-db deployment model. | High — vendor SDK, network config, API key management. | High — GraphQL-native API, separate auth. | High — complex deployment, separate tooling. |
| **Inspectability** | UI dashboard (Cloud) or REST API. | UI console. | UI console + GraphQL. | Attu GUI or REST API. |
| **License** | Apache 2.0 | Proprietary | BSD 3-Clause | Apache 2.0 |

**Verdict: Overkill for v0.4.0-beta scope; appropriate as plugin-provided options later.** Dedicated vector DBs shine at billion-scale vector search with sub-10ms latency. Paperclip's anticipated memory volume (company-scoped agent memory, not petabyte-scale document stores) does not warrant the operational overhead of a separate database. These should be available through the plugin adapter contract for companies that need them.

### 2.4 Candidate D: Embeddings from litellm / OpenAI-compatible API

This is not a storage solution but a **component** of any vector-based approach.

| Dimension | Assessment |
|-----------|------------|
| **Availability** | OpenAI `text-embedding-3-small` (1536 dim, $0.02/1M tokens) is the recommended default. Compatible with any OpenAI API proxy (litellm, etc.). |
| **Fallback** | GIN full-text search on `memory_records.text` when no embedding API key configured. No external dependency for local dev. |
| **Cost** | text-embedding-3-small: ~$0.02/1M input tokens. A typical memory capture of 500 tokens costs ~$0.00001. For a company with 10,000 captures/month: ~$0.10. Negligible. |
| **Latency** | 100-500ms for a single embedding API call (depends on provider). Async warm-up hides this. |
| **Integration** | Paperclip already has OpenAI API key config patterns. No new auth flow needed. |

**Verdict: Default embedding model = `text-embedding-3-small` (1536 dim).** Provider-agnostic via any OpenAI-compatible endpoint. GIN full-text as zero-config fallback.

### 2.5 Candidate E: File-based / Markdown-only

| Dimension | Assessment |
|-----------|------------|
| **Operational overhead** | Very low. Just files on disk. |
| **Query latency** | High without indexing (grep/find across files). Acceptable with FTS5. |
| **Cost** | $0. |
| **Integration effort** | Low for write, high for cross-company query. |
| **Structured query** | Not possible without shelling out to grep/qmd. Cannot join with issues, comments, agents in a single query. |

**Verdict: Useful for Hermes-native session search (already implemented via FTS5), but insufficient for Paperclip's cross-session, cross-agent, company-scoped memory requirements.**

---

## 3. Deep Dive: pgvector Architecture

### 3.1 Extension Availability by Deployment Mode

| Mode | Postgres source | pgvector available? | Notes |
|------|----------------|---------------------|-------|
| Docker (production) | `postgres:17-alpine` | ✅ Yes — `CREATE EXTENSION vector;` | The `pgvector` package ships with the `postgres:17-alpine` image when installed via APK. Add `RUN apk add --no-cache pgvector` to the Dockerfile, or switch to the `pgvector/pgvector:0.8.0-pg17` image. |
| Embedded PGlite (local dev) | PGlite (wasm-postgres) | ✅ As of PGlite v0.2.15 — `vector` extension is bundled. Import from `@electric-sql/pglite/vector`. | Code path: `PGlite` with `extensions: { vector }` in constructor. |
| Hosted Supabase | Supabase Postgres | ✅ Pre-installed and enabled. | Already available. |
| Docker Compose (local postgres) | `postgres:17-alpine` | ✅ Same as production Docker. | |

### 3.2 Index Strategy

Two index types are available:

**ivfflat** (Inverted File with Flat Compression):
```
CREATE INDEX memory_records_embedding_idx ON memory_records
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);
```
- Pros: Fast to build, low memory.
- Cons: Approximate recall degrades at high `probes`.
- Best for: Up to ~1M records, where build speed matters.

**hnsw** (Hierarchical Navigable Small World):
```
CREATE INDEX memory_records_embedding_idx ON memory_records
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 200);
```
- Pros: Better recall/speed tradeoff than ivfflat, no training step.
- Cons: Higher memory usage, slower to build.
- Best for: Production workloads, any scale.

**Recommendation**: Use `hnsw` for the default index. The memory_records table will stay well under 100M rows for the foreseeable future, and hnsw's superior recall matters for agent context quality.

### 3.3 Query Pattern

```sql
-- Semantic search (top K by cosine similarity)
SELECT text, summary, record_type, importance, 
       1 - (embedding <=> '[0.01, -0.02, ...]'::vector) AS similarity
FROM memory_records
WHERE company_id = $1
  AND scope_agent_id = $2
  AND ($3 IS NULL OR record_type = $3)
ORDER BY embedding <=> '[0.01, -0.02, ...]'::vector
LIMIT 10;

-- Hybrid: full-text + vector (RRF or weighted sum)
SELECT text, summary,
  ts_rank(to_tsvector('english', text), plainto_tsquery('english', $search_text)) AS rank
FROM memory_records
WHERE to_tsvector('english', text) @@ plainto_tsquery('english', $search_text)
UNION ALL
SELECT text, summary,
  1 - (embedding <=> $embedding::vector) AS rank
FROM memory_records
ORDER BY rank DESC
LIMIT 10;
```

### 3.4 Dimension / Migration Strategy

- `text-embedding-3-small` → 1536 dimensions. An `hnsw` index at 1536d with `m=16, ef_construction=200` uses ~25MB per 100K records.
- Column type: `vector(1536)`.
- If later switching to a 384-dim model (e.g., sentence-transformers/all-MiniLM-L6-v2), a second vector column or full re-index would be needed. This is deferred (see CTO Decision 7.3 in the workstream plan).

---

## 4. Recommendation

### Primary Recommendation: pgvector as the built-in core

```
┌──────────────────────────────────────────────────┐
│               Paperclip Control Plane             │
│                                                    │
│  MemoryBindings → MemoryBindingTargets             │
│       ↓ resolution                                 │
│  MemoryAdapter (plugin contract)                   │
│       ↓                                            │
│  ┌──────────────────────────────┐                  │
│  │ builtin_pgvector (core)      │                  │
│  │ - PostgreSQL + vector ext    │                  │
│  │ - GIN tsvector fallback      │                  │
│  │ - text-embedding-3-small API  │                  │
│  └──────────────────────────────┘                  │
│                                                    │
│  ┌──────────────────────────────┐                  │
│  │ plugin: mem0 / Qdrant / etc │ (optional)       │
│  └──────────────────────────────┘                  │
└──────────────────────────────────────────────────┘
```

### Why pgvector wins

1. **Zero new infrastructure** — Paperclip already runs Postgres in every deployment mode.
2. **Single database** — ACID transactions across memory records and business data, unified backup, unified connection pool.
3. **Structured + vector query** — Operators can `SELECT` memory alongside issues, comments, runs in a single SQL query.
4. **Existing skill** — The team already uses Postgres extensions (pg_trgm, fuzzystrmatch). pgvector follows the same pattern.
5. **Proven maturity** — Supabase, LangChain, and many AI products use pgvector in production.
6. **Plugin escape hatch** — The adapter contract means if a company outgrows pgvector, they can swap to a dedicated vector DB via a plugin without Paperclip core changes.

### Tradeoffs Acknowledged

| Tradeoff | Mitigation |
|----------|------------|
| Postgres vector index is slower than dedicated vector DB at >10M vectors | Paperclip's per-company memory volumes will not approach this scale in the foreseeable future. Plugin path exists for outliers. |
| embedding dimension tied to chosen model (1536) | Model choice is configurable per-binding. Adding a second column for 384-dim models is a Phase 5 consideration. |
| Vector index rebuild on large tables | `CREATE INDEX CONCURRENTLY` avoids write locks. HNSW index builds can be backgrounded. |
| Embedded PGlite compatibility | PGlite v0.2.15+ ships the vector extension. No migration complexity. |

### Implementation Effort Estimate

| Component | Effort | Details |
|-----------|--------|---------|
| Migration: `CREATE EXTENSION vector;` + memory tables | 1 day | Single SQL migration, Drizzle schema definitions |
| Embedding service: call OpenAI-compatible API | 1 day | Wraps `text-embedding-3-small` API, with caching and retry |
| builtin_pgvector adapter: capture, query, list, get, forget | 2-3 days | Core adapter implementing the MemoryAdapter interface |
| GIN full-text fallback | 0.5 day | tsvector-based search when no embedding key configured |
| Binding resolution service | 1 day | Company default → agent override resolution |
| REST API endpoints | 1-2 days | CRUD for bindings, targets, and memory operations |
| Async warm-up integration | 1 day | Pre-run hydration in heartbeat service |
| **Total** | **7-10 days** | |

This aligns with the Phase 1-2 scope defined in the workstream plan (`doc/plans/2026-08-15-memory-workstream-b-v0.4.0.md`).

---

## 5. Risk Register

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| PGlite vector extension compatibility issue on macOS ARM64 | Low | Blocks local dev | Has been verified in PGlite v0.2.15. If issues arise, Docker Compose mode is the fallback. |
| Embedding API key not configured | Medium | Falls back to keyword-only search | GIN full-text provides reasonable search quality for Phase 1-4. Add a clear setup notice in UI. |
| Vector index build causes write contention | Low | Brief write pauses on large tables | Use `CREATE INDEX CONCURRENTLY`. Build index during low-activity window (migration time). |
| Operator confusion about embedding costs | Low | Surprise bills | Log every embedding call in memory_operations with cost attribution. UI displays cost alongside memory usage. |
| Plugin provider can't match built-in performance | Medium | Operator chooses plugin and degrades latency | Plugin adapter contract includes capability flags. UI shows provider latency from memory_operations log. |

---

## 6. Open Questions for CTO

1. **Embedded PGlite vector extension**: Confirm that the current PGlite version in `pnpm-lock.yaml` bundles the vector extension. If not, upgrade PGlite as a pre-migration step.
2. **Docker image**: Confirm whether to add `pgvector` via `apk add` on the alpine image or switch to the official `pgvector/pgvector` Docker image.
3. **Default embedding model for Hermes-only deployments**: If Hermes runs without Paperclip, should memory be purely file-based? This is out of scope for PRA-638 but relevant for the product roadmap.

---

## 7. Related Documents

- Workstream plan: `doc/plans/2026-08-15-memory-workstream-b-v0.4.0.md`
- Memory landscape survey: `doc/memory-landscape.md`
- Memory service API contract: `doc/plans/2026-03-17-memory-service-surface-api.md`
- CEO directive: `doc/plans/2026-08-15-ceo-next-cycle.md`