---
title: Software-Building & Self-Hosting (incl. Bootstrap Ladder)
type: concept
status: reviewed
sources: [065, xcombo-11, xcombo-code-knowledge-flywheel, _skeleton-reference, xcombo-01, research-sources]
updated: 2026-06-24
---

# Software-Building & Self-Hosting

The thesis that Paperclip can build software as a first-class capability — and, ultimately, **build
itself**. The ultimate dogfood: the product builds the product.

## Part A — software engineering as a capability (idea 065)

Weld existing pieces into a real engineering loop: git-backed workspaces, a build/test/lint loop, the
[[human-in-the-loop|PR-style change-review]] (017), CI-at-the-review-gate (eval 011 +
[[security-governance|security scan]] 050), and an eng-org blueprint (PM→Architect→Devs→QA→DevOps) driven
by the `devon` / `pm-tdd` / `qa-engineer` skills.

## Part B — self-hosting

Point a Paperclip company at its own repo with `.ideas/` *as the goal tree*. The distinctive, safer bet
(vs. Darwin-Gödel-style self-modifying scaffolds, which the literature warns are "costly and may not
generalize"): **self-improvement as a governed *org process*** — agents + budgets + approvals + eval
gates + audit — not weight/scaffold surgery. Guardrail: the self-builder must **not weaken its own
guardrails** (mandatory human ratification on safety/governance/runtime diffs, full audit, revert).

## Part C — the Bootstrap Ladder (xcombo-11)

Scale down to the [[paperclip-architecture-skeleton|5-table kernel]], then climb a **capability
curriculum**, one verified rung at a time. Each rung = **build → verify (eval + [[pre-flight]] + human
gate) → ratchet**, raising **capability** (the [[knowledge-and-memory|Code-Knowledge Flywheel]] enriches
the self-model so the next rung is cheaper) *and* **earned autonomy** ([[runtime-control-and-safety|the
Autonomy Dial]]) *together* — so autonomy never outruns proven verification (e.g. auto-merge unlocks only
after the QA+eval rungs exist). Grounded in Darwin/Huxley-Gödel + automatic-curriculum-learning +
earned-autonomy research, heeding the *statistical limits of self-improvement*.

## Why it's now plausible

Runtime self-evolution is proven (Live-SWE-agent: 77.4% SWE-bench Verified by evolving its own scaffold),
and the kernel→rings architecture makes "scale down then build up" a true subset, not a rewrite.

## Provenance

- Idea `065`; combos `xcombo-11`, `xcombo-code-knowledge-flywheel`; `_skeleton-reference.md`.
- `raw/research-sources.md` → `[swe-agents]`, `[self-improve]`.

## Open questions for human review

- The first rung after the kernel — which capability has the highest leverage?
- How to *prove* autonomy trails verification capability (the safety-critical coupling)?
- Acceptable scope of the self-builder touching its own control-plane code, and under what gates?
