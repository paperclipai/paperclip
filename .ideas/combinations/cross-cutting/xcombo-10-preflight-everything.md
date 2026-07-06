# Cross-Cut 10 — Pre-Flight Everything (One "Simulate Before Commit" Seam)

**A different cut:** several ideas *each* invent their own preview/dry-run — the company estimator (004),
the reorg impact preview (052), the policy dry-run (043), the import preview (064), the restore diff (015).
This generalizes them into **one universal pre-flight seam**: every high-consequence change passes through
the *same* `simulate(change) → impact report` contract before it commits. Build the simulator once; every
risky action gets a preview for free.

**Synthesizes:** 004 Dry-Run Estimator (the seed contract) · 052 Org Restructuring Simulator ·
043 Policy-as-Code Dry-Run · 064 Import Preview · 015 Restore Diff *(refs: 011 eval-gate, xcombo-06
counterfactual replay, xcombo-08 capital moves, combo 13 cross-company, cross-cut 01 dial)*
*(pulls from thematic combos 10, 07, 08, 09)*

## Academic + industry grounding (web research incl. arXiv + Scholar, June 2026)

Two mature bodies of work converge exactly on this seam:

- **Digital twins for pre-deployment validation + counterfactuals.** "High-fidelity simulation platforms
  designed to proactively identify hidden faults… and validate safety *before* deployment"; they "enable
  counterfactual reasoning, sensitivity analysis… a safe means to analyze responses to hypothetical
  scenarios," explicitly "testing control policies before applying them to the live network" (ADDT, arXiv
  2504.09461; Digital-Twin Counterfactual Framework, arXiv 2604.01325; TwinLoop simulation-in-the-loop for
  multi-agent systems, arXiv 2604.06610). → the *simulate + impact* half of the seam.
- **Change Impact Analysis (CIA).** "Analyzing a system update's impact before accepting it, based on
  traceability of dependencies"; with regression-test-selection to rerun only affected tests. → how the
  impact report is computed from the dependency graph Paperclip already has (org chart, issue tree, policy
  references).
- **The shadow → dry-run → commit maturity ladder for AI agents (2026).** Shadow mode: "agent receives
  every real input, records output, is prevented from acting; an auto-evaluator compares to the human's
  actual work." Dry-run: "the action is simulated without touching production—the interceptor shows what
  *would* happen, logs it, and waits for human review." A structured rollout: Phase 1 shadow → Phase 2
  dry-run (2–4 wks, approve/block) → cut over — "validate before committing." → the *graduation* model:
  each capability earns auto-commit by proving itself in shadow/dry-run first.
- **Critical guardrail:** "kill switches don't work if the agent writes the policy" (Stanford Law / Berkeley
  AILCCP). → the pre-flight seam and the definition of "consequential" must be **human-owned and
  agent-immutable**, or self-modifying agents (idea 065) could route around it.

## The unified idea — one contract, many call sites

Generalize idea 004's `planOnly`/dry-run into a first-class **pre-flight contract** every consequential
mutation implements:

```
simulate(change, currentState) → ImpactReport {
   creates / updates / deletes,      // what changes (CIA over the dependency graph)
   risks / warnings,                 // what could break (orphaned issues, unstaffed role, frozen company)
   projected cost / spend,           // economic impact (combo 04)
   counterfactual,                   // "would have blocked 4 actions last week" / "orphans 3 issues"
   confidence
}
```

Call sites, each replacing a bespoke preview with the shared seam:

| Consequential action | Pre-flight answers |
|----------------------|--------------------|
| Launch a company (004) | projected cost band, misconfig, concurrency profile |
| Reorg (052) | reassignments, rerouted approvals, orphaned work, span-of-control |
| Activate a policy (043) | "this rule would have fired on N past actions" (uses xcombo-06 replay) |
| Import data (064) | counts, hierarchy, unmapped fields, before commit |
| Restore/rewind (015) | diff of what restoring changes |
| Deploy agent config (011) | eval-suite pass/fail in shadow |
| Move capital (xcombo-08) | projected ROI shift, fairness-floor breach |
| Cross-company action (combo 13) | what crosses the boundary, leak scan |

And the **graduation ladder** (mapped to the Autonomy Dial, cross-cut 01): a new consequential capability
starts **preview-only** → earns **dry-run-with-approval** → earns **auto-commit**, as its simulations prove
they match reality. Pre-flight is the on-ramp to autonomy, not just a gate.

## Why this is a *better* idea than the parts

Five+ features are each independently building "show me what would happen before I do it" — duplicated,
inconsistent, and incomplete (some actions have a preview, most don't). One shared `simulate()` seam +
ImpactReport schema gives *every* consequential action a uniform, trustworthy preview, a single place to
add new call sites, and a natural home for the counterfactual engine that xcombo-06 (replay) and idea 043
(policy dry-run) both need. It turns "validate before committing" from a per-feature nicety into a
system-wide invariant — exactly the discipline the digital-twin and shadow-mode literature prescribes.

## Phasing

1. Define the `simulate() → ImpactReport` contract + a CIA impact walk over the existing dependency graphs;
   wire the two cheapest call sites (reorg 052, import 064 — both already have bespoke previews to fold in).
2. Add policy dry-run (043) backed by counterfactual replay over history (shared with xcombo-06).
3. Add the economic call sites (launch 004, capital moves xcombo-08) and config-deploy shadow (011).
4. The graduation ladder (preview → dry-run → auto-commit) tied to the Autonomy Dial; lock the seam as
   human-owned/agent-immutable (the kill-switch guardrail).

## Ratings

- **Difficulty:** Medium–High — the contract and CIA walk are tractable over data Paperclip already has;
  the hard parts are *faithful* simulation (a preview that's wrong is worse than none — same honesty problem
  as digital twins), counterfactual replay fidelity (shared with xcombo-06), and making the seam truly
  agent-immutable. Each call site is incremental once the contract exists.
- **Estimated time to complete:** ~5–7 engineer-weeks for the contract + first call sites; the rest fold in incrementally.
- **Importance:** 8/10 — "validate before committing" is the single most reusable safety pattern across the
  whole backlog, it eliminates duplicated preview code, and it's the on-ramp that lets risky capabilities
  (auto-reorg, auto-hire, auto-capital, self-modification) graduate to autonomy *safely* rather than never.

## Sources

- [ADDT — Digital Twin for Proactive Safety Validation in Autonomous Driving — arXiv 2504.09461](https://arxiv.org/abs/2504.09461)
- [The Digital Twin Counterfactual Framework — arXiv 2604.01325](https://arxiv.org/html/2604.01325)
- [TwinLoop: Simulation-in-the-Loop Digital Twins for Multi-Agent RL — arXiv 2604.06610](https://arxiv.org/html/2604.06610v1)
- [Shadow Mode Rollouts for AI Agents: A Safer Path from Pilot to Production — Brightlume](https://brightlume.ai/blog/shadow-mode-rollouts-ai-agents-pilot-production)
- [Controlling AI Actions: Pre-Execution Control Layer — Data443](https://data443.com/blog/controlling-ai-actions-pre-execution-control-layer/)
- [Kill Switches Don't Work If the Agent Writes the Policy — Stanford Law / Berkeley AILCCP](https://law.stanford.edu/2026/03/07/kill-switches-dont-work-if-the-agent-writes-the-policy-the-berkeley-agentic-ai-profile-through-the-ailccp-lens/)
