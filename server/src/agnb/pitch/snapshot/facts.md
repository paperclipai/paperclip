# Finn — Product Facts (hand-curated from hf-web-v2 marketing corpus)

> Source of truth for deck copy. Structured numbers (pricing, ROI, capabilities,
> testimonials) come from the JSON files in data/ — this file is the prose
> positioning. Keep in sync via SOURCES.md.

## What Finn is (one line)
Finn is the enterprise **voice orchestration layer**. It makes thousands of
concurrent phone calls, reasons through them in real time, extracts data, and
writes it back to your systems. No rework. No idle time.

Not a wrapper — the voice intelligence, observability, orchestration,
integration, and security layer for teams shipping at production scale.

## The problem Finn kills — the "swivel-chair tax"
The phone still runs the world's businesses, and most are quietly losing on it.
Between the dialer and the CRM sits human middleware — and that gap is the
swivel-chair tax:
- Ring-tone idle: reps spend ~70% of a shift waiting on dial tones
- Manual CRM entry: 4–8 minutes of typing after every connected call
- Headcount scales linearly with ambition
- Data decay: ~40% of CRM data rots per year
- Unstructured call data, no searchable record
- Compliance risk on every unrecorded, unconsented call

Human status quo: ~14 minutes to handle ONE connected call.
With Finn: 2:35 to handle EIGHT calls in parallel.

## How it works (3 steps)
1. BUILD — design the agent (persona, prompt, knowledge base, call workflow) in
   a visual no-code editor. Pick voice, language, LLM.
2. DEPLOY — attach a number, point at an inbound line or an outbound audience,
   go live. Live / scheduled / dynamic deployments.
3. ANALYZE — every call transcribed, sentiment-scored, searchable. Pickup rate,
   outcomes, cost per result on one dashboard.

## Capabilities (real, from platform)
- Sub-second voice loop: streaming ASR + LLM + TTS, <400ms end-to-end latency
- 46 languages live; switch mid-call, same persona
- Function calling in-call: CRM pulls, webhooks, business logic mid-conversation
- Knowledge base + RAG: PDFs, sitemaps, FAQs → grounded answers
- Voice library: 100+ voices; brand voice cloning in under a minute
- Real-time speech detection: interrupt handling, silence + voicemail discrimination
- Live human handoff / warm transfer when sentiment turns
- 37 product features across comms (SMS/WhatsApp/email/chat), routing/telephony
  (warm transfer, IVR replacement, BYOC SIP), calendar/booking, ops/compliance
  (consent, DNC, audit logs, PII redaction), analytics

## Trust & principles (manifesto)
- If a caller asks, Finn says it's AI. Always.
- Operators stay in control: no-code management, per-deployment control, full audit.
- When sentiment turns, Finn hands off to a human, fast.
- We measure outcomes, not minutes.
- We'd rather be boring and reliable than clever and broken.
- Scale: 100,000+ calls a day at 99.9% SLA.

## Security
HIPAA, GDPR, SOC 2, enterprise controls. Data residency. Audit trail per call.
Number health monitoring (degraded numbers auto-paused). Consent + DNC management.

## Commercial (real — see plans.json)
Wallet-based, not a subscription. Top up once, pay per AI credit at your plan
rate. Credits never expire. Plans: Starter / Pro / Growth / Enterprise set the
per-credit rate, minimum top-up, and concurrent-call cap. Phone numbers billed
separately. India billed in INR (+18% GST), else USD.

## Proof (real — see testimonials.json)
- Snazzy: conversion 65%→82%, agent workload −40%, response under 2 min
- Orbit Wallet: call abandonment ~30%→5%, 75–80% inbound fully handled, replaced 80+ offshore agents
- Frinks AI: 70% of production-support calls contained, 800+ man-hours saved/month, wait under 30s
- RocketSDR: 97% engagement growth, eliminated candidate ghosting
- TOFA: 10K+ calls/day national campaign, seamless human escalations
- Pillar Bridge: 98% first-call resolution, multilingual (Hindi/Tamil/Kannada)

## Brand voice
Short declarative fragments. Confident, not hypey. Em-dash + period-stacking for
rhythm ("No rework. No idle time."). Concrete nouns over adjectives. Playfair
italic accent line for emphasis. Never: revolutionary, seamless, leverage,
unlock, empower, game-changer, cutting-edge. No exclamation marks.
Name is "Finn" (not HireFinn). Domain hirefinn.ai.
