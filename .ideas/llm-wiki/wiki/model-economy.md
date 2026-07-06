---
title: Model & Provider Economy
type: concept
status: reviewed
sources: [008, 012, 041, 049, 037, combo-02, research-sources]
updated: 2026-06-24
---

# Model & Provider Economy

The defining constraint of an always-on company is the economics of inference. This is the fabric that
decides, per run, *where to run it, on whose credential, and whether the hardware/quota can take it*.

## Mixed-economy fabric (combo-02)

- **Free/private floor (008)** — a first-class `local_llm` adapter (Ollama / LM Studio / llama.cpp, all
  OpenAI-`/v1`-compatible) with $0-cost billing for loopback/LAN endpoints, while still recording tokens
  so [[observability-and-health|productivity metrics]] keep working.
- **Graceful degradation (012)** — per-agent fallback chains (premium API → cheap API → local) triggered
  by quota/429/outage, distinguished from don't-retry errors by the recovery classifiers.
- **Fair sharing (049)** — model a shared credential as a pool with weighted-fair-queue so the noisy
  batch can't starve the CEO agent; reserve capacity for critical roles; backpressure instead of 429.
- **Host-resource awareness (041)** — CPU/RAM/GPU/VRAM probe + capacity-based admission for *local* runs
  (per-model footprint hints to avoid OOM) + a "yield to the human during work hours" profile.

## Cache as a cost lever (037)

Stable-prefix context assembly maximizes prompt-cache hits — see [[economics-and-finance]] for the savings
metric. Local models have their own prefix-caching worth aligning to.

## Why it matters

Makes the "24/7" pitch economically real and is a genuine differentiator (mixed cheap-local / premium-API
fleets). The local tier also makes evals, embeddings, summaries, and handoff briefings *free* across the
rest of the stack ([[agent-quality-and-staffing]], [[knowledge-and-memory]]). GPU spend is the #1 FinOps
concern of 2026, validating the host-resource focus.

## Links

The seam is the [[paperclip-architecture-skeleton|adapter contract]]. Composes with
[[runtime-control-and-safety]] (the breaker prefers the cheap fallback under budget pressure).

## Provenance

- Ideas `008,012,037,041,049`; combo `combo-02`.
- `raw/research-sources.md` → `[otel-finops]` (GPU FinOps).

## Open questions for human review

- Loopback/LAN → `$0 local provider` billing rule needs solid test coverage — misclassification corrupts cost data.
- Cross-platform GPU/VRAM sampling (NVIDIA vs Apple vs AMD) — best-effort scope?
