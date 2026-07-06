# 065 — Software-Building Capability & Self-Hosting (Paperclip Builds Paperclip)

## Suggestion

Paperclip's canonical pitch is an autonomous company that ships a real product ("note-taking app to
$1M MRR"), yet **software engineering is not a first-class capability** — agents produce free-form work
products and there's no built-in engineering loop (repo, branch, tests, CI, PR review, release) that
turns a goal tree into shipped, verified code. The pieces are scattered: execution workspaces
(`execution-workspaces.ts`, `workspace-operations.ts`), work products (`work-products.ts`), an eval
harness (`evals/promptfoo/`), and engineering *skills* that already exist as conventions
(`devon` the software-engineer skill, `pm-tdd` red→green→refactor→review gates, `qa-engineer`). What's
missing is welding them into a real **software-building capability**.

Then take it to its natural conclusion: **let Paperclip build itself.** A Paperclip company whose
codebase *is* Paperclip, consuming its own `.ideas/` backlog as the goal tree — pick an idea, implement
it test-first, gate it on the eval harness + tests + security scan, open a reviewable diff, ship on
human ratification. The product improves the product, and every shipped improvement makes the builder
more capable: a governed dogfood flywheel.

## Why this is the right bet now (grounded research, June 2026)

- **Runtime self-evolution works.** *Live-SWE-agent* autonomously evolves its own scaffold while solving
  real problems and hits **77.4% on SWE-bench Verified**, beating the best proprietary agents — evidence
  that agents improving the software they run on is no longer speculative.
- **But naive self-improvement is brittle.** Self-modifying approaches like the *Darwin-Gödel Machine*
  "typically require costly offline training on specific benchmarks and may not generalize." → The safe,
  durable angle is **self-improvement as a governed *org process*** (an org of agents + budgets +
  approvals + eval gates + audit), not a single self-rewriting scaffold or weight-level training. Process
  generalizes and is auditable; weight surgery does not and is not.
- **Long-horizon software evolution is now a measured discipline** (SWE-EVO, async-agent strategies),
  which is exactly Paperclip's shape: many async, heartbeat-driven agents evolving a codebase over time
  — not a single synchronous coding session.

## How it could be achieved

### Part A — Software-building as a first-class capability
1. **A versioned engineering workspace.** Promote execution workspaces into git-backed project
   workspaces (branch per issue, commit on work-product accept), reusing `workspace-operations.ts` as the
   operation log and the run change-review surface (idea 017) as the PR-style diff.
2. **A real build/test loop.** Standard agent tools for `run tests`, `lint`, `build`; capture results as
   structured run signals (feeds per-run caps 024, reliability SLOs 044). The `pm-tdd` gates
   (red→green→refactor→review) become the issue lifecycle for engineering work.
3. **CI-for-the-work, not just the agent.** At the review gate, run tests + the eval/governance suite
   (idea 011) + dependency/SAST security scan (idea 050); critical failures block, others flag — code is
   "done" only when gates pass + a human/QA agent approves.
4. **An engineering org blueprint** (idea 018): PM → Architect → Devs → QA → DevOps, with the right
   skills auto-provisioned per role (idea 047) and capability-based assignment (idea 025) routing tasks.

### Part B — Self-hosting ("Paperclip builds Paperclip")
5. **The backlog *is* the goal tree.** Point a Paperclip company at the Paperclip repo with `.ideas/`
   (and `combinations/`) as its decomposed goals — this very folder becomes the work queue.
6. **TDD by construction, governed.** Each idea flows devon→qa-engineer through `pm-tdd`; the existing
   eval harness (`evals/promptfoo/`) plus the repo's own tests are the acceptance bar. No self-modifying
   magic — just the normal governed pipeline, pointed at itself.
7. **Self-improvement guardrails (the critical part).** Changes to Paperclip's *own* control-plane,
   governance, or safety surfaces require human ratification and an eval-gated deploy (idea 011) — a
   compromised or confused self-builder must not be able to weaken the very guardrails that contain it.
   Every self-modification is audited in the tamper-evident log (idea 023) and is revertible (point-in-
   time/DR, ideas 015/051). Trust currency (cross-cut 04) bounds what the self-builder agents may touch.
8. **The flywheel, closed.** Shipped improvements (e.g. a better diff surface, the local-LLM adapter)
   make the next build cheaper/better; the operator-owned dataset (idea 040) + calibration (055) learn
   which approaches ship cleanly — self-improvement as the closed loop of cross-cut 02, applied to
   Paperclip's own source.

### Part C — The doable path: scale down to a kernel, then bootstrap up (recommended)

Building Part A in full *before* self-hosting is a large up-front bet. The far more achievable path is a
**capability bootstrap**: hand-build the smallest possible self-builder, then let it add capabilities to
*itself*, one verified feature at a time. Each shipped feature makes the builder more capable, so the
*next* feature is cheaper to build — a compounding ratchet rather than a big-bang.

1. **The kernel (hand-built, deliberately tiny).** The minimum that can land one verified change:
   **one dev agent + a git-backed workspace + a `run_tests` tool + a human approve/merge gate + revert.**
   No org chart, no budgets engine, no fancy review UI. If it can make a one-line fix, run the tests,
   and get a human to merge it, the kernel is done.
2. **Bootstrap by leverage — build the rungs of your own ladder.** Have the kernel build, test, and ship
   the features that most *reduce the cost or risk of building the next feature*, in order:
   - **structured test/build result capture** → the builder can now judge its own work programmatically;
   - **change-review diff surface (idea 017)** → human review gets faster, throughput rises;
   - **a QA/reviewer agent + the red→green→refactor→review lifecycle (`pm-tdd`)** → quality rises, human
     review burden falls;
   - **eval + governance gating (idea 011)** → it can now safely touch more sensitive code;
   - **capability-based assignment + a 2nd specialist (idea 025)** → it's a small org; work parallelizes;
   - **security scan (050), per-run caps (024), reliability tracking (044)** → safety & economics;
   - **the engineering-org blueprint (018) + more roles** → Part A is now fully *grown*, not pre-built.
3. **Autonomy grows with capability, earned not granted.** The kernel starts at minimum autonomy
   (Autonomy Dial cross-cut 01 at Level 0–1: every change human-reviewed). As it ships the capabilities
   that *create* trust signals — tests, QA, eval gates — the trust currency (cross-cut 04) and the dial
   loosen automatically. Capability and freedom ratchet up *together*, so the system is never more
   autonomous than its own proven ability to verify itself.
4. **Each rung is independently shippable and revertible**, so the whole program de-risks into a series
   of small, tested, human-ratified merges — and stops safely at any rung if a step regresses. Only after
   the ladder is built does the self-builder approach its own governance/runtime code, still under the
   mandatory-ratification guardrail (Part B step 7).

The elegance: the ordered self-build sequence above *is* a slice of this very backlog, so the bootstrap
literally consumes `.ideas/` to assemble the machine that consumes `.ideas/`.

### Part D — Give it a memory (the Code-Knowledge Flywheel)

Pair this with the Knowledge System (idea 060): as the company builds, the llm-wiki accumulates a curated
**snippet/pattern library** (reuse), an **architecture graph** of the codebase (hybrid vector + call/
dependency graph, so agents understand what calls what), and **canonical specs/conventions** injected
into build context. Agents retrieve from all three *before* writing code — so new code fits existing
patterns and prior solutions aren't re-derived — and the curator writes new learnings back after each
accepted change. For self-hosting this is close to essential: every rung the bootstrap (Part C) ships is
indexed into the system's model of *itself*, so the ratchet **compounds** — it builds an ever-better map
of its own architecture as it grows. Detailed in
`combinations/cross-cutting/xcombo-code-knowledge-flywheel.md`.

## Why it matters strategically

This is the strongest possible proof of the product: *Paperclip demonstrably ships real, reviewed,
tested software — including its own features.* It converts the entire `.ideas/` backlog from a wishlist
into executable work, makes Paperclip the reference customer for its own software-building capability,
and establishes a defensible, *governed* path to self-improvement that the self-modifying-scaffold
research warns is otherwise brittle. It also unlocks Paperclip as a genuine software-agency platform for
everyone else, not just a business-ops orchestrator.

## Perceived complexity

**High** — but unusually *de-risked* because almost every prerequisite already exists as code or skills
(workspaces, work products, eval harness, change-review, security-scan plan, and the devon/pm-tdd/
qa-engineer skills). The real work is (a) the git-backed workspace + build/test/CI loop welded into the
issue lifecycle, and (b) the **self-hosting safety surface** — guaranteeing the self-builder cannot
weaken its own guardrails, with mandatory human ratification on safety-critical diffs, full audit, and
reliable revert. **The phasing that makes it tractable is Part C**: instead of building all of Part A
up front, hand-build the tiny kernel and let it bootstrap its own capabilities one verified, revertible
feature at a time, with autonomy ratcheting up only as fast as its proven ability to verify itself.
Under that approach the *initial* lift is small (a single dev agent + git workspace + test runner +
human gate); the system grows the rest. Keep governance/runtime code behind mandatory human ratification
until the ladder is fully built and trusted.

## Sources

- [Live-SWE-agent: Can Software Engineering Agents Self-Evolve on the Fly?](https://arxiv.org/html/2511.13646v3)
- [SWE-EVO: Benchmarking Coding Agents in Long-Horizon Software Evolution](https://arxiv.org/pdf/2512.18470)
- [Effective Strategies for Asynchronous Software Engineering Agents](https://arxiv.org/pdf/2603.21489)
- [SWE-agent (Princeton) overview, 2026](https://www.solosoft.dev/post/swe-agent-software-engineering-2026/)
- [Agentic AI Benchmarks 2026 — CodeSOTA](https://www.codesota.com/agentic)
