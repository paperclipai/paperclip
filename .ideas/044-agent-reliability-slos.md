# 044 — Agent Reliability SLOs & Error Budgets

## Suggestion

Paperclip has solid machinery for *recovering* from broken runs — `run-liveness.ts`,
`issue-liveness.ts`, `task-watchdogs.ts`, the recovery classifiers (`server/src/services/recovery/`),
process recovery, scheduled retries. But it has no notion of an agent's **reliability over time**.
An agent (or its adapter/runtime) that crashes 40% of the time, constantly needs recovery, or
fails to complete runs is a chronic drain — yet nothing tracks that failure *rate*, sets an
expectation for it, or escalates when an agent becomes unreliable. Diminishing-Returns (idea 003)
catches *unproductive* runs and per-run caps (idea 024) catch *runaway* runs; neither catches an
agent that is simply *flaky*. Operators only notice when they happen to look.

Borrow SRE practice: give agents **reliability SLOs and error budgets** — track success/failure
rates, define an acceptable threshold, and act when an agent burns through its error budget.

## How it could be achieved

1. **Reliability metrics per agent.** From data the recovery/liveness layer already produces,
   compute rolling rates: run success vs failure, recovery invocations, crash/timeout frequency,
   retries-to-completion. These are byproducts of mechanisms that already run.
2. **Define SLOs + error budgets.** Per agent/role/tier: "≥90% of runs complete without
   recovery." The error budget is the allowed failure share over a window; burning it fast is the
   alert signal — standard SRE framing applied to agents.
3. **Graduated response on burn.** Warn, then auto-constrain a chronically failing agent
   (lower its concurrency, drop its trust stage — idea 009), then pause and escalate to a human
   or its manager agent. A flaky agent shouldn't keep getting fed work and budget.
4. **Diagnose the cause.** Correlate failures with adapter/model/environment so the operator can
   tell "this *agent* is misconfigured" from "this *provider/runtime* is degraded" — the latter
   pairs with provider fallback chains (idea 012) and quota windows.
5. **Surface it.** A reliability column on agents and a fleet reliability view; feed the signal
   into capability-based assignment (idea 025) so flaky agents get less critical work until they
   recover.

## Perceived complexity

**Low–Medium.** The failure/recovery events already exist — this is largely a metrics/aggregation
+ thresholding + escalation layer over them, not new runtime. The design care is in defining
"failure" precisely (a recovered run that still completed isn't the same as a lost one) and in
windowing so a brief provider outage doesn't nuke an otherwise-good agent's budget. The auto-
constrain ladder reuses existing levers (concurrency, trust stage, pause). High operator value
for modest effort: it turns silent flakiness into a tracked, actionable signal.
