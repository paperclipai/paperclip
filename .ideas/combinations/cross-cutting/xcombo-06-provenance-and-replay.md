# Cross-Cut 06 — Provenance & Replay (Reconstruct and Re-Run Any Decision)

**A different cut:** combo 03 (Health Sentinel) uses tracing for *observability* — "is the company
healthy, what's happening now?" This one is the **auditability** sibling: "prove *why* a specific past
decision was made, and re-run it." The industry draws exactly this line, and the four ideas below are
fragments of one capability — a complete, tamper-evident, *replayable* record of every consequential
agent decision.

**Synthesizes:** 023 Tamper-Evident Audit Log · 031 Agent-Run Tracing · 015 Point-in-Time Rewind ·
017 Run Change-Review Surface *(refs: 011 pinned config, 040 captured records, 043 policy, 034 retention)*
*(pulls from thematic combos 08, 03, 09, 05)*

## Industry grounding (web research, June 2026)

This cut maps directly onto a discipline the field has named and regulators now require:

- **Observability → auditability is an explicit shift.** "Observability tells you whether agents are
  healthy and what they're doing now, using *sampled* traces tuned for live debugging. Auditability
  proves *why a specific past decision was made*, demanding complete, tamper-evident, long-retention
  records." → combo 03's tracing is observability; this is the auditability layer it can't be on its own.
- **Decision provenance is the named primitive:** "the capability to reconstruct the series of inputs,
  reasoning, and outputs behind every agentic decision."
- **Regulators reconstruct a *single* decision:** "the exact inputs the agent held, the model version
  and prompt that ran, and the policy that produced the action." The **EU AI Act high-risk deadline is
  Aug 2, 2026**; Article 12 requires high-risk systems to "technically allow for automatic recording of
  events over the system's lifetime." → a compliance forcing function, not a nicety.
- **Deterministic replay is emerging tech:** R-LAM provides "structured action schemas, deterministic
  execution policies, and provenance tracking to ensure auditable and replayable workflows"; products
  capture "each agent run as an auditable, replayable Session." → replay is real and worth designing for.
- **Audit trails must be auto-generated + cryptographically verified**, not custom-built per feature.

## The unified idea

### Part 1 — The Decision Provenance Record (reconstruct)
For every *consequential* action (a spend, an approval, a workspace change, a cross-company message, a
config edit), assemble one immutable record that bundles the fragments the four ideas each hold today:

| Fragment | From |
|----------|------|
| Exact inputs & context the agent held | 031 spans + 040 captured run records |
| Model version + the prompt that ran | 011 config snapshot / pinned versions |
| The policy that produced the action | 043 policy-decision log ("which rule fired") |
| The reasoning / tool-call trace | 031 semantic spans |
| The concrete outputs / diff | 017 change-review changeset |
| Cost & tokens | cost_events (cross-cut 03 attribution key) |

Chain it into the **tamper-evident log (023)** so the record is cryptographically verifiable and
long-retention (governed by 034) — the "complete, tamper-evident" standard, auto-generated, not
bolted on per feature. *This is the Article-12 deliverable.*

### Part 2 — Replay (re-run)
Provenance lets you *read* a decision; replay lets you *re-execute* it:
- **Restore the pre-decision state** with point-in-time rewind (015) into a throwaway fork (never
  in-place), so the decision's exact world is reconstructed.
- **Re-run deterministically** using the provenance record's pinned model + prompt + policy and a
  structured action schema (R-LAM-style), in the side-effect-free `planOnly` shadow mode (shared with
  combos 04/06/07/10) so replay touches nothing real.
- **Two payoffs:** *reproduce* (did the agent really decide this for these reasons? — audit/dispute) and
  *counterfactual* (re-run with a **different policy or model** — "would the new governance rule have
  blocked this?", which is also the dry-run-a-policy feature of idea 043, now backed by real history).

## Why this is a *better* idea than the parts

Individually: 031 is sampled and short-lived (observability); 023 records *that* something happened but
not the full reasoning/inputs; 017 shows the diff but not why; 015 restores state but doesn't tie it to a
decision. **Only combined** do you get the regulator-grade ability to reconstruct *and* re-run a single
past decision with its exact inputs, model, prompt, and policy — the auditability the others can't reach
alone. Replay specifically is emergent: it needs state (015) + the full provenance record (023/031/011/
043) + deterministic execution together; no single idea provides it.

## Phasing

1. **Decision Provenance Record**: define the consequential-action set; assemble + hash-chain the bundle
   into the tamper-evident log (023) with long retention (034). Compliance value lands here (Article 12).
2. **Read/inspect UI**: a "reconstruct this decision" view (inputs, model, prompt, policy, trace, diff,
   cost) — the change-review surface (017) extended with full context.
3. **Reproduce replay**: fork-restore (015) + re-run with pinned versions in `planOnly`; compare to the
   recorded outcome.
4. **Counterfactual replay**: swap policy/model and re-run — turns history into a governance/regression
   test bed (powers idea 043 dry-run + combo 06 eval gating with real cases).

## Ratings

- **Difficulty:** High — Part 1 is disciplined record assembly + hashing (tractable, and combo 08's log
  exists). Part 2 is the hard part: faithful state restore, *deterministic* re-execution across adapters
  (LLM nondeterminism, external side effects that can't be replayed — frame honestly: replay reproduces
  the control-plane decision, not the outside world), and a structured action schema. Retention/PII
  (034) and "keep proof when payload purged" need care.
- **Estimated time to complete:** ~6–9 engineer-weeks (Part 1 ~3 wk and independently shippable for compliance).
- **Importance:** 8/10 — provenance is a hard regulatory requirement (EU AI Act, Aug 2 2026) for anyone
  running high-risk autonomous work, and replay is uniquely powerful for disputes, debugging, and
  testing governance against real history. Part 1 alone may be table-stakes for serious operators.

## Sources

- [Agentic AI Observability: A 2026 Playbook — Arthur](https://www.arthur.ai/column/agentic-ai-observability-playbook-2026)
- [AI Agent Audit Trails: Proving What Agents Decided — iSimplifyMe](https://isimplifyme.com/blog/agent-audit-trails)
- [AI Agent Accountability: Reasoning Traces vs Real Audit Trails — Apptitude](https://apptitude.io/blog/ai-agent-accountability-reasoning-traces-audit-trail/)
- [AI Audit Trail: Compliance, Accountability & Evidence — Swept AI](https://www.swept.ai/ai-audit-trail)
- [AI Agent Observability: A Complete Guide for 2026 — Atlan](https://atlan.com/know/ai-agent-observability/)
