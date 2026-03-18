---
name: DIYBrand Product Context
description: What diybrand.app is, current build state, and MVP completion status
type: project
---

DIYBrand is an AI-powered brand identity generator for small businesses and solopreneurs who can't afford a designer.

**Why:** $500-2000 designer cost is prohibitive for early-stage businesses. Generic logo makers don't produce cohesive brand identities.

**How to apply:** All product decisions should optimize for solo-founder economics — low operational cost, one-time payment model, algorithmic where possible (save AI API costs for the differentiator: logo generation).

## Current State (2026-03-18)
- **MVP COMPLETE** — DIY-5 closed
- 9-step wizard: questionnaire (5 steps) → palette → typography → logo → export/checkout
- Brand kit ZIP export with payment gating via Stripe ($19 basic / $49 premium)
- Zero ongoing API cost for palette/typography; logo on Gemini free tier (50 img/day)

## MVP Subtasks (all done)
- DIY-6: Color palette generator ✓
- DIY-7: Typography pairing ✓
- DIY-8: AI logo generation (Gemini Imagen) ✓
- DIY-9: Brand kit ZIP export ✓
- DIY-10: Stripe checkout ✓

## Stretch Goals (not started)
- Social media template generator
- Business card mockup
- Brand guidelines PDF export
- User accounts / save & edit later

## Roadmap Status (2026-03-18)
- **Sprint 1: DONE** — Copy/meta/CTA/headline changes shipped (DIY-29)
- **Sprint 2: DONE** — Social proof & trust signals
  - DIY-30: Testimonial upgrade ✓
  - DIY-31: 30-day money-back guarantee ✓
  - DIY-32: Competitor price comparison ✓
  - DIY-33: Early access pricing copy ✓
- **Sprint 3:** Performance optimization (approved, not started) — Lighthouse 64→85+ target
- **Sprint 4:** Design system maturity (approved, not started)

## Key Decisions
- Google Gemini Imagen for logo generation (free tier, 50 img/day, GEMINI_API_KEY available) — board decision 2026-03-18
- No user accounts in v1 — email-based order matching via Stripe
- Pricing: $19 basic / $49 premium confirmed. Early access promotional pricing (not permanent). Drop all $14.99 references. — CEO decision 2026-03-18
- 30-day money-back guarantee, no questions asked — CEO decision 2026-03-18
- "Designed in Sweden" deferred to Month 2 — CEO decision 2026-03-18
