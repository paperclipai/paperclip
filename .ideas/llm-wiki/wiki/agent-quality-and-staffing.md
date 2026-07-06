---
title: Agent Quality, Staffing & Self-Organization
type: concept
status: reviewed
sources: [009, 011, 025, 032, 040, 044, 046, 047, 048, 052, 057, combo-06, combo-07, xcombo-02, xcombo-07, research-sources]
updated: 2026-06-24
---

# Agent Quality, Staffing & Self-Organization

How agents are evaluated, equipped, assigned, ramped, and — eventually — how the org staffs and repairs
itself.

## Agent CI/CD & evidence-based quality (combo-06)

On three shared foundations — a side-effect-free `planOnly`/shadow mode, the eval harness, and
outcome-labeled run history:
- **Eval-gated config deploys (011)** — run a saved suite before a config change goes live ("CI for agents").
- **A/B model bake-off (032)** — same tasks across models; cost/quality frontier with a neutral judge.
- **Operator-owned training dataset (040)** — normalize runs into outcome-labeled records (local, consented).
- **Skill effectiveness analytics (046)** — does a skill actually lift approval / cut rework?

## Self-staffing & self-organizing (combo-07)

- **Competency-gated job postings (048)** — a posting stays open until a candidate *passes a test* (the
  eval *is* the interview).
- **Role-based skill auto-provisioning (047)** — role→skill bundle; equip on hire; reconcile on change.
- **Capability-based assignment (025)** — fit × load × trust × cost; UCB skill-routing (arXiv 2506.20543).
- **Probation & trust ramp (009)** — earn autonomy on a clean record; feeds the [[security-governance|trust currency]].
- **Org restructuring simulator (052)** — preview a reorg's impact before applying (see [[pre-flight]]).

## The Self-Healing Org (xcombo-07)

Apply the SRE self-healing loop (**detect → diagnose → remediate → verify**) to *staffing & structure*:
reliability SLOs (044) detect → diagnose agent/role/structure fault → remediate via constrain/reassign
(009/025), auto-backfill posting (048), reorg (052), or incident (057) → verify recovery. Human =
"reliability architect." Grounded in 2026 agentic-SRE (≈80% MTTR cuts).

## The self-improving flywheel (xcombo-02)

Capture (040) → mine (055/046) → propose → test (011/032 + business experiments) → record learning (060)
→ deploy → repeat. The novelty is loop closure: point-features become a *compounding* asset.

## Links

Consumes [[observability-and-health]] (reliability signal) and [[economics-and-finance]] (cost-effectiveness);
shares the shadow contract with [[pre-flight]] and [[software-building-and-self-hosting]].

## Provenance

- Ideas `009,011,025,032,040,044,046,047,048,052,057`; combos `combo-06`, `combo-07`, `xcombo-02`, `xcombo-07`.
- `raw/research-sources.md` → `[routing]`, `[self-healing]`.

## Open questions for human review

- Graduation/demotion criteria for the trust ramp — strict enough to matter, loose enough not to shackle good agents?
- Auto-reorg / auto-hire are high blast-radius — keep behind the human-set autonomy ceiling?
- Trustworthy auto-*proposal* in the flywheel without degrading agents at machine speed.
