# PRA-634 Phase 2 Implementation — Work Done

**Heartbeat run**: dd4c6fee-3911-4f4a-b6a5-c0eef51879ec
**Date**: 2026-08-15
**Author**: PlatformEngineer
**Status**: in_review — code complete, needs integration test run against live Paperclip API

## Files Created

### Phase 2: Core Engine — pgvector Adapter + CRUD

| File | Purpose |
|------|---------|
| `packages/db/src/migrations/0129_memory_store_phase2.sql` | Migration: CREATE EXTENSION vector; memory_records, memory_operations, memory_extraction_jobs tables + indexes |
| `packages/db/src/migrations/meta/_journal.json` (updated) | Added entry for migration 0129 |
| `server/src/services/embedding.ts` | Embedding generation service (OpenAI-compatible API, with GIN full-text fallback no-key mode, in-memory caching) |
| `server/src/services/memory-adapter.ts` | builtin_pgvector MemoryAdapter: capture(), upsertRecords(), query(), list(), get(), forget() with full operation audit logging |
| `server/src/routes/memory.ts` (extended) | Added capture, records CRUD, query, list, get-by-id, forget, and operations-audit-log routes |

### Files Modified

| File | Changes |
|------|---------|
| `packages/shared/src/validators/memory.ts` | Added schemas for MemoryScope, MemorySourceRef, capture/query/list/record-write requests, context bundle, list page, snippet, usage |
| `packages/shared/src/types/memory.ts` | Added MemoryCaptureRequest, MemoryRecordWriteEntry, MemoryRecordWriteRequest, MemoryListRequest, MemoryListPage interfaces |
| `packages/shared/src/index.ts` | Exported new schemas and types |
| `packages/shared/src/types/index.ts` | Exported new memory types |
| `packages/shared/src/validators/index.ts` | Exported new validator schemas and types |
| `server/src/services/index.ts` | Exported embeddingService and builtinPgvectorAdapter |

## Architecture

```
Memory Routes (server/src/routes/memory.ts)
  └── builtinPgvectorAdapter (server/src/services/memory-adapter.ts)
        ├── embeddingService (server/src/services/embedding.ts)
        │     └── OpenAI-compatible embeddings API (text-embedding-3-small / 1536-dim)
        │     └── GIN full-text fallback when no API key
        └── memoryBindingService (server/src/services/memory-bindings.ts)
              └── Binding resolution (company default → agent override)
  └── memory_operations audit log (every action recorded with latency, usage, scope)
```

## Migration

- Migration 0129 creates all three tables (memory_records, memory_operations, memory_extraction_jobs)
- Enables `pgvector` extension
- Adds indexes for company-scoped lookups, source-provenance queries, and creation-time ordering
- GIN tsvector index on memory_records.text is created by the migration for full-text fallback

## REST API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | /companies/:id/memory/capture | Auto-capture text (30d TTL) |
| POST | /companies/:id/memory/records | Upsert curated records (no TTL) |
| GET | /companies/:id/memory/query | Semantic + full-text hybrid search |
| GET | /companies/:id/memory/records | Cursor-based paginated list |
| GET | /companies/:id/memory/records/:recordId | Get single record |
| DELETE | /companies/:id/memory/records | Forget records by handle |
| GET | /companies/:id/memory/operations | Operations audit log |

## Remaining Work (Phase 3+)

- [x] Async warm-up in heartbeat service (pre-run hydrate)
- [x] Memory preamble injection into agent prompts
- [ ] Post-run capture hook
- [ ] Issue comment/document capture hooks
- [ ] Memory preamble injection into agent prompts
- [ ] Agent-level memory tools (memory.search, memory.note, memory.forget)

## Typecheck Status

- ✅ Server implementation compiles clean (memory.ts route, memory-adapter.ts, embedding.ts)
- ✅ Shared package compiles clean
- ⚠️ memory-bindings.test.ts has 2 pre-existing type errors (test mock validators, not related to this change)