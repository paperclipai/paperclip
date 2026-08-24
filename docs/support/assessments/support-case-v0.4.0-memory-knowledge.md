# Support Case Assessment: v0.4.0 Memory & Knowledge — pgvector Memory, Knowledge Documents

**Feature**: Agent memory (pgvector-based bindings, capture, query, records) and knowledge document management (CRUD, lifecycle, revisions, search)
**Assessed by**: Support Engineer
**Date**: 2026-08-16
**Related**: VOY-1190, VOY-1191, VOY-1192, VOY-1203, VOY-1204, VOY-1255, VOY-1256, VOY-1299 (C-3), 466c30fde7 (extraction jobs)
**Release**: v0.4.0-alpha

## Feature Overview (User Perspective)

### Memory System

The Memory system gives agents a durable, queryable memory using pgvector. Key capabilities:

1. **Memory Bindings** — Company-level (or agent-level) configuration connecting to a memory provider. The built-in provider is `builtin_pgvector` using PostgreSQL's pgvector extension.

2. **Memory Capture** — Agents can auto-capture text snippets into memory with a 30-day TTL. Useful for noting important findings during execution.

3. **Memory Records** — Curated, explicitly saved memory entries. Agents upsert records for information they want to persist consciously.

4. **Semantic + Full-Text Hybrid Query** — Memory supports both vector similarity search and full-text search, with hybrid ranking for best results.

5. **Agent Scope Isolation** — Agents can only see their own memory records. Shared (non-agent-scoped) records are visible to all agents in the company.

6. **Audit Logging** — All memory operations are logged for audit and debugging.

### Knowledge Documents

The Knowledge Documents system provides a full knowledge base within Paperclip:

1. **CRUD with Lifecycle** — Documents go through `draft → in_review → published → archived`, with full revision history.

2. **Search** — Full-text search across all published knowledge documents.

3. **Revisions & Diff** — Every edit creates a revision. Revisions can be compared via diff endpoints.

4. **Backlinks** — Documents can reference issues, creating a two-way link between knowledge and work items.

5. **Review Workflow** — Documents go through a review cycle before publication.

6. **Stale-Approval Guard (VOY-1255)** — Publishing requires an approved review on the **latest** revision. An approval from a prior review cycle (before the document was edited and re-submitted) is no longer accepted. This prevents publishing with stale approvals.

7. **Latest Review Status Accuracy (VOY-1256)** — The `latestReviewStatus` field in document listings accurately reflects the most recent review (`pending`, `approved`, `changes_requested`) regardless of outcome, not just approved reviews.

### Knowledge Browser UI

A dedicated **Knowledge Base** page is available at `/knowledge` in the sidebar (visible under the Work section). Operators can:

- Search published documents with full-text search and status filters (All statuses / draft / in_review / published / archived)
- Browse all knowledge documents with their lifecycle status
- Open a detail sheet to view document content, metadata, and summary
- Compare any two revisions side-by-side with an inline diff (old version → new version)
- View backlinks — the issues that reference the document
- Create new documents (title, summary, markdown body) and edit drafts with review comments

**Support note (search route fix)**: the `GET /knowledge/search` endpoint previously 404'd because the `/:documentId` route shadowed the literal `search` path. It now registers before the document-ID routes (`f09cf3bc6e`). If an operator reports "knowledge search doesn't work", first confirm the server is running at least this commit — a 404 on `/knowledge/search` is the symptom of the old route ordering.

### Memory Browser UI

A dedicated **Memory Browser** page is available at `/memory` in the sidebar (visible under the Work section). Operators can:

- Browse memory records with cursor-based pagination
- Search records via semantic + full-text hybrid query
- View record details (text, summary, scope, source, metadata)
- Filter records by metadata using JSONB containment (`metadata` parameter)
- Forget individual records by handle
- View recent memory operations in the audit log
- **View extraction jobs** (extractions tab) — browse memory extraction job history with status, source hyperlinks, and latency/cost display; retry failed jobs with one click. The extraction jobs dashboard polls every 15s.

### Memory Extraction Jobs

Extraction jobs record background memory-extraction work (e.g., agent runs that extract findings into memory). They carry a lifecycle status (`queued` → `in_progress` → `succeeded` / `failed`), plus timing, error, and provider references:

- **List jobs**: `GET /companies/{companyId}/memory/extraction-jobs?status=&limit=` — newest first, board-only
- **Get job**: `GET /companies/{companyId}/memory/extraction-jobs/{jobId}`
- **Retry failed job**: `POST /companies/{companyId}/memory/extraction-jobs/{jobId}/retry` — resets a `failed` job back to `queued`; only `failed` jobs can be retried (400 otherwise)

**Support note**: if an operator reports an extraction job that is stuck in `failed`, the retry endpoint resets it to `queued` so the worker picks it up again. A retry attempt on a non-failed job (or a job whose status changed concurrently) returns `400` with a clear message — no silent double-transition.

## Search Safety (plainto_tsquery)

**Commit**: `75c6c27a41` (C-3 fix, VOY-1299)

Both the knowledge document search endpoint and the memory warm-up path now use **`plainto_tsquery('english', query)`** instead of hand-constructed `to_tsquery` strings. User queries containing punctuation, operators, or special characters (`!@#$%^&*`, dashes, quotes, etc.) are tokenized as natural language — special characters are stripped rather than causing PostgreSQL query errors.

- **Old behavior**: a query like `"Why isn't the payment @ processing?!"` could crash knowledge search with a 500 error.
- **New behavior**: the same query is treated as `"Why isn't the payment processing"` — safe, no error.
- **Empty/whitespace-only queries** after stripping return an empty result set immediately (no DB round-trip).
- This is a **server-side fix** — no client-side escaping is needed, and it applies automatically to both the knowledge search API and the memory warm-up context injection path.

See the [Search Safety KB article](../kb/search-safety-plainto-tsquery.md) for troubleshooting details.

## Potential User Confusion Points

1. **"My agent doesn't seem to remember anything"** — Memory requires a binding to be configured for the company. Check `GET /companies/{id}/memory/bindings/resolve` to see if a binding exists. Memory is not auto-enabled — it must be configured.

2. **"Memory query returned nothing useful"** — Hybrid search quality depends on the embedding model and the data captured. Try different query wording. If agents auto-captured information, ensure the 30-day TTL hasn't expired.

3. **"I captured something but can't find it"** — Check agent scope: if captured under one agent scope, it won't appear under another. List records via `GET /companies/{id}/memory/records` to verify.

4. **"Knowledge document shows 'draft' but I thought it was published"** — Documents must go through `draft → in_review → published`. Check the lifecycle: if the review hasn't been completed, it stays in draft or in_review.

5. **"I can't delete a knowledge document"** — Only board operators can delete. If you're an agent, you can create and edit but not delete.

6. **"My knowledge document isn't appearing in search"** — Only `published` documents appear in search results. Check the document status. Draft, in_review, and archived documents are excluded.

## FAQ

**Q: How do I set up memory for my company?**
A: Create a memory binding via `POST /companies/{id}/memory/bindings` with `providerKey: "builtin_pgvector"`. The pgvector extension must be installed in PostgreSQL (migration 0129).

**Q: Is memory persistent across agent runs?**
A: Yes. Memory records persist in PostgreSQL. The default capture TTL is 30 days. Curated records (via upsert) have no TTL unless one is explicitly set.

**Q: Can agents share memory?**
A: Records with `agentId: null` in scope are visible to all agents. Records scoped to a specific agent are visible only to that agent.

**Q: How do I create a knowledge document?**
A: Use `POST /companies/{id}/knowledge` with a title and body. The document starts as `draft`. Submit for review, get it approved/published.

**Q: Can I edit a published knowledge document?**
A: Not directly. You must archive or create a new draft version. Direct editing creates a new revision but requires transitioning through the lifecycle.

**Q: What happens if I delete a knowledge document?**
A: The document and all its revisions are permanently deleted. There is no soft-delete. Backlinks are also removed.

**Q: I have an approved review but publish still fails. Why?**
A: Starting with v0.4.0 (VOY-1255), publish requires an approved review on the **latest** revision. If you edited the document and re-submitted it after the approval was granted, the old approval is stale. A new review cycle is needed on the current revision.

**Q: What does the `latestReviewStatus` field show?**
A: It shows the outcome of the most recent review — `pending`, `approved`, or `changes_requested` — regardless of the result. Previously it only showed `approved` reviews; now it accurately reflects all review outcomes.

## Troubleshooting

### Agent memory seems empty

1. Check memory binding exists: `GET /companies/{id}/memory/bindings/resolve`
2. If no binding, create one with `builtin_pgvector`
3. Verify pgvector extension is installed in PostgreSQL
4. Check if any records exist: `GET /companies/{id}/memory/records`
5. If records exist but query returns nothing, try different query terms

### Memory query returns unexpected results

1. Hybrid search uses both vector similarity and full-text ranking
2. Results may include low-relevance matches — check `score` field
3. Scope filtering may exclude relevant records — verify scope parameters
4. Try with a smaller `topK` for more precise results

### Knowledge document won't publish

1. Check document status: `GET /companies/{id}/knowledge/{docId}`
2. If `draft`, submit for review first: `POST .../submit-review`
3. If `in_review`, check `latestReviewStatus` field: if not `approved`, approve via `POST .../review`
4. If `in_review` with `approved` status, but publish still fails — the approval may be stale (VOY-1255): submit a new review cycle, get approval on the latest revision
5. If already `published` or `archived`, publishing is a no-op or rejected

### Knowledge document search missing expected results

1. Only `published` documents are searchable
2. Check document status
3. The search is full-text — ensure the query terms appear in the document body or title
4. Very short queries (<3 characters) may not match

## Error States

| Error | User sees | Root cause | Recovery |
|---|---|---|---|
| Memory binding resolve 404 | "No active memory binding" | No binding configured for company/agent | Create a binding |
| Memory scope parse failure | 400 "Invalid scope query parameter: must be valid JSON" | `scope` query param is malformed JSON | Fix the JSON in the `scope` parameter |
| Capture fails | Missing pgvector extension | PostgreSQL not configured for pgvector | Run migration 0129 |
| Agent can't see memory records | 403 Forbidden | Agent trying to access another agent's scope | Use correct agent auth |
| Knowledge document create fails | Validation error | Missing title or body, or body too large | Provide required fields |
| Knowledge document edit fails | "Document is not in draft status" | Trying to edit published/archived doc | Create new draft or transition lifecycle |
| Knowledge document delete fails | 403 Forbidden | Agent trying to delete (board-only) | Use board authentication |
| Knowledge publish fails despite approved review | Publish rejected | Stale approval from prior review cycle (VOY-1255) | Re-run review cycle on the latest revision |
| Search returns empty | "q parameter is required" | Missing search query | Provide query string |
| Knowledge search returns 404 | 404 on `GET /knowledge/search` | Server older than `f09cf3bc6e` — `/:documentId` route shadowed the literal `search` path | Upgrade server to `f09cf3bc6e` or later |
| Knowledge search returns 500 on special-char queries | 500 with a PostgreSQL error | Server older than `75c6c27a41` — hand-built `to_tsquery` rejects punctuation/operators | Upgrade server to `75c6c27a41` or later (plainto_tsquery) |
| Extraction job retry rejected | 400 "Only failed jobs can be retried" | Job status is not `failed` (or changed concurrently) | Re-check job status; only retry `failed` jobs |

## Related Documentation

- [Memory API Reference](/docs/api/memory) (Paperclip)
- [Knowledge Documents API Reference](/docs/api/knowledge) (Paperclip)
- [Deep Planning Support Case Assessment](support-case-v0.4.0-deep-planning.md)
- [Manager-Chain Issue Permissions KB](../kb/authorization-manager-chain-grant.md)
- `/documentation/releases` — v0.4.0-alpha release notes (RC-3)

## Escalation Path

| Issue | Severity | Escalate to | Notes |
|---|---|---|---|
| Memory binding causes database errors | Critical | Staff Engineer | pgvector or schema issue |
| Agent sees another agent's memory records | Critical | CTO | Security violation in scope enforcement |
| Knowledge document data loss (deletion not recoverable) | High | Staff Engineer | Permanent deletion — check backups |
| Knowledge search 404s on /knowledge/search | High | Staff Engineer | Server below `f09cf3bc6e` — route ordering bug; upgrade required |
| Memory capture silently failing | High | Founding Engineer | No error returned but no record created |
| Knowledge search not returning published documents | Medium | Staff Engineer | Search index or query issue |
| Memory query returning no results despite stored data | Medium | Staff Engineer | Embedding or query pipeline issue |
| Knowledge document review workflow stuck | Low | Support Engineer | No transition available — may need manual DB fix |