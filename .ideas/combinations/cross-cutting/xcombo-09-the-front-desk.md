# Cross-Cut 09 — The Front Desk (Autonomous Intake → Resolution)

**A different cut:** the thematic combos build internal machinery (intake, assignment, templates, outbound)
as separate features. This one threads them into a single **external-facing pipeline** — the company's
*front desk* — that takes a request from the outside world all the way to a resolution and a reply,
autonomously. The novelty: Paperclip already has every stage; wired end-to-end they form a
request-to-resolution loop backed by a *governed multi-agent org*, not a bolted-on chatbot.

**Synthesizes:** 062 Inbound Intake Channels · 016 Approval/Risk Triage · 025 Capability-Based Assignment
· 058 Work Templates & DoD · 036 Outbound Webhooks *(refs: combo 11 knowledge retrieval, 038/057 SLA
escalation, xcombo-08 bandit routing)* *(pulls from thematic combos 12, 07, 10, 05)*

## Academic + industry grounding (web research incl. arXiv + Scholar, June 2026)

This is a mature, measured discipline — which gives both a reference pipeline and target numbers:

- **The canonical pipeline is well-defined:** "AI ticket triage classifies intent using NLP, scores
  sentiment and urgency, retrieves relevant context (past tickets, KB, account data), and either routes
  the enriched ticket to the right queue or resolves it autonomously for high-confidence cases." → adopt
  classify → score → retrieve-context → route-or-resolve verbatim.
- **The numbers are real:** autonomous support "handles up to 80% of tickets"; triage cuts first response
  60–80% (one case "72 seconds → 4 seconds"); cost/resolution "$3–7 → ~$1"; top tools "deflect 50–70% of
  tier-1 tickets entirely." → the bar to aim at.
- **Assignment is a studied problem with a bandit connection:** skill-based routing achieves "human-level
  accuracy in automated assignment of helpdesk tickets" (arXiv 1808.02636); deep-learning real-time
  assignment (TaDaa, arXiv 2207.11187); seq2seq expert recommendation (SSR-TA, arXiv 2301.12612); and
  notably **UCB-based routing in skill-based queues** on real data (arXiv 2506.20543) — directly linking
  the Front Desk's assignment step to the bandit allocator of cross-cut 08.
- **Software-engineering triage is itself surveyed** (arXiv 2511.08607) and service systems can be designed
  "from textual evidence" (arXiv 2603.10400) — i.e. the intake corpus *teaches* the routing.
- **Reference product split** (Forethought): Solve (auto-resolve) / Triage (classify+route) / Assist
  (suggest to humans) — a clean three-mode model to mirror.

## The unified idea — one pipeline, five stages, each an existing idea

```
 outside world ──▶ (1) INTAKE ──▶ (2) TRIAGE ──▶ (3) RETRIEVE ──▶ (4) ASSIGN/RESOLVE ──▶ (5) RESPOND
                     062            016            combo 11           025 + 058              036
```

1. **Intake (062).** Email / webhook / form → a structured issue in the company's queue, rate-limited,
   spam-filtered, source-trust-gated, leak/PII-scanned (combo 08) — the secured front door.
2. **Triage (016).** Classify intent + score urgency/risk (the existing approval-risk score, reused).
   High-risk → human; routine → autonomous lane. This is the "classify + score" stage.
3. **Retrieve context (combo 11 / code-knowledge flywheel).** Pull prior tickets, KB/canonical docs, and
   account/issue history via semantic retrieval — the "don't re-solve solved problems" step that lifts
   resolution quality.
4. **Assign or auto-resolve (025 + 058).** Capability-/skill-based assignment (UCB-routed per arXiv
   2506.20543, shared with cross-cut 08) to the right domain agent; the work runs against a template + DoD
   (058) so "resolved" is well-defined. High-confidence cases the assigned agent **auto-resolves**; the
   rest it works and submits for review.
5. **Respond (036).** Reply through outbound webhooks / the originating channel, threaded to the request
   (`issue-references.ts`), closing the loop into genuine two-way comms. SLA escalation (038/057) catches
   anything stalling.

**Three modes, mirroring the field:** *Resolve* (auto-close high-confidence), *Triage* (classify+route),
*Assist* (draft a reply for a human) — the operator sets the confidence threshold per mode (Autonomy Dial,
cross-cut 01).

## Why this is a *better* idea than the parts

Each stage alone is inert: intake with no triage is a dumping ground; assignment with no intake has nothing
to route; outbound with no pipeline is just a webhook. Wired together they're a *product* — an autonomous
support/sales/ops desk — and Paperclip's differentiation is decisive: the "resolver" isn't a single bot
but a **governed multi-agent org** with budgets, approvals, audit, knowledge, and escalation already built.
That's the gap between a chatbot and a company that actually does the work behind the reply.

## Phasing

1. Intake → issue (062, secured) + reuse the triage risk score (016) to classify/route — *route only*,
   humans resolve. (Instantly useful; proves the front door.)
2. Add retrieval (combo 11) + capability assignment (025) so the right agent gets an enriched ticket.
3. Templates/DoD (058) + auto-resolve for high-confidence cases; outbound reply + threading (036).
4. UCB skill-routing (arXiv 2506.20543, shared with xcombo-08), SLA escalation (038/057), the three-mode
   confidence dial.

## Ratings

- **Difficulty:** Medium — every stage exists or is planned; the work is the *secured public front door*
  (062's hardest part), reliable two-way threading, and the auto-resolve confidence gate (resolving the
  wrong thing autonomously is the key risk — start route-only, raise autonomy as accuracy proves out).
- **Estimated time to complete:** ~4–6 engineer-weeks atop intake (062) + assignment (025) + outbound (036).
- **Importance:** 7/10 — for support/sales/ops-style autonomous companies this *is* the product (no front
  door = no autonomy), and the proven economics (≈$1/resolution, 50–70% deflection) are compelling; less
  central for companies whose work isn't externally-triggered.

## Sources

- [Cognitive system for human-level helpdesk ticket assignment — arXiv 1808.02636](https://arxiv.org/pdf/1808.02636)
- [UCB-based routing in skill-based queues on real-world data — arXiv 2506.20543](https://arxiv.org/pdf/2506.20543)
- [TaDaa: real-time Ticket Assignment Deep-learning Auto Advisor — arXiv 2207.11187](https://arxiv.org/pdf/2207.11187)
- [SSR-TA: seq2seq expert recommendation for ticket automation — arXiv 2301.12612](https://arxiv.org/pdf/2301.12612)
- [Triage in Software Engineering: A Systematic Review — arXiv 2511.08607](https://arxiv.org/html/2511.08607v1)
- [LLMs for Automated Ticket Escalation — arXiv 2504.08475](https://arxiv.org/html/2504.08475v1)
- [Does AI Ticket Triage Really Cut Response Time 80%? — Twig](https://www.twig.so/blog/triaging-customer-support-tickets-with-ai)
