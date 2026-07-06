# LLM-Wiki Index

Catalog of compiled concept pages. Retrieval starting point. See `CLAUDE.md` for conventions, `log.md`
for history, `raw/` for immutable sources. Updated 2026-06-24.

## Foundations
- [[llm-wiki]] — the Karpathy pattern this knowledge base follows (compounding knowledge vs. RAG).
- [[paperclip-architecture-skeleton]] — Paperclip reverse-engineered to 5 tables + one loop + an adapter.
- [[aisha-integration]] — Aisha (voice/RAG multi-agent chief) × Paperclip (orchestration substrate).

## Control, safety & economics
- [[runtime-control-and-safety]] — admission/throttle/halt control plane; Autonomy Dial; Night-Shift.
- [[model-economy]] — local LLM, fallback chains, credential pooling, host-resource awareness, cache.
- [[economics-and-finance]] — CFO suite, cost-attribution spine, capital allocator (bandit).

## People, quality & knowledge
- [[human-in-the-loop]] — review cockpit, approvals, mobile push, digest, chat channel (Telegram/WhatsApp).
- [[observability-and-health]] — health sentinel: tracing + detectors (thrash/deadlock/drift) + heatmap.
- [[agent-quality-and-staffing]] — agent CI/CD, self-staffing, self-healing org, the improvement flywheel.
- [[security-governance]] — zero-trust layer, trust-as-currency, provenance & replay (auditability).
- [[knowledge-and-memory]] — knowledge system, handoff briefings, experiments, code-knowledge flywheel.

## Build, scale & integrate
- [[software-building-and-self-hosting]] — software-building capability + self-hosting + bootstrap ladder.
- [[pre-flight]] — one "simulate before commit" seam for every consequential action.
- [[multi-company-and-ecosystem]] — holding company, shared services, mailbox, adoption kit, marketplace.
- [[external-integration]] — inbound intake, outbound webhooks, the Front Desk pipeline.
- [[resilience-recovery]] — rewind, DR drills, incident/on-call, plugin health.

## Concept aliases (covered within a pillar; bare `[[links]]` resolve here)
- `bootstrap-ladder` → [[software-building-and-self-hosting]]
- `self-healing-org`, `staffing` → [[agent-quality-and-staffing]]
- `trust-as-currency`, `provenance-and-replay` → [[security-governance]]
- `cost-attribution`, `capital-allocator` → [[economics-and-finance]]
- `night-shift` → [[runtime-control-and-safety]]
- `code-knowledge-flywheel` → [[knowledge-and-memory]]
- `front-desk` → [[external-integration]]
- `chat-channel` → [[human-in-the-loop]]

## Coverage
All 66 source ideas (`001`–`066`), all 13 thematic combos, all 12 cross-cutting combos (`xcombo-01..11` +
flywheel), the skeleton reference, and the Aisha integration are cited across the 16 pages above (see each
page's `## Provenance`). Every page carries `## Open questions for human review`.

## Gaps to compile next (lint)
- Dedicated pages for the highest-traffic aliases (e.g. `bootstrap-ladder`, `provenance-and-replay`) if
  they outgrow their pillar section.
- Pages for queued cross-cutting cuts not yet written as combos: `xcombo-12` (Conversational Operator),
  `xcombo-13` (Reproducible Run), `xcombo-14` (Marketplace), `xcombo-15` (Closed-Loop Run Efficiency).
