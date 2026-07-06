# 011 — Eval-Gated Agent Config Deploys ("CI for Agents")

## Suggestion

An agent's behavior is defined by its adapter config and prompt (CLAUDE.md, SOUL.md, CLI args,
etc.). Editing that config is the highest-leverage, highest-risk action an operator takes — a
one-line prompt change can silently make an agent worse, more expensive, or non-compliant with
governance, and you only find out after it's spent real money in production. Paperclip already
ships an **eval harness** (`evals/promptfoo/` with `core.yaml`, `governance.yaml`, and a
`heartbeat-system.txt` prompt), but it's a repo-level developer tool, not wired into the
product's agent-editing flow.

Add **eval-gated config deploys**: when an operator changes an agent's config, run it against a
saved eval suite *before* the change goes live — CI for agents. Regressions block or warn;
clean runs deploy.

## How it could be achieved

1. **Per-agent eval suites.** Let operators attach a small set of eval cases to an agent
   (golden scenarios: "given this kind of issue, the plan should X, must not Y"). Reuse the
   existing promptfoo format/runner under `evals/` rather than inventing one.
2. **Diff-triggered run.** On an agent config edit, snapshot old vs. new config and execute the
   suite against the new config (ideally on a **local LLM** — idea 008 — so gating is free and
   fast).
3. **Governance assertions.** Ship default checks mirroring `governance.yaml`: the agent stays
   inside its company boundary, doesn't claim capabilities it lacks, respects spend/approval
   norms. These catch the dangerous regressions, not just quality drift.
4. **Gate + record.** Show a pass/fail report inline in the edit UI; on failure, require an
   explicit override and log it to `activity-log.ts`. Keep a history so an agent's quality is
   trackable over time (pairs with the trust ramp, idea 009).
5. **Optional pre-hire eval.** Run the suite once at hire time as part of the Dry-Run
   Estimator (idea 004) preflight.

## Perceived complexity

**Medium.** The eval runner exists, so the work is product-izing it: attaching suites to agents,
triggering on config diffs, surfacing results in the UI, and the gate/override/audit flow.
The conceptually tricky part is making per-agent evals cheap and deterministic enough to run on
every edit without friction — which is exactly why pairing it with a free local model (idea 008)
matters. Start as advisory (warn, don't block), graduate to a hard gate for governance checks.
