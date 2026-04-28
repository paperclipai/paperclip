# Stack Research

**Domain:** wikiLLM/Graphify ingest cycle + coin ledger integrity
**Researched:** 2026-04-27
**Confidence:** HIGH (Context7 verified)

## Recommended Stack

### Embedding Generation

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| `openai` (official SDK) | `^5.19.1` | Embedding generation for document chunking | The Node.js SDK v5 is the standard client for `text-embedding-3-small` (1536-dim, 80KB context). RealTycoon2 already has LLM integration patterns via adapters — the same call pattern applies. |
| `text-embedding-3-small` | model | 1536-dimension embeddings at ~$0.02/1M tokens | Best cost/quality balance for RAG. `text-embedding-3-large` (3072-dim) available if higher accuracy needed. |

**Integration point:** `@openai/openai-node` → `client.embeddings.create({ model: 'text-embedding-3-small', input: text })`. API key via `OPENAI_API_KEY` env var, consistent with how adapter quota keys are handled.

### Vector Storage

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| `pgvector` (via `pgvector` npm) | `^0.3.0` | In-process vector storage on top of existing PGlite/Postgres | The existing RT2 spine uses PGlite embedded Postgres. pgvector adds `<->` (L2), `<=>` (cosine), `<#>` (inner product) operators as a Postgres extension. No new infrastructure. HNSW index via `CREATE INDEX USING hnsw (embedding vector_l2_ops)`. |
| Alternative: `qdrant` | separate service | When vector scale exceeds single Postgres | **Avoid unless** company has >500K documents or million+ queries/day. Adds operational complexity. |

**Integration point:** Embeddings stored as `vector(1536)` column in a new `rt2_v33_wiki_embeddings` table. Same Drizzle ORM pattern as existing schemas. Query with `ORDER BY embedding <-> $1 LIMIT k`.

### Document Parsing

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| `pdf-parse` (mehmet-kozan) | `^2.x` | PDF text extraction | Pure TypeScript, no native dependencies, works in Node.js and browser. `PDFParse` class with `getText()` async method. Supports page ranges, partial extraction, hyperlink parsing. v2 API: `const parser = new PDFParse({ url })`. |
| `marked` | `^15.x` | Markdown parsing for chunking | Already implied by existing `rt2V33WikiPages.markdown` text field. Lightweight, no bundle overhead. |

**Integration point:** `rt2_wiki_documents` table for raw file blobs + extracted text. Chunker splits by semantic boundaries (paragraph, section). No OCR — PDF images require separate pipeline.

### Linting / Consistency Validation

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| **Extend existing `rt2-wiki-lint.ts`** | existing `^0.38.4` (drizzle) | Provenance-aware linting already has empty/short/stale detection patterns | `Rt2WikiLintIssue` types already defined. Add `embedding_consistency` check that verifies vector chunk matches source markdown. |
| **Validation layer** | custom | Cross-reference `rt2_v33_wiki_pages.markdown` vs `rt2_v33_wiki_embeddings.chunk_hash` | Hash-of-content check prevents drift. One `rt2_wiki_consistency_checks` table with `(page_id, check_type, passed, details)` rows. |

**Why not a dedicated linting library:** wikiLLM consistency is domain-specific (provenance, embedding drift, graph projection integrity). No off-the-shelf tool fits RT2's event-sourced model. Extend the existing `rt2WikiLintService` pattern.

### ACID Coin Ledger

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| **Existing `rt2CoinLedger` + `rt2PersonalPnL`** | current schema | Append-only ledger already has `fromActorId`, `toActorId`, `amount`, `balanceAfter` | No new table needed. Extend with `balance_after` computed column and transaction grouping. |
| **Postgres transaction wrapping** | `embedded-postgres@18.1.0-beta.16` | ACID transactions for multi-row ledger updates | `db.transaction([...ops])` pattern in Drizzle. All coin transfers are atomic: debit + credit in same transaction. |
| **Double-entry validation** | custom constraint | `SUM(amount) WHERE tx_group = X = 0` per transaction group | Add check constraint: for every `transaction_group`, `SUM(from_amount) = SUM(to_amount)`. Or use a materialized view for balance verification. |

**Integration point:** Extend `rt2CoinLedger` with:
- `transaction_group uuid NOT NULL` — groups debit/credit pair
- `leg text NOT NULL` — `'debit'` or `'credit'`
- Check constraint: `balance_after >= 0` (no negative balances)

### Chunking Strategy

| Approach | When to Use | Implementation |
|----------|--------------|----------------|
| **Semantic chunking** | Wiki pages with clear headings/sections | Split by `## Heading` boundaries, 512-token target, preserve metadata |
| **Fixed-size overlap** | Flat documents (daily reports) | 512 tokens, 64-token overlap, discard remainder |
| **Metadata-preserving** | Graph-linked content | Include `source_event_ids`, `page_key` in chunk metadata for provenance |

## What NOT to Use

| Avoid | Why | Use Instead |
|-------|-----|-------------|
| `chromadb` / `milvus` / standalone vector DB | Adds external service, contradicts embedded Postgres strategy. PGlite cannot host these. | `pgvector` on existing Postgres |
| `langchain` / `llamaindex` | Heavy abstraction layers, 200KB+ bundle overhead, over-designed for RT2's simple ingest | Direct SDK calls + custom chunker |
| `pdfjs-dist` (Mozilla PDF.js) | Browser-optimized, requires WebWorker setup in Node.js | `pdf-parse` mehmet-kozan for server-side |
| `transformers.js` / ONNX embeddings | CPU-bound, slow, no GPU acceleration benefit in server context | OpenAI API embeddings (external compute) |
| Separate `finance_events` for coin ledger | `rt2CoinLedger` + `rt2PersonalPnL` already cover gold ledger | Extend existing schema |

## Stack Patterns by Variant

**If PGlite (embedded Postgres):**
- Use `pgvector` npm package — connects to embedded Postgres like any Postgres connection
- Vector index: HNSW only (no IVFFlat, requires `pg_vector` extension install which PGlite may not support)
- Chunk count estimate: 1 wiki page ≈ 4-8 chunks at 512 tokens

**If external Postgres (production):**
- Enable `pg_vector` extension: `CREATE EXTENSION vector`
- Use IVFFlat + HNSW hybrid index for >100K vectors
- Connection pooling via `postgres` package (already in `packages/db`)

## Version Compatibility

| Package | Compatible With | Notes |
|---------|-----------------|-------|
| `openai@^5.19.1` | Node 18+ | ESM-only, matches server `^5.1.0` Express |
| `pgvector@^0.3.0` | `postgres@^3.4.5`, `drizzle-orm@^0.38.4` | Uses `pgvector.toSql()` for vector formatting |
| `pdf-parse@^2.x` | Node 18+ | Pure TS, no native deps |
| `embedded-postgres@18.1.0-beta.16` | pnpm patched | Already in `packages/db/package.json` |

## Installation

```bash
# Core - add to server/package.json
pnpm add openai pgvector

# Document parsing
pnpm add pdf-parse marked

# Dev dependencies (if needed)
pnpm add -D @types/pdf-parse
```

## Sources

- `context7:///openai/openai-node` — embeddings API, v5 client usage
- `context7:///pgvector/pgvector-node` — HNSW index creation, vector query syntax
- `context7:///mehmet-kozan/pdf-parse` — PDF text extraction, page ranges, TypeScript types
- `packages/db/src/schema/rt2_v33_wiki_pages.ts` — existing wiki schema
- `packages/db/src/schema/rt2_personal_pnl.ts` — existing coin ledger schema
- `server/src/services/rt2-wiki-lint.ts` — existing linting patterns
- `server/src/services/rt2-hybrid-search.ts` — existing hybrid search (keyword-only)

---
*Stack research for: wikiLLM/Graphify ingest + coin ledger integrity*
*Researched: 2026-04-27*