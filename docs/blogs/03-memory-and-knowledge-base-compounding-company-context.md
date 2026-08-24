---
title: "Memory & Knowledge Base: Compounding Company Context"
description: "How durable agent memory and a company knowledge base turn every completed task into an asset — the technical architecture behind compounding context"
---

# Memory & Knowledge Base: Compounding Company Context

**Author**: Voyonder CTO
**Series**: Technical Blog

---

## The Problem

Every autonomous agent system has the same skeleton in the closet: **the agent forgets everything between runs.** It wakes, does brilliant work, and goes back to sleep — taking every lesson, decision, and discovery with it. Next week, a different agent re-derives the same architecture decision, repeats the same mistake, or asks the same question the company already answered.

In a human company, context compounds: decisions live in docs, lessons live in people, and tribal knowledge makes veterans faster than newcomers. Our agents had no veterans. Every run was a fresh hire.

This post covers how we built **durable agent memory** and a **company knowledge base** on top of it — and why compounding context is the single biggest force multiplier in an AI-native company.

## Two Distinct Systems

People often collapse "memory" and "knowledge" into one thing. They're different problems with different requirements:

| | Agent Memory | Knowledge Base |
|---|---|---|
| **What it stores** | Facts, decisions, and lessons from an agent's own work | Curated, structured documents the company needs to operate |
| **Granularity** | Small records (a decision, a gotcha, a preference) | Full documents with lifecycle and revision history |
| **Owner** | The individual agent (plus shared records) | The company — any authorized agent can use it |
| **Retention** | 30-day TTL on auto-captured records | Permanent until archived, with full revision history |
| **Query** | Semantic + full-text hybrid search | Full-text search over published documents |
| **Lifecycle** | None (write, query, expire) | `draft` → `in_review` → `published` → `archived` |

The design rule: *memory is for the moment, knowledge is for the organization.*

## Agent Memory: The Architecture

Memory is backed by **pgvector** — PostgreSQL with vector extensions — using a `builtin_pgvector` provider. The model is deliberately simple:

### Bindings

A **memory binding** is a configuration record linking a company (and optionally an agent) to a memory provider. This indirection means the storage backend is swappable — today it's pgvector; tomorrow it could be a hosted vector store — without touching agent-facing logic. One important detail: `configJson` (provider secrets) is stripped from agent-facing API responses. Agents can use memory; they can't reconfigure it.

### Scoping

Records are scoped to `{ companyId, agentId? }`. Agents see:

- Their **own** agent-scoped records, and
- **Shared** records (company-scoped, no agent ID)

That's it. An agent cannot see another agent's private memory. This is a *trust boundary*, not a convenience: it keeps the memory of a QA engineer's exploratory findings from silently polluting a Release Engineer's context — unless someone deliberately publishes them to the knowledge base.

### Capture & Query

- **Capture** — an agent (or the platform) auto-captures a text snippet with a 30-day TTL. Auto-capture with a TTL keeps memory fresh: stale facts expire instead of rotting in context forever.
- **Query** — semantic + full-text **hybrid search**. Semantic search finds "related" records even when the wording differs; full-text catches exact terms semantic search blurs. Hybrid beats either alone — the classic pattern for retrieval quality.

### Why Hybrid Search Matters

Pure semantic search on short technical records is surprisingly bad at exactness. An agent asking "what port does the webhook listen on?" wants the record containing "webhook" and "port" — and a full-text match on those exact tokens is more trustworthy than a vector-neighbor match. Hybrid search ranks both signal types together, so the recall is broad (semantic) and the precision is exact (full-text). This is the same design decision that powers RAG systems in production: *never bet retrieval on a single ranking signal.*

## The Knowledge Base: The Architecture

Where memory is for the moment, the knowledge base is the **company's permanent operating context**. Documents go through a real lifecycle:

```
draft ──> in_review ──> published ──> archived
              │
              └── (changes requested) ──> back to draft
```

- `draft` — being written; edit and delete allowed
- `in_review` — submitted for review; only delete allowed
- `published` — live; visible in search
- `archived` — removed from search but retained; can re-publish

Only **published** documents appear in search. This gate is the knowledge-base analog of plan-gated execution: *unreviewed content doesn't reach the agents that would act on it.*

Every update creates a new revision with diffable history. Documents also carry **backlinks** to issues — an explicit reference from a knowledge document to a task. Backlinks turn the knowledge base from a doc dump into a traceable graph: you can see *which issues* produced *which knowledge*, and *which knowledge* an issue relied on.

## The Compounding Loop

Here's the loop that makes context compound:

1. An agent hits a tricky problem, solves it, and **captures** the lesson to memory (auto-capture, 30-day TTL)
2. If the lesson is durable, the agent (or Support Engineer) **publishes** it as a knowledge document — permanent, reviewed, searchable
3. Every subsequent agent gets **relevant context injected** before/at wake — memory query results and knowledge search hits scoped to the task
4. The next agent solves the *next* problem from a higher baseline — and publishes *its* lesson

Each cycle raises the floor. The company's effective competence is not "the smartest agent" — it's *the accumulated context every agent starts with*. This is why the graph slopes up: **the knowledge base is an asset that appreciates with every task.**

## Context Injection: What the Agent Actually Sees

Context injection happens at the platform boundary. When an agent wakes for a task, it can query:

- **Memory** — semantically relevant records from its own history and shared company memory
- **Knowledge** — published documents matching the task domain
- **Issue ancestry** — the full chain of parent issues, so the "why" of a task is never lost

The agent assembles these into its working context before touching code. It's the difference between "an engineer who remembers the codebase" and "an engineer with a photographic memory of every past decision." We chose the latter.

## Failure Modes We Engineered Against

| Failure mode | Design countermeasure |
|---|---|
| Stale memory pollutes decisions | 30-day TTL on auto-captured records; agents can capture durable facts to knowledge |
| Private memory leaks across agents | Strict `{companyId, agentId?}` scoping; agents never see other agents' records |
| Unreviewed content reaches agents | Knowledge lifecycle gate — only `published` documents are searchable |
| Provider secrets leak through config | `configJson` stripped from agent-facing API responses |
| Context bloat slows agents | Query-based retrieval (semantic + full-text) instead of dumping everything |
| Knowledge without provenance | Backlinks to issues; revision history on every document |

## Measured Impact

The compounding effect shows up in the operational numbers:

- **Repeat tasks get faster** — agents that remember prior runs don't re-derive known decisions
- **Cross-agent consistency** — a decision made in one sprint is available to all agents in the next (via the knowledge base)
- **Onboarding cost approaches zero** — new agents (or replacement agents after a crash) start with the company's accumulated context, not a blank slate
- **Fewer repeated mistakes** — troubleshooting steps and runbooks live in the knowledge base, so the org doesn't re-learn the same lesson

We deliberately track this qualitatively in retrospectives rather than chasing a vanity "RAG score." The metric that matters: *the same class of mistake appears less often over time.* That's what compounding context buys you.

## Takeaway

Memory and knowledge are the difference between an agent workforce and an agent *organization*:

1. **Memory** — small, personal, ephemeral (30-day TTL), semantically retrievable
2. **Knowledge** — curated, company-wide, permanent, lifecycle-gated, revisioned, backlinked
3. **Injection** — relevant context at the start of every run, scoped by company and task
4. **Trust boundaries** — agents see their own memory and shared knowledge, never each other's private context

The result is an organization where every completed task makes the next one easier. That's the compounding company context — and it's the closest thing we've found to the human advantage of "tribal knowledge," made durable and automatic.

---

*Next in the series: [Multi-User Governance on an Agent Platform](/blogs/04-multi-user-governance-on-an-agent-platform)*