---
title: External Integration & The Front Desk
type: concept
status: reviewed
sources: [036, 062, 066, 016, 025, 058, combo-12, xcombo-09, research-sources]
updated: 2026-06-24
---

# External Integration & The Front Desk

A real company both *receives* work from outside and *emits* to its toolchain. Paperclip has a rich
internal event bus but no first-class front door or outbound tap.

## Two-way integration fabric (combo-12)

- **Inbound intake (062)** — email / webhook / form → an issue, secured (rate-limit, spam-filter,
  source-trust gate, leak/PII scan).
- **Outbound webhooks (036)** — signed, retrying event delivery (Slack on ship, PagerDuty on hard-stop),
  SSRF-guarded.
- Payment webhooks (see [[economics-and-finance|Revenue]]) are a special inbound channel; the
  intra-instance analog is the [[multi-company-and-ecosystem|Company Mailbox]].

## The Front Desk — autonomous intake→resolution (xcombo-09)

The pipeline: **intake (062) → triage/score (016) → retrieve context ([[knowledge-and-memory]]) →
capability/UCB-skill assign + template/DoD (025/058) → respond (036)**. Three modes — *resolve* /
*triage* / *assist* — on a confidence dial ([[runtime-control-and-safety|Autonomy Dial]]). Grounded in
arXiv ticket-routing (incl. UCB skill-queues, arXiv 2506.20543) + 2026 support metrics (72s→4s response,
≈$1/resolution, 50–70% deflection). The differentiator: the "resolver" isn't a chatbot — it's a
**governed multi-agent org** (the link to [[human-in-the-loop|the chat channel]] and
[[aisha-integration|Aisha]]).

## Provenance

- Ideas `036,062,066`; combos `combo-12`, `xcombo-09`.
- `raw/research-sources.md` → `[routing]`, `[chatops]`.

## Open questions for human review

- A public front door is an attack surface — start route-only, raise auto-resolve as accuracy proves out?
- Email ingestion (parser/threading) is fiddly — webhook/form first?
