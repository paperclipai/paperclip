# Phase 6: Jarvis, Quality, and Hybrid Search - Discussion Log

> Audit trail only. Decisions are captured in CONTEXT.md.

**Date:** 2026-04-25
**Phase:** 6 - Jarvis, Quality, and Hybrid Search
**Mode:** `--auto --chain`

## Auto-Selected Decisions

| Area | Selected Direction | Reason |
|------|--------------------|--------|
| Jarvis grounding | Live RT2 task/wiki/graph/deliverable evidence | Satisfies `JARV-01` without introducing external AI dependency first |
| Quality modes | Explicit Shadow, Co-Pilot, Auto request modes | Satisfies `QUAL-01` and preserves approval boundaries |
| Hybrid search | Lexical plus deterministic semantic-style rerank | Satisfies `QUAL-02` with verifiable local behavior |

## Deferred Ideas

- External embedding or LLM reranking after the evidence-backed local path is stable.
