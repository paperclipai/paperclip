# ADR-PAPERCLIP-004: Memory Federation — LightRAG + Mem0 + SSOT

- Status: Proposed
- Date: 2026-07-21
- Owners: @haykel1977 (Quantum Engineering), Paperclip Core Team
- Related tasks/PRs: ADR-IA-002/003 (Quantum reference), ADR-MEMORY-001, HippoRAG2 pattern review, Cross-repo audit 2026-07-21

## Context

Agent memory in the CBS-BIS ecosystem is fragmented across multiple repos and storage mechanisms:

1. **CBS-BIS repo**: `memory/` directory with YAML-based knowledge graph (PARA method via `para-memory-files` skill). Contains durable facts about the codebase, architecture decisions, and user patterns. Scoped to CBS-BIS domain only.
2. **Quantum repo**: `memory/` directory with similar structure but different conventions (pr-patterns, pr-antipatterns, ci-failures, review-lessons). Contains orchestration-layer knowledge.
3. **Paperclip**: Task-level memory in Postgres (task descriptions, assignments, status). No semantic search capability. No cross-repo memory correlation.
4. **Agent session memory**: Each agent (Codex, Claude, OpenHands) maintains its own session context. No persistent cross-session memory. When a Codex session hands off to Claude, context is lost unless manually copied into the handover comment.

This fragmentation creates concrete problems:

- **Knowledge silos**: A Codex session working on CBS-BIS cannot access Quantum's CI failure patterns, leading to repeated mistakes. Claude doing a code review cannot access CBS-BIS domain rules without manually loading skills.
- **Cross-tenant leak risk**: If memory is federated without strict tenant scoping, a query for "payment processing patterns" could return memories from different tenants' contexts. This is a critical security violation for a banking system.
- **Single point of failure**: If one repo's memory store goes down (e.g., CBS-BIS `memory/` directory is corrupted), all agents lose access to that knowledge domain. No fallback.
- **No semantic retrieval**: Current memory is file-based (YAML, Markdown). Agents must `read` entire files to find relevant context. There is no vector-based semantic search that could answer "what was the last decision about payment gateway integration?" across all repos.

The core challenge is: **federate memory reads/writes across repos without creating a single point of failure or cross-tenant data leak**. Paperclip, as the cross-repo control plane, is the natural home for the federation bus — but it must not become a centralised memory store that replaces repo-owned SSOT.

## Options considered

1. **Option A: LightRAG (cross-repo semantic retrieval) + Mem0 (per-agent session memory) + SSOT (repo-owned durable facts).** LightRAG provides vector-based semantic search across a pgvector-backed index. It ingests from each repo's `memory/` directory and provides cross-repo retrieval via a unified query API. Mem0 provides per-agent, per-session memory with built-in relevance scoring and decay. SSOT remains the source of truth in each repo — LightRAG indexes *copies* of SSOT facts, not the SSOT itself. All memory writes are tenant-scoped via a `tenant_id` column and RLS policies.

2. **Option B: Centralised vector database (single Pinecone/Weaviate index).** All memory from all repos is indexed in one centralised vector database. Simple query interface.

3. **Option C: File-based federation with rsync/symlinks.** Each repo's `memory/` directory is symlinked or rsynced to a shared location. Agents read from the shared location. No semantic search.

## Decision

**Adopt Option A: LightRAG + Mem0 + SSOT federation pattern.**

Rationale:

- **No single point of failure**: LightRAG indexes *copies* of SSOT facts, not the SSOT itself. If LightRAG goes down, agents can still fall back to direct file reads (the SSOT). If a repo's SSOT goes down, LightRAG's cached index still provides recent context. This two-layer architecture (SSOT + indexed copy) is more resilient than any centralised approach.
- **Cross-tenant isolation**: Every memory record in LightRAG includes a `tenant_id` column. PostgreSQL RLS policies enforce that queries only return memories for the requesting tenant. This is enforced at the database level, not application code — eliminating the risk of cross-tenant leaks via application bugs. The `audit-rls` skill can verify RLS coverage on memory tables.
- **Semantic retrieval without replacing SSOT**: LightRAG's vector index enables queries like "what decisions were made about payment processing across all repos?" which file-based systems cannot answer efficiently. But the index is a *read-optimized copy*, not the authoritative source. SSOT remains authoritative in each repo.
- **Per-agent session memory**: Mem0 provides lightweight, per-agent, per-session memory with automatic relevance scoring and time-based decay. This handles the "what was I working on 10 minutes ago?" use case that LightRAG (designed for durable facts) does not address. Mem0 is agent-scoped — agent A cannot read agent B's session memory.
- **HippoRAG2 pattern alignment**: The hippocampal-inspired retrieval pattern (semantic index for long-term memory, working memory for session context, consolidation for promoting session facts to durable memory) maps directly to LightRAG (long-term) + Mem0 (working) + SSOT (consolidated).
- **Sovereign deployment**: LightRAG and Mem0 can be self-hosted on Hetzner (sovereign-first posture). No external API calls for memory operations. pgvector runs in the same Postgres instance as Paperclip's task data.
- **Cross-repo correlation**: LightRAG's index spans all repos. A query for "agent handover patterns" returns results from both CBS-BIS and Quantum. But each result carries its `repo_scope` (from PAIF, ADR-PAPERCLIP-002) so the agent knows the provenance.

Concrete architecture:
```
┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│  CBS-BIS     │  │  Quantum     │  │  Paperclip   │
│  memory/     │  │  memory/     │  │  Postgres    │
│  (SSOT)      │  │  (SSOT)      │  │  (tasks)     │
└──────┬───────┘  └──────┬───────┘  └──────┬───────┘
       │                 │                 │
       ▼                 ▼                 ▼
┌─────────────────────────────────────────────────┐
│           LightRAG Federation Bus                │
│  ┌─────────────────────────────────────────┐    │
│  │  pgvector index                         │    │
│  │  - embeddings (tenant_id, repo_scope)   │    │
│  │  - RLS: WHERE tenant_id = $1            │    │
│  └─────────────────────────────────────────┘    │
│  ┌─────────────────────────────────────────┐    │
│  │  Mem0 session store                     │    │
│  │  - per-agent, per-session               │    │
│  │  - TTL-based decay                      │    │
│  └─────────────────────────────────────────┘    │
└─────────────────────────────────────────────────┘
       │
       ▼
┌──────────────┐
│  Agent Query  │  ← Semantic search with tenant isolation
└──────────────┘
```

Memory write flow:
1. Agent produces a fact (e.g., "payment gateway X requires HMAC signing")
2. Write to repo's SSOT (authoritative, file-based)
3. Write to LightRAG index (async, for cross-repo retrieval) with `tenant_id` and `repo_scope`
4. Optionally promote to Mem0 session memory if relevant to current session

Memory read flow:
1. Agent queries: "what do we know about payment gateway integration?"
2. LightRAG searches pgvector index (RLS-enforced, tenant-scoped)
3. Results include `repo_scope` and `source_uri` for provenance
4. Agent can fall back to direct SSOT file reads if LightRAG results are insufficient

## Consequences

- Positive outcomes:
  - Cross-repo semantic search without centralising authoritative data
  - Tenant isolation enforced at database level (RLS), not application code
  - No single point of failure (SSOT fallback if LightRAG/Mem0 unavailable)
  - Per-agent session memory with automatic decay (Mem0)
  - Sovereign deployment (self-hosted on Hetzner, no external API calls)
  - Provenance tracking (every memory result includes repo_scope, source_uri)

- Negative tradeoffs:
  - Index staleness: LightRAG index is async-replicated from SSOT, so there is a propagation delay (mitigated by eventual consistency + staleness indicator in query results)
  - Operational overhead: Three memory systems (SSOT + LightRAG + Mem0) to maintain
  - pgvector index size grows with repo memory (mitigated by periodic pruning of expired entries)
  - Embedding quality determines retrieval quality (mitigated by using high-quality embedding models)

- Risks:
  - Cross-tenant leak if RLS policies are misconfigured (mitigated by `audit-rls` skill running on every migration)
  - LightRAG index corruption (mitigated by being a derived index — can be rebuilt from SSOT)
  - Mem0 session memory leaking between agents (mitigated by agent-scoped namespaces in Mem0)

## Validation and rollback

- **Validation**:
  1. RLS test: Insert memory records for tenant A, query as tenant B, verify zero results
  2. Index rebuild test: Delete LightRAG index, trigger rebuild from SSOT, verify completeness
  3. Fallback test: Disable LightRAG, verify agents can still read from SSOT directly
  4. Cross-repo query test: Query "payment patterns" from CBS-BIS agent, verify results from Quantum are returned with correct `repo_scope`

- **Rollback**: If LightRAG proves too complex, supersede this ADR and fall back to file-based federation (Option C) with added `tenant_id` tags in YAML frontmatter. The SSOT layer is always available as fallback. If Mem0 is problematic, replace with simple in-memory session cache (Redis-backed).

## Follow-up actions

1. Deploy pgvector extension in Paperclip Postgres
2. Set up LightRAG with ingestion pipelines for CBS-BIS and Quantum `memory/` directories
3. Configure Mem0 with per-agent session namespaces
4. Implement RLS policies on memory tables and verify with `audit-rls` skill
5. Add `tenant_id` to all existing memory records (migration)
6. Create ingestion cron job to sync SSOT → LightRAG index (hourly)
7. Update `para-memory-files` skill to write through to LightRAG index
8. Document memory federation architecture in `docs/architecture/memory.md`
