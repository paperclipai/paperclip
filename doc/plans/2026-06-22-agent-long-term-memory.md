# Per-Agent Long-Term Memory: Design and Strategy Comparison

Date: 2026-06-22
Status: Design exploration for issue [#6](https://github.com/antoinekm/atelier/issues/6)
Related: [doc/memory-landscape.md](../memory-landscape.md), `para-memory-files` skill, `routines` schema

## 1. Goal

Give Atelier agents a durable, per-agent long-term memory so they grow their own
competence instead of starting from zero each run. Agents have a stable identity
(CTO, CMO, and so on). They must recall past decisions, accumulate semantic facts,
keep reusable procedures, and capitalize lessons from incidents. This is the
opposite of a disposable agent.

This document compares implementation strategies and recommends a target
architecture. It is a study, not yet a build contract.

## 2. The brain-inspired model is the state of the art

The intuition of modeling memory on the human brain is not naive. It is exactly
where the field converged in 2025 and 2026. The canonical academic taxonomy is
CoALA (Cognitive Architectures for Language Agents), reused by Letta, Mem0, and
LangChain. Four memory types, which map almost one to one onto primitives Atelier
already has:

| Brain type | Role | Existing Atelier primitive |
|---|---|---|
| Working memory | Context of the current run | `context_mode` thin/fat on agents |
| Episodic | What happened, raw experience traces | `heartbeat_runs`, `issues`, `issue_comments` |
| Semantic | Consolidated durable facts and preferences | to build (`MEMORY.md` per agent) |
| Procedural | Skills, playbooks, learned rules | `company_skills` (and issue #5 skills) |

### Consolidation ("dreaming")

The most relevant 2026 development for us: Anthropic shipped "Dreaming" on
2026-05-06 for managed agents, modeled explicitly on hippocampal consolidation.
It runs asynchronously between sessions, reviews session transcripts and existing
memory, extracts patterns, merges duplicates, replaces stale entries, and rewrites
long-term memory for future sessions.

The open-source pattern (OpenClaw style) is a three-phase background pipeline:

1. Light sleep (ingestion): read session transcripts and notes, deduplicate
   (for example Jaccard similarity), stage candidates in short-term recall without
   writing to permanent memory.
2. REM sleep (pattern extraction): analyze recurring themes across staged material,
   identify candidate truths that appear repeatedly.
3. Deep sleep (promotion): score candidates on weighted signals (relevance,
   frequency, query diversity, recency, consolidation, conceptual richness), apply
   threshold gates, promote only high-confidence entries to long-term memory, expire
   stale candidates past a max age.

This is the user's "brain" idea in a concrete, debuggable form. We take the brain
for its structure (memory types plus a consolidation cycle), not for neuronal
fidelity. Faithful brain replicas (oscillatory graphs, three-factor plasticity,
simulated sleep stages) exist in 2026 papers but are research, not product.

## 3. Strategy comparison

Four candidate providers, evaluated for a local-first, self-hosted, public fork
that already runs on Claude Code adapters and Postgres or PGlite.

| Option | License | Storage | Self-host cost | Benchmark signal | Fit for Atelier |
|---|---|---|---|---|---|
| Homegrown markdown + dreaming (memsearch / para-memory-files style) | ours | Postgres + markdown files | none beyond our own DB | n/a (we own quality) | High: zero config, inspectable, aligned with memory-landscape.md |
| Mem0 | Apache 2.0 (OSS core; graph and analytics are paid cloud) | pgvector + Neo4j (3 Docker containers) | medium: adds Neo4j | ~92.5% LoCoMo, ~94.4% LongMemEval, sub-7k tokens per retrieval | Medium: strong recall, but pulls in Neo4j and a FastAPI server |
| Letta (ex MemGPT) | OSS, free self-host | its own runtime, tiered core/recall/archival | medium: it is a runtime, not a library | ~93.4% DMR | Medium: opinionated runtime that wants to own the agent loop, which our adapters already own |
| Zep / Graphiti | Graphiti Apache 2.0; Zep Cloud commercial | Neo4j, FalkorDB, or Kuzu temporal knowledge graph | high: graph DB plus embedding plus LLM pipeline | best temporal accuracy (63.8% vs 49.0% vector-only on temporal tasks) | Low to medium: best if we need temporal reasoning, heavy to self-host now |

### Reading of the table

- Frameworks are strong on recall but each adds operational weight (Neo4j for Mem0
  and Zep, a competing runtime for Letta). For a local-first product whose first
  promise is "works with no config," that weight is a real cost.
- The markdown-first baseline is weakest on large-scale semantic and temporal
  recall, but strongest on inspectability, zero config, and alignment with our own
  design doc. It is also the closest to how Claude Code memory and `para-memory-files`
  already work in this repo.
- These are not exclusive. The memory-landscape.md two-layer model lets us start
  homegrown and plug a framework in later as a provider, behind the same contract.

## 4. Security: memory is now an attack surface

This matters more for Atelier than for a toy, because our agents are durable and
autonomous. A bad or malicious memory persists and propagates with no human in the
loop. 2026 research is explicit:

- Memory poisoning turns a transient prompt injection into a durable control channel
  by persisting malicious instructions in long-term memory.
- Pure retrieval (RAG over a vector store) is structurally incapable of forgetting,
  so the agent and the control plane must actively curate.
- "Mnemonic sovereignty" is proposed as the target: verifiable, recoverable
  governance over what may be written, who may read, when updates are authorized,
  and which states may be forgotten.
- Memory evolution must be decoupled from memory governance (SSGM framework).

Implication for us: the Atelier control-plane layer owns write authorization,
provenance, forgetting, correction, and (for sensitive writes) approval. This is
the same escalation and governance spine as the rest of Atelier, not a separate
system.

## 5. Recommended architecture

Follow the two-layer model from memory-landscape.md, start with the homegrown
markdown provider, and ship dreaming in V1 (per the product decision on this issue).

### Layer A: control plane (Atelier owns)

- Scope: company, agent, project. Per-company default provider, per-agent override.
- Provenance: every memory links back to a `heartbeat_run`, `issue`, or
  `issue_comment`.
- Governance: write authorization, forgetting, correction, and approval hooks for
  sensitive memory. Redaction so secrets never land in memory text.
- Usage reporting: token and latency cost recorded like other control-plane work
  (reuse `cost_events`).

### Layer B: provider adapter (pluggable)

- Default baseline: markdown-first, local, inspectable. One `MEMORY.md` per agent
  plus structured records in Postgres. Same spirit as `para-memory-files`.
- Portable contract (minimal): `write`, `recall`, `browse`, `get by handle`,
  `forget`, `usage report`.
- Later providers (Mem0, Zep) implement the same contract without re-architecting.

### Dreaming (V1, scheduled via existing `routines`)

A consolidation routine per agent, running off the existing `routines` and
scheduler infrastructure (no new queue needed):

1. Light sleep: ingest the agent's recent run transcripts and comments, deduplicate,
   stage candidates.
2. REM sleep: extract recurring patterns and candidate lessons (one LLM pass).
3. Deep sleep: score, gate, promote durable memories, expire stale candidates,
   record provenance and an audit entry.

Memory types map as: episodic comes for free from runs and comments, semantic is
the promoted `MEMORY.md` content, procedural ties into `company_skills` and the
skills work in issue #5, and incident lessons are a first-class promoted category
(this is also the seed of Automatic Organizational Learning on the roadmap).

## 6. Reuse versus new

- Reuse: `routines` (dreaming schedule), `heartbeat_runs` and `issue_comments`
  (episodic source and provenance), `cost_events` (usage), `company_skills`
  (procedural), activity log (audit), `company_secrets` redaction policy.
- New (sketch, to refine before building):
  - `agent_memories`: id, company_id, agent_id, scope, type
    (episodic/semantic/procedural/lesson), body, status (staged/active/forgotten),
    confidence, source provenance refs, created_at, updated_at.
  - `agent_memory_provider_configs`: per-company or per-agent provider binding.
  - Consolidation run records (or reuse routine_runs with a memory payload).

## 7. Design decisions (resolved 2026-06-22)

1. Source of truth: hybrid. Postgres is the source of truth (scope, provenance,
   governance, search). A human-readable `MEMORY.md` is rendered per agent for
   inspection, not authoritative.
2. Memory scope in V1: per-agent only, partitioned by the durable agent identity
   (issue #7). Company-level shared memory is deferred to V2.
3. Identity is the partition key: memory attaches to the person, not the role.
   Renaming an agent's role does not reset its memory.
4. Recall injection (default, may revisit): a consolidated summary is injected into
   run context, with an API query path available for on-demand recall. Ties into
   `context_mode`.
5. Dreaming runs in V1, scheduled via existing `routines`.

Still to confirm during build:

- Approval policy for sensitive memory writes (always auto vs gate certain types).
- Dreaming cadence (nightly cron vs every N runs) and budget guardrails so
  consolidation itself respects agent budgets.

## 8. Suggested phasing

- Phase 1: control-plane layer plus markdown baseline provider. Write and recall
  with provenance. Redaction and forgetting primitives in place.
- Phase 2 (still V1 per decision): dreaming routine (light/REM/deep), incident lesson
  capture, audit.
- Phase 3 (post-V1): pluggable framework provider (Mem0 or Zep) for large-scale
  semantic or temporal recall, company-level shared memory, richer governance.

## References

- AI agent memory frameworks 2026: https://atlan.com/know/best-ai-agent-memory-frameworks-2026/
- Mem0 vs Zep vs Letta comparison: https://particula.tech/blog/agent-memory-frameworks-tested-mem0-zep-letta-cognee-2026
- Mem0 open source overview: https://docs.mem0.ai/open-source/overview
- Zep / Graphiti open source: https://github.com/getzep/graphiti
- OpenClaw dreaming guide (background consolidation): https://dev.to/czmilo/openclaw-dreaming-guide-2026-background-memory-consolidation-for-ai-agents-585e
- SCM: Sleep-Consolidated Memory for LLMs: https://www.emergentmind.com/papers/2604.20943
- Survey on security of long-term memory in LLM agents (mnemonic sovereignty): https://arxiv.org/abs/2604.16548
- Memory poisoning attack and defense: https://arxiv.org/abs/2601.05504
- Governing evolving memory (SSGM framework): https://arxiv.org/html/2603.11768v1
</content>
