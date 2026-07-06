# Cross-Cut 02 — The Closed-Loop Self-Improving Company

**A different cut:** the thematic combos each *measure* or *gate* one thing. This one chains six
ideas from four different clusters into a single **flywheel** — a closed loop where the output of
each stage is the input to the next, so the company's agents get measurably better run over run
without a human re-prompting them. The novelty is the *loop closure*, not any single stage.

**Synthesizes:** 040 Operator-Owned Training Dataset · 011 Eval-Gated Config Deploys ·
032 A/B Model Bake-Off · 055 Estimate-vs-Actual Calibration · 056 Business Experiment Framework ·
060 Knowledge System (learnings ledger)
*(pulls from thematic combos 06, 04, 11)*

## The unified idea

Every other improvement idea is a fragment of one cycle. Wire them into a literal loop:

```
        ┌──────────────────────────────────────────────────────────────┐
        │                                                              │
   (1) CAPTURE            (2) MINE            (3) PROPOSE              │
   outcome-labeled   →   what correlates  →  a concrete change   ───┐ │
   run records (040)     with success         (prompt / model /     │ │
        ▲                (calibration 055,    skill / plan)         │ │
        │                 skill analytics)                          ▼ │
   (6) DEPLOY  ◄──── (5) DECIDE  ◄──── (4) TEST the change ─────────┘
   the winner,        ship / kill,      offline: eval gate (011)
   record a           append a          + A/B bake-off (032);
   "validated         validated          online: business
   learning" (060)    learning (060)     experiment (056)
```

- **Capture (040).** Normalize every run into an outcome-labeled record (approved/rejected/reworked/
  shipped, cost, tokens, 👍/👎) — the training-grade corpus, local and consented.
- **Mine (055 + skill analytics 046).** Surface what correlates with good outcomes: which prompts/
  configs/skills lift approval and cut rework; per-agent estimate bias from calibration.
- **Propose.** From the mined signal, generate a concrete candidate change — a prompt tweak, a model
  swap, adding a skill, a re-scoped plan. (Agent-proposed, operator/manager-ratified.)
- **Test (011 + 032 offline; 056 online).** Gate the change with the eval suite + a neutral-judge A/B
  bake-off in the shared `planOnly` shadow mode *before* it touches production; for changes whose
  value is only visible in the market (a price, a headline), run it as a business experiment with real
  revenue/outcome metrics.
- **Decide & record (056 + 060).** Ship the winner or kill it, and append the result as a **validated
  learning** to the knowledge base — so the *reason* persists and feeds future proposals and every
  agent's context.
- **Deploy → back to Capture.** The improved config runs, produces new labeled records, and the wheel
  turns again.

## Why this is a *better* idea than the parts

Each stage already "works" in isolation, but isolated they don't *compound*: a training dataset nobody
mines is an archive; an eval gate with no proposal pipeline only blocks regressions, never drives
gains; experiments whose learnings aren't written down get re-run. Closing the loop turns six
point-features into a **compounding asset** — the single most important property of an autonomous
business (idea 056's own framing: "a company that learns"). The flywheel is the thing; the stages are
spokes.

## Phasing

1. Capture + Mine (040 + calibration/skill correlations) — produce *insight* even before any
   auto-proposal: "configs with X correlate with +18% approval."
2. Add the offline Test gate (011 + 032 on the shadow contract) so proposed changes are validated cheaply.
3. Add Decide→Record into the knowledge learnings ledger (060) so reasons persist.
4. Add the online Test path (business experiments, 056) and a human-ratified auto-Propose step — the
   full closed loop.

## Ratings

- **Difficulty:** High — it's an orchestration layer over six features that must each exist and share
  contracts (the `planOnly` shadow mode, outcome labels, the knowledge ledger). The genuinely hard
  parts are trustworthy auto-*proposal* (a bad proposal pipeline degrades agents at machine speed —
  keep it human-ratified), statistical honesty across small samples, and avoiding feedback loops that
  optimize a proxy metric into the ground (needs guardrail metrics, per idea 056).
- **Estimated time to complete:** ~3–5 engineer-weeks *on top of* combos 06/04/11 existing.
- **Importance:** 7/10 — the highest *strategic* ceiling in the set (a company that compounds), but it
  sits atop the most prerequisites, so it's a later-stage capstone rather than an early win.
