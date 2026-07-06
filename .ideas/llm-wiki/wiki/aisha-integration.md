---
title: Aisha × Paperclip Integration
type: synthesis
status: reviewed
sources: [PAPERCLIP_INTEGRATION, 008, 027, 060, 066, research-sources]
updated: 2026-06-24
---

# Aisha × Paperclip Integration

Aisha (a voice-first, multi-LLM, RAG-equipped personal assistant moving toward a multi-agent system with
a *chief* over domain-leader agents) and Paperclip are **complementary halves of one system**.

## Thesis

> **Aisha is the interactive command layer & chief; Paperclip is the orchestration substrate her org runs
> on; the domain leaders are shared agents with one definition and two faces (conversational + autonomous).**

The human speaks to one chief; behind her stands a governed, budgeted, 24/7 workforce.

## What each fills in the other

- Aisha already has the **agent-definition primitive** (`AIFriend` ≈ a Paperclip agent) and proto
  domain-leaders (`researcher`/`coder`/`creative` personas) — but **no orchestration layer** (delegation,
  heartbeats, budgets, governance). That gap *is* Paperclip ([[paperclip-architecture-skeleton]]).
- Aisha → Paperclip: a working **local RAG engine** (≈ [[knowledge-and-memory|idea 060]]), a **voice /
  fast-approval front end** ([[human-in-the-loop]], idea 027 + chat 066), and **local-LLM** know-how
  ([[model-economy]], idea 008).
- Paperclip → Aisha: budgets, fallback chains, **governance/trust**, scheduling, multi-agent scale.

## The seam: MCP (both already speak it)

- Paperclip-as-MCP-server → Aisha drives the company by voice (status/approvals/directives).
- Aisha-as-MCP-tools → Paperclip agents gain voice, web crawler, local retriever.

## Two-tier architecture (the multi-agent direction)

- **Tier 1 (Aisha, synchronous/voice):** the chief — converse, quick tasks, *route*.
- **Tier 2 (Paperclip, async/autonomous):** delegate team/budget/24-7 work; results report back by voice.
- Chief's new skill = **mode routing** (sync vs async), i.e. [[agent-quality-and-staffing|capability
  assignment]] one level up. **One agent definition, two faces.**

## Build-vs-reuse decision (for human review)

Recommended: reuse Paperclip as the orchestration substrate (or a hybrid: thin contract in Aisha +
Paperclip as the heavyweight provider), rather than rebuilding the whole backlog in Python.

## Provenance

- `/home/user/Documents/Aisha/PAPERCLIP_INTEGRATION.md`; ideas `008,027,060,066`.

## Open questions for human review

- Standalone Aisha orchestrator vs. Paperclip-backed vs. hybrid — this decision shapes everything.
- Is voice/chat the *primary* operator surface, or one channel among many?
