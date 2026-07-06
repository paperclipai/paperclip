---
title: Runtime Control & Safety
type: concept
status: reviewed
sources: [001, 002, 005, 014, 024, 035, 042, 061, combo-01, xcombo-01, xcombo-05, research-sources]
updated: 2026-06-24
---

# Runtime Control & Safety

How much should run right now, and how is it stopped safely? Today Paperclip enforces concurrency only
*per agent* (no fleet/company cap), hits budgets post-hoc, and has no instant halt — the #1 risk for an
always-on fleet (runaway spend, machine thrash, rate-limit storms).

## The unified control plane (combo-01)

One admission/throttle seam at the single run-start choke point evaluates nested limits:
- **Per run** — wall-clock / tool-call / token / cost caps with graceful checkpointed wind-down (024).
- **Per agent** — concurrency + adaptive heartbeat (035, idle backoff / load speed-up) + WIP limits (061).
- **Per company / fleet** — a concurrency governor (001) modulated by quiet-hours profiles (005) and a
  predictive budget breaker that throttles *before* the wall (002).
- **Safety** — Drain (stop starting) + Panic Stop (halt+cancel) with non-stampeding resume (014).
- **Correctness** — workspace soft-locks so parallel agents don't clobber (042).

Precedence: **panic/drain > breaker > manual > schedule > default.**

## The operator abstraction: the Autonomy Dial (xcombo-01)

Collapse the knobs into one ordinal "how much leash" control (Level 0–5), each level a coherent preset
across admission/breaker/auto-approve/caps/heartbeat/[[security-governance|trust]]. It auto-retreats on
trips and auto-advances as the company proves itself — see [[agent-quality-and-staffing]] (trust ramp).

## The unattended profile: Night-Shift (xcombo-05)

An armed "no-human-present" posture bundling spend bounds, local-first resilience ([[model-economy]]),
idle backoff, egress lock, human coverage, and a morning digest. Grounded in real 2026 overnight-agent
incidents (a coding agent burning $$ overnight; an agent hijacking GPUs for crypto-mining → egress lock).
Surfaces a new requirement: **mid-run credential renewal** for long unattended runs.

## Provenance

- Ideas `001,002,005,014,024,035,042,061`; combos `combo-01`, `xcombo-01`, `xcombo-05`.
- `raw/research-sources.md` → `[guardrails]`.

## Open questions for human review

- Ship order: governor (001) first, or the Autonomy Dial abstraction over stubs?
- Where exactly is the single choke point that must honor `halted` (incl. process recovery)?
- Default Autonomy-Dial level for a fresh company?
