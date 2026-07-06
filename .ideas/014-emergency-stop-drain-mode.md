# 014 — Emergency Stop & Drain Mode (The Big Red Button)

## Suggestion

An autonomous company spends real money and takes real actions without a human in the loop.
When something goes wrong — a prompt change gone bad, a runaway loop, a provider bill
spiking, a security worry — the operator needs to **stop everything instantly and safely**.
Today the levers are per-agent pause and the company `status` / `pauseReason` fields, but
there's no single, instant, instance-wide *halt* that also brings runs to a clean state.
"Pause one agent at a time while 30 are burning tokens" is not an emergency control.

Add two first-class controls: a **Panic Stop** (immediate, instance- or company-wide halt of
all agent runs) and a **Drain Mode** (stop *starting* new runs but let in-flight ones finish
cleanly) — the graceful counterpart for planned maintenance or winding down.

## How it could be achieved

1. **Global halt flag.** An instance-level and per-company `executionState`
   (`running` / `draining` / `halted`) checked at the single choke point where
   `heartbeat.ts` decides to start a queued run. `halted` refuses all new starts; `draining`
   refuses new starts but leaves running ones alone.
2. **Panic = halt + cancel.** Panic Stop sets `halted` *and* signals cancellation to live
   runs (the cancel path already exists — see `issue-comment-cancel-routes`), then records who
   triggered it and why to `activity-log.ts`.
3. **Drain = halt new only.** Drain sets `draining` and surfaces a live "N runs draining…"
   readout, flipping to fully halted once the count hits zero.
4. **Safe resume.** Resuming from halt should *not* stampede — re-admit runs gradually through
   the Fleet Concurrency Governor (idea 001) rather than launching everything at once.
5. **UI.** A persistent, unmistakable control in the top bar with a confirm step, scoped to
   instance or a single company, plus an auto-trigger hook so the Predictive Budget Breaker
   (idea 002) can invoke Drain automatically under extreme burn.

## Perceived complexity

**Low–Medium.** The state field and the start-time check are small, and a cancellation path
already exists to build the panic action on. The work is making the guarantee *trustworthy* —
the halt must be honored at every place a run can start (including process recovery and
scheduled retries), or "stop" won't actually stop. That single-choke-point discipline is the
crux; pairs naturally with the governor (001) for safe resume.
