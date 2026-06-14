# Wake-Cost Fixes — W1 + W2 + W3 (shipped) Overview

> Written 2026-06-14. Covers the three wake-cost fixes shipped from the B1 pilot
> backlog: **W1** instruction-readiness gate, **W2** idle short-circuit gate,
> **W3** Claude session rotation. Background, what each fixes, the solution, and
> the end-to-end flow. Source plans: `wake-cost-and-readiness-plan.md`,
> `agent-execution-architecture-and-b1-findings.md`, `fix-backlog.md`.
> Commits: `8daad42d` (W1+W2), `06b00c66` (W3).

---

## Background — why this work exists

The **B1 dogfood pilot** ran a real dev-team task (HIV-12: add one line to
`CHANGELOG.md`) through the agent company. Billed dollars were $0 (subscription
runs), but the **token burn was enormous and entirely structural**:

| Source | Burn | Root cause |
|---|---|---|
| CEO / CMO exec agents | ~24 wakes, **~11M tok**, zero output | woke on a fixed timer with no check for whether they had any work (**C1**) |
| Architect | **1.17M tok**, zero output | had an empty instruction bundle, ran anyway and flailed (**C2**) |
| CTO | **2.2M tok** lifetime on a one-liner | each wake replayed the whole growing transcript at full price (**C3**) |

Three independent waste drivers. None is "the model being dumb" — each is a
**missing gate or a disabled mechanism** in the platform. W1/W2/W3 close them.

A key earlier finding: **most of the fix already existed in the codebase** as
machinery that was turned off or never consulted. This was wiring + gates, not
new subsystems.

---

## The three fixes at a glance

| Fix | Driver killed | One-line description | Kind |
|---|---|---|---|
| **W1** | C2 — empty-instruction burn | Refuse to invoke an agent with an empty managed instruction bundle | pre-wake gate |
| **W2** | C1 — idle wakes | Skip timer wakes for an agent with no actionable work | pre-wake gate |
| **W3** | C3 — transcript replay | Rotate the Claude session before its replayed transcript grows unbounded | config flip |

W1 + W2 are **pure-waste killers** (the burned runs produced nothing). W3
**caps the cost of real work** (it doesn't shrink a genuinely big task, it stops
the same task being re-paid for on every wake).

---

## W1 — Instruction-readiness gate

**Problem.** An agent's "instructions" live in a managed bundle (a directory of
markdown files). If that bundle is empty — e.g. skills never synced — the agent
still woke, invoked the model with no instructions, and burned tokens
accomplishing nothing (B1 Architect: 1.17M).

**Solution.** A pre-wake gate that, for a managed-bundle agent with zero
instruction files, **pauses the agent + opens an incident instead of invoking
the model** — reusing the exact pause/incident path the budget breaker already
uses, so it lands in the same operator resume surface.

- Probe: `agentInstructions.isManagedBundleEmpty(agent)` — cheap fs check (dir
  stat + file list, no file reads). Only flags `mode === "managed"` with no
  files and no legacy prompt template. External/unmanaged agents never flagged.
- Service: `instruction-readiness.ts` (a twin of `run-breaker.ts`) —
  `evaluate()` returns a fault, `trip()` pauses + raises the incident.
- Placement: in `enqueueWakeup`, **after** invokability/policy (so an
  already-paused agent is filtered first → one incident, not one per wake);
  applies to **every** wake source (a brain-dead agent must never run).
- Defense in depth: re-checked in `claimQueuedRun` (a bundle can empty between
  enqueue and claim).

**Flow:**

```
wake (any source)
  → company.active → budget → breaker → invokability → policy
     → isManagedBundleEmpty(agent)?
        ── empty ──► writeSkippedRequest("agent.instructions_empty")
                     → instructionReadiness.trip(): pause agent + open incident
                     → return (NO model run)            ◄── operator restores
                                                            instructions, resumes
        ── ok ─────► continue ▼
```

---

## W2 — Idle short-circuit gate

**Problem.** `tickTimers` woke **every** invokable agent on a fixed per-agent
interval, with no check for whether the agent had anything to do. An idle exec
agent woke, spun up a full run to discover it had no work, and paid for that
discovery — 24× in B1.

**Solution.** Before spending a run, ask **"does this agent have actionable
work?"** If not, and the wake is a **timer** wake, skip it.

- Predicate: `actionable-work.ts › hasActionableWork(db, agentId, companyId)` —
  true when the agent has an assigned issue `in_progress`/`in_review` (excludes
  blocked/backlog/done, and subsumes due-monitor wakes), **or** a pending gate
  approval routed to it (`payload.designatedAgentId`). Single exported function
  so the two call sites can't drift.
- **Critical guardrail:** only the **timer** source is ever skipped.
  assignment / gate / monitor / recovery / on_demand wakes always carry intent
  and always run.
- Two enforcement points: a pre-filter in `tickTimers` (skip the enqueue
  round-trip entirely) and the authoritative check in `enqueueWakeup`.

**Flow:**

```
tickTimers (timer) ──► hasActionableWork(agent)? ── no ──► skip, next agent
                                                  └─ yes ─► enqueueWakeup ▼

enqueueWakeup:
  ... W1 ...
   → source == "timer" && !hasActionableWork(agent)?
        ── yes ──► writeSkippedRequest("agent.no_actionable_work") → return (NO run)
        ── no  ──► continue ▼
   (assignment / gate / monitor / on_demand: skip this check entirely — always run)
```

Pairs with the (planned) triage work: `solo`-tier tasks don't assign exec
agents, so those agents simply stay asleep.

---

## W3 — Claude session rotation

**Problem.** An agent's **session** is its running transcript. Each wake does
`claude --resume <session>`, which **replays the whole accumulated transcript**
to the model — billed in full, every wake, because spaced wakes outlive
Anthropic's 5-minute prompt cache. So per-wake input climbs: 10k → 120k → 900k →
2M on the same task. That's how the CTO hit 2.2M on a one-liner.

The platform **has** a session-rotation mechanism (start a fresh session
carrying a short handoff + continuation summary when a threshold is crossed) —
but it was **switched off for `claude_local`** (threshold `0` = never). The
reason: the Claude CLI manages its own context window, so Paperclip rotation was
deemed redundant. That reasoning conflates two things:

| | overflow | cost |
|---|---|---|
| CLI native compaction handles it? | ✅ yes (never exceeds context) | ❌ no (replays at full price) |

The CLI only compacts near the **context ceiling**; everything below it is
replayed at full price, wake after wake.

**Solution.** Give `claude_local` its own default policy
(`CLAUDE_NATIVE_COST_ROTATION_POLICY`, `maxRawInputTokens` **400k**, runs/age 0)
instead of the all-zero const it shared with acpx/codex. The existing rotation
engine then fires — rotating on **cost, below** the CLI's native-compaction
point. `nativeContextManagement` stays `"confirmed"` (we don't fight the CLI's
overflow handling); acpx/codex are untouched; the threshold is tunable per agent.

**Flow:**

```
agent(claude_local) wake
  → resolveSessionCompactionPolicy → maxRawInputTokens = 400k (was 0)
     → evaluateSessionCompaction: latest wake's input tokens ≥ 400k?
        ── yes ──► rotate: start FRESH session
                   + handoff markdown ("rebuild only the minimum context")
                   + deterministic continuation summary (≤8k)
                   → old fat transcript stops being replayed
        ── no ───► resume existing session as before
```

```
per-wake input tokens:

  WITHOUT (before)          WITH W3 (after)
   ▏10k                      ▏10k
   ▎50k                      ▎50k
   ▌120k                     ▌120k
   █▋400k                    ▏15k   ← rotated at threshold
   ███▏900k                  ▎40k
   ██████ 2M                 ▌110k
   ↑ grows forever           ↑ sawtooth, bounded
```

**Caveat.** Rotation is **pre-run** (between wakes), so it caps cost *across*
wakes — it does not bound a single fat run mid-flight. That is a separate guard
(G3 per-run token hard-kill, backlog #7).

---

## End-to-end: where the three sit in one run

```
                    ┌──────────── WAKE SOURCES ────────────┐
                    │ timer · assignment · gate · monitor   │
                    │ · recovery · on_demand                │
                    └──────────────────┬───────────────────┘
                                       │
              ┌───── tickTimers pre-filter (timer only) ─────┐
              │  W2: hasActionableWork? ── no ──► SKIP        │
              └──────────────────┬───────────────────────────┘
                                 │ yes / non-timer
   ┌────────────────────── enqueueWakeup ──────────────────────┐
   │ company → budget → breaker → invokability → policy         │
   │   → W1: bundle empty? ── yes ──► PAUSE + incident (no run) │
   │   → W2: timer & idle?  ── yes ──► SKIP (no run)            │
   │   → pause-hold                                             │
   └──────────────────────────┬────────────────────────────────┘
                              │ run created
              ┌──── session assembly ────┐
              │  W3: transcript ≥ 400k?   │
              │   ── yes ──► fresh session │
              │             + handoff      │
              └────────────┬──────────────┘
                           ▼
                       MODEL RUN
```

**Invariant the three together establish:** *no tokens are spent before an
agent is proven to have real, doable work, and no resumed session grows
unbounded.* B1 violated both — idle agents (W2), a lobotomized Architect (W1),
a replayed transcript (W3).

---

## Verification

- W1/W2: `server/src/__tests__/wake-readiness.test.ts`,
  `wake-idle.test.ts` + extended `instance-settings-service`, `guard-breaker`,
  `guard-budget` (28 tests).
- W3: `packages/adapter-utils/src/session-compaction.test.ts` +
  updated `heartbeat-workspace-session` (74 tests in that pair).
- All three behind config: `guards.wake.{pauseOnEmptyInstructions,
  skipIdleTimerWakes}` (W1/W2) and per-agent `sessionCompaction.maxRawInputTokens`
  (W3). No DB migration.

---

## What's still open (next legs)

These three are the **wake-cost** leg. Two legs remain (see `fix-backlog.md`):

- **Triage** (`triage-gate-plan.md`) — right-size *how many* agents gate a task
  (`solo`/`light`/`full`); frees the done-gate dead-end (#3).
- **Burn guard** (`platform-burn-guard-plan.md`, mostly shipped) — hard ceiling;
  remaining gap is the G3 per-run token hard-kill (#7).
- Wake-cost remainder: **W4** minimal review payload (#8), **W5** targeted gate
  wake + slower cadence (#9).
```
