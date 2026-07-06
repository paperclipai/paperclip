# Cross-Cut 04 — Trust as the Universal Currency

**A different cut:** the thematic combos enforce limits *per silo* — egress here, secrets there,
approvals elsewhere — each with its own notion of "is this agent safe enough?" This one extracts that
shared notion into **one continuous, behavior-updated trust score per agent identity** that *every*
gate reads, the way a credit score is consumed by many lenders. The novelty is making trust a single
first-class currency rather than a static flag duplicated across enforcement points.

**Synthesizes:** 009 Agent Probation & Trust Ramp · 022 Egress Allow-Listing ·
021 Just-in-Time Secret Leasing · 016 Approval Auto-Approve · 025 Capability-Based Assignment ·
024 Per-Run Resource Caps
*(pulls from thematic combos 07, 08, 05, 01)*

## Industry grounding (web research, June 2026)

The security industry has converged on exactly this model for agentic AI, which validates the cut:

- **Zero trust in 2026 is a *continuous* operating model, not one-time verification.** "Authentication
  for agents must be continuous, not one-time, as an agent's behavior can change during multi-step
  workflows; runtime context should inform ongoing authorization decisions, not just the initial
  handshake." → a trust score that **updates from behavior**, not a flag set at hire.
- **Agents are first-class non-human identities** needing "scoped access, logging, approvals,
  monitoring, and kill-switch controls." Yet "only 22% of practitioners treat agents as independent
  identities; the majority rely on shared API keys or inherited user sessions." → Paperclip should give
  each agent a real identity carrying its own trust (and fix shared-key blending, idea 049).
- **Least privilege = scope to the specific task/project, not the broadest role the owner could
  justify.** → trust gates *per run / per resource*, not blanket grants.
- **Continuous evaluation detects abnormal behavior / manipulated instructions** (prompt injection,
  unauthorized tool use). → the trust score is also the anomaly signal.

## The unified idea

Define a single **continuous agent trust score** (an evolution of `source-trust.ts` +
`trust-preset-resolver.ts`) attached to each agent *identity*, recomputed from behavior — clean run
record, review approval rate, diminishing-returns/reliability trips (combo 03), secret-lease anomalies,
blocked-egress attempts, policy violations. Then every enforcement point *reads the same score* instead
of its own private rule:

| Gate | How it consumes the trust currency |
|------|-----------------------------------|
| Probation/ramp (009) | *Produces* the score: graduation raises it, violations lower it (the update engine) |
| Egress allow-list (022) | Low trust → tight default-deny allowlist; high trust → broader |
| Secret leasing (021) | Low trust → shorter TTLs, narrower scope, more approvals per lease |
| Auto-approve (016) | Trust × action-risk decides what auto-approves vs needs a human |
| Assignment (025) | Trust weights who gets critical/sensitive work |
| Per-run caps (024) | Low trust → tighter wall-clock/cost/tool-call ceilings |

One score in, many least-privilege decisions out — and because it's *continuous*, a compromised or
drifting agent automatically loses egress, secret scope, auto-approval, and concurrency *simultaneously*
the moment its behavior degrades, with a kill-switch (Panic Stop, combo 01) at trust=0.

## Why this is a *better* idea than the parts

Today "trust" is re-implemented and re-decided in six places that can silently disagree (an agent
demoted for bad reviews still holds wide egress and long secret leases). Centralizing it makes the
whole posture *coherent and continuous*: every privilege contracts and expands together, automatically,
from one behavior-driven signal — which is precisely the "continuous authorization" model the 2026
zero-trust guidance prescribes. It also turns probation (009) from an isolated feature into the
*engine* that drives the entire security surface.

## Phasing

1. Promote trust to a first-class **continuous score on the agent identity** with a documented input
   model (extend `source-trust.ts`); display it. Read-only — nothing enforces on it yet.
2. Make the *softest* gates consume it first: per-run caps (024) and auto-approve thresholds (016).
3. Wire the security gates: secret-lease TTL/scope (021) and egress allowlist breadth (022).
4. Continuous behavioral updates (anomaly detection from combo 03/08 signals) + assignment weighting
   (025) + trust=0 kill-switch; tie demotion/promotion to the Autonomy Dial (xcombo-01).

## Ratings

- **Difficulty:** Medium–High — little new runtime, but it touches *every* enforcement path, so the risk
  is correctness and blast radius: the score model must be well-calibrated (a noisy score that yo-yos
  privileges is worse than static trust), updates must be auditable, and each gate's trust→policy
  mapping needs care. Ship read-only, then enforce gate-by-gate.
- **Estimated time to complete:** ~4–6 engineer-weeks (atop the gates from combos 07/08 existing).
- **Importance:** 8/10 — it's the unifying spine of the security story and directly implements the
  prevailing zero-trust-for-agents model; high leverage, but depends on the individual gates existing to
  govern.

## Sources

- [Zero Trust Architecture for Agentic AI in 2026 — Zentera](https://www.zentera.net/blog/zero-trust-architecture-for-agentic-ai)
- [Zero Trust for AI Agents: Least Privilege for Prompts & Plugins — Zscaler](https://www.zscaler.com/blogs/product-insights/zero-trust-for-ai-agents-least-privilege)
- [AI Agent Identity & Zero-Trust: The 2026 Playbook — Medium](https://medium.com/@raktims2210/ai-agent-identity-zero-trust-the-2026-playbook-for-securing-autonomous-systems-in-banks-e545d077fdff)
- [New tools and guidance: Announcing Zero Trust for AI — Microsoft Security](https://www.microsoft.com/en-us/security/blog/2026/03/19/new-tools-and-guidance-announcing-zero-trust-for-ai/)
- [Zero Trust for AI Agents — Identity, Access Control, Behavioral Protection — Cisco](https://blogs.cisco.com/security/security-agentic-ai-how-cisco-brings-zero-trust-to-your-new-digital-workforce)
