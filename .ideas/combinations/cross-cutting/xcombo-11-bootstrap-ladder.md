# Cross-Cut 11 — The Bootstrap Ladder (Kernel → Org)

**A different cut:** the thematic combos describe *finished* capabilities. This one is a **growth process**:
the concrete, governed path by which a deliberately tiny self-builder grows itself into a full org, one
verified rung at a time — turning idea 065's "scale down then build up" from a hand-wave into a principled,
curriculum-driven, earned-autonomy ladder grounded in the self-improving-agents literature.

**Synthesizes:** 065 Part C (kernel + capability ratchet) · `_skeleton-reference.md` (the 5-table starting
point) · cross-cut 01 Autonomy Dial (earned autonomy) · the Code-Knowledge Flywheel (self-model)
*(refs: 011 eval gate, 044 reliability, xcombo-10 Pre-Flight, 009 trust)*
*(pulls from idea 065, combo 11, cross-cuts 01/10)*

## Academic + industry grounding (web research incl. arXiv + Scholar, June 2026)

Three research lines converge precisely on this, and they also fence its dangers:

- **Self-improving agents work — by building better tools for themselves.** The **Darwin Gödel Machine**
  "iteratively modifies its own code (thereby improving its ability to modify its own codebase) and
  empirically validates each change using coding benchmarks," growing an *archive* of agents — lifting
  SWE-bench 20%→50% by adding "better code-editing tools, long-context management, peer-review mechanisms"
  (arXiv 2505.22954; Huxley-Gödel 2510.21614). → validates the **ratchet**: capability begets capability,
  *if each step is empirically verified*.
- **Automatic Curriculum Learning gives the rung *ordering*.** ACL "adaptively changes the distribution of
  tasks to match the agent's evolving capabilities… adjust difficulty to the ability level of the current
  agents" (arXiv 1708.02190; OMNI self-generated curricula). → the ladder isn't an arbitrary feature list;
  it's a **curriculum** — build next whatever matches current capability and most unlocks the rung after.
- **Earned autonomy is the safety model.** "As the system demonstrates reliable, consistently improving
  performance, human oversight can be calibrated accordingly — becoming more autonomous where it's *earned*
  that autonomy" (2026 learning-loop framing). → exactly the Autonomy Dial (cross-cut 01): each rung raises
  capability *and* earns a notch of autonomy, together.
- **The guardrails, from the literature itself.** Self-improvement has **statistical limits** (arXiv
  2510.04399), and current agents "fail on longer tasks, lose track of progress" (Intl. AI Safety Report
  2026, arXiv 2602.21012). → keep rungs *small and verified*, human-gated, Pre-Flight-simulated — don't
  attempt DGM-style unsupervised weight/scaffold surgery on a live company.

## The unified idea — a governed curriculum that climbs from the skeleton

Make idea 065's bootstrap an explicit, managed **capability curriculum**:

1. **Start at the skeleton** (`_skeleton-reference.md`): 5 tables + one tick loop + one adapter + a budget
   hard-stop + a human approval gate. The smallest thing that can land a verified change.
2. **Maintain a curriculum of rungs**, each ordered by *capability-leverage* (build what most cheapens the
   next rung) and *matched to current capability* (ACL): structured test capture → change-review (017) →
   QA + TDD → eval gating (011) → capability assignment (025) → security/caps/reliability (050/024/044) →
   org blueprint (018). Each rung is a slice of *this very backlog*.
3. **Each rung is a governed build-verify-ratchet step:**
   - *Build* the rung (the kernel/org implements it as normal work).
   - *Verify* it — eval suite (011) + tests + **Pre-Flight simulation** (xcombo-10) + human ratification.
     This is the DGM "empirically validate each change" discipline, but with a human gate.
   - *Ratchet two things on success:* (a) **capability** — the new rung is turned on for the builder and
     indexed into its self-model via the **Code-Knowledge Flywheel** (so the next rung is cheaper); (b)
     **autonomy** — the Autonomy Dial (cross-cut 01) loosens a notch *because the verifying capability now
     exists* (e.g., auto-merge unlocks only after the QA+eval rungs are built and proven).
4. **Capability and autonomy rise together, never apart.** The system is never granted more autonomy than
   the verification machinery it has *already built and proven* — the structural guarantee against runaway
   self-modification. A failed/regressed rung halts the climb and reverts (015), without losing prior rungs.
5. **Operator owns the curriculum and the ceiling.** The human can reorder rungs, set the autonomy ceiling,
   and must ratify each rung; the system proposes and builds within that frame (the "feedback DB with human
   gate" pattern).

## Why this is a *better* idea than the parts

Idea 065 says *that* the system can build itself; the Autonomy Dial says *how much rope*; the Flywheel says
*how it remembers*; eval/Pre-Flight say *how to check*. Alone, none answers **"in what order, and how does
each step safely unlock the next?"** The Bootstrap Ladder is that missing growth process — a curriculum
where verified capability and earned autonomy ratchet together. It makes self-construction *governed and
gradual* (heeding the statistical-limits/long-task caveats) instead of the brittle, unsupervised
self-modification the DGM line warns is costly and non-generalizing — Paperclip's distinct, safer bet.

## Phasing

1. Stand up the kernel from the skeleton (065 Part C) at Autonomy Level 0–1; everything human-gated.
2. Define the curriculum data model (ordered rungs, capability prerequisites, the autonomy notch each
   unlocks) + the build-verify-ratchet loop using existing eval (011) + Pre-Flight (xcombo-10).
3. Wire the Flywheel self-model enrichment per completed rung; tie autonomy notches to verification rungs.
4. Let the system *propose* the next rung (curriculum self-generation, OMNI-style) under human ratification;
   add regression-halt + revert (015) on a failed rung.

## Ratings

- **Difficulty:** High — this is the orchestration of self-construction; it depends on the kernel (065),
  eval/CI (011/combo 06), Pre-Flight (xcombo-10), the Flywheel, and the Autonomy Dial all existing. The
  hard, safety-critical core is the **autonomy↔capability coupling** (autonomy must *provably* trail
  verification capability) and honest verification at each rung (a rung that "passes" but regressed quietly
  poisons the climb). Heed the statistical limits — this is gradual governed growth, not recursive
  self-improvement.
- **Estimated time to complete:** the *framework* ~4–6 engineer-weeks atop its dependencies; the *climb
  itself* is ongoing (the system spends weeks building its own rungs).
- **Importance:** 8/10 — it's the through-line that makes the entire self-building thesis (065) real and
  safe, and the same earned-autonomy curriculum governs how *any* Paperclip company safely scales its own
  autonomy, not just the self-hosting case. High strategic ceiling; depends on much of the stack first.

## Sources

- [Darwin Gödel Machine: Open-Ended Evolution of Self-Improving Agents — arXiv 2505.22954](https://arxiv.org/abs/2505.22954)
- [Huxley-Gödel Machine: Human-Level Coding Agent Development — arXiv 2510.21614](https://arxiv.org/html/2510.21614v1)
- [Intrinsically Motivated Goal Exploration with Automatic Curriculum Learning — arXiv 1708.02190](https://arxiv.org/pdf/1708.02190)
- [On the Statistical Limits of Self-Improving Agents — arXiv 2510.04399](https://arxiv.org/pdf/2510.04399)
- [International AI Safety Report 2026 — arXiv 2602.21012](https://arxiv.org/pdf/2602.21012)
- [When AI Builds Itself — Anthropic](https://www.anthropic.com/institute/recursive-self-improvement)
