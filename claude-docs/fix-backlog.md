# Fix Backlog — prioritized issues from the B1 pilot + architecture audit

> Written 2026-06-14. Consolidated, severity-ranked list of every issue surfaced
> by the B1 pilot and the five-front architecture audit. Each item carries
> evidence (file:line), the owning plan, and effort. Source docs:
> `agent-execution-architecture-and-b1-findings.md`, `triage-gate-plan.md`,
> `wake-cost-and-readiness-plan.md`, `platform-burn-guard-plan.md`,
> `b1-gap-fix-plan.md`, `pilot-log.md`.

## Severity scale

- **P0** — active token waste or guaranteed burn. Fix first.
- **P1** — correctness/blocking, or unbounded cost on real work.
- **P2** — efficiency, test debt, protocol adherence.
- **P3** — ops/env.

Effort: **S** = small/surgical, **M** = medium (multi-file + tests).

---

## Status — updated 2026-06-14 (after the build session)

Shipped this session (branch `pilot/b1-dogfood`), each with a `claude-docs/` overview:

| Item | Status | Commit | Overview |
|---|---|---|---|
| #1 W2 idle short-circuit | ✅ shipped | `8daad42d` | `wake-cost-fixes-overview.md` |
| #2 W1 instruction-readiness | ✅ shipped | `8daad42d` | `wake-cost-fixes-overview.md` |
| #5 W3 Claude session rotation | ✅ shipped | `06b00c66` | `wake-cost-fixes-overview.md` |
| #6 triage (solo/light/full) | ✅ shipped | `444297cf` | `gate-triage-overview.md` |
| #3 done-gate dead-end | ✅ shipped (rode #6) | `444297cf` | `gate-triage-overview.md` |
| #7 G3 per-run ceiling + #10 tests | ✅ shipped **as post-run enforcement** | `c8e243cd` | `per-run-ceiling-overview.md` |
| #9 W5 targeted gate wake | ⏳ **W5a shipped**; W5b/W5c deferred | `17476dbd` | `targeted-gate-wake-overview.md` |

Revised understanding of the **remaining** items (corrected against the code):

- **#4 factory instructions** — still open. Needs its own **scoping pass**: entangled
  with operator-local/gitignored AGENTS.md bundles + the skill-sync pipeline across
  adapters. Half provisioning-concern, half self-heal-sync code. Do NOT build blind.
- **#8 W4 minimal review payload** — **downgraded / likely deprecated.** Once W3 caps
  the transcript and the wake payload is already bounded (`MAX_INLINE_WAKE_COMMENTS=8`,
  12k chars) and reviewers force-fresh, the marginal value collapsed. The plan's "10×"
  claim conflated the transcript (W3) with the wake payload. Skip unless evidence shows
  review-wake payloads are still fat.
- **#9 W5b** — reviewer wake on `in_review`. The bulk of the gate-wake value (2 of 3
  gate types, per-leaf). Needs integration into the issues PATCH-update wake flow.
- **#9 W5c** — raise default cadence. Only safe after W5b; low marginal value post-W2.
- **#11 CTO self-assign protocol** — eco-system prompt (`teams/agent-team/prompts/`),
  **out of this repo's scope**.

Net: all three load-bearing legs are in — **wake-cost** (W1/W2/W3 ✅, W4 deprecated,
W5a ✅/W5b open), **triage** (✅), **burn-guard** (✅, G3 closed). What's left is one
genuine feature (#4, needs scoping) and one wake-latency follow-up (W5b).

---

## P0 — pure-waste burn, fix first

| # | Issue | Evidence | Fix | Plan | Effort |
|---|---|---|---|---|---|
| 1 | **Idle wakes** — exec agents auto-wake on global cadence with no actionable-work check (B1: CEO/CMO ~24×, ~11M tok, zero output) | `heartbeat.ts:11176` `tickTimers` wakes all invokable agents; no idle short-circuit | **W2** idle short-circuit — skip timer wakes when agent has no in-progress/assigned/gate/monitor work | wake-cost | S |
| 2 | **Empty-instruction burn** — agent with empty managed bundle runs and flails (B1: Architect 1.17M, zero output) | `agent-instructions.ts:282` silent empty; `execute.ts:450` runs with null instructions; no readiness check | **W1** readiness gate — pause + incident, never invoke adapter | wake-cost | S |

Both slot into the existing pre-wake gate stack (`heartbeat.ts:9941–10019`) and reuse
the skip/pause/incident plumbing. Highest ROI in the backlog — together they retire
the ~12M of pure B1 waste (C1 + C2).

---

## P1 — blocking correctness + unbounded cost

| # | Issue | Evidence | Fix | Plan | Effort |
|---|---|---|---|---|---|
| 3 | **Done-gate dead-end (C5)** — dev_team `done` needs a worktree PR; shared-branch tasks can never close as agent, need operator override every time | `plan-gates.ts:113` requires `prUrl`; only set via git-ops worktree route | tier-aware done-gate (solo/light skip PR + both-gates) | triage L2 | M |
| 4 | **Factory agents have no instructions** — Architect/Reviewer/Wiring in B1 couldn't perform gates; hand-operated. dev_team gates are rubber-stamps until fixed | C2 at factory level; `paperclipSkillSync.desiredSkills` never materialized | provisioning barrier at plan activation + self-heal sync | wake-cost W1 (2b/2c) | M |
| 5 | **Transcript replay (C3)** — resumed wakes re-send growing transcript at full price; rotation built but **disabled for Claude** | `session-compaction.ts:32-37` (claude in native-disabled set); no prompt cache | **W3** enable + tune `maxRawInputTokens` for Claude | wake-cost | S |
| 6 | **Fixed-max gate (C4)** — full 5-role gate runs for trivial tasks (~3000–5000× overhead) | `plan-gates.ts:65` always emits 3 gates; `PlanGateProfile` binary | triage tiers: Layer 0 floor + tier-aware `buildGateApprovalsForActivation` | triage | M |
| 7 | **G3 token ceiling suppression-only** (our own gap) — blocks the retry, never hard-kills a fat run mid-flight | `heartbeat.ts:9058-9099` warns + suppresses continuation, no run-cancel | cost-event callback during execution → run-cancel path | burn-guard followup | S–M |

---

## P2 — efficiency, test debt, protocol

| # | Issue | Evidence | Fix | Plan | Effort |
|---|---|---|---|---|---|
| 8 | **Reviewers rebuild full context** — fresh review run reconstructs from full payload it doesn't need | `heartbeat.ts:2375` wake payload not role-branched | **W4** minimal review payload (diff + checklist + summary) | wake-cost | M |
| 9 | **Gates discovered via global cadence** — gate creation doesn't wake the designated agent | `plan-gates.ts:65`; gates create inbox approvals only | **W5** targeted gate wake, then raise `intervalSec` | wake-cost | S |
| 10 | **G3 missing tests** — token-kill + turns-clamp planned, not written | guard-budget.test.ts (4 tests, 2 missing) | add 2 tests | burn-guard | S |
| 11 | **CTO self-assigns vs delegating** | B1 deviation #2 (`pilot-log.md`) | hard delegation contract | b1-gap-fix | S |
| 12 | **Auto-heartbeat during setup** (stopgap = company pause) | b1-gap-fix Fix 4 | superseded by W2 (#1) | — | — |

---

## P3 — ops/env

| # | Issue | Evidence | Fix |
|---|---|---|---|
| 13 | tmpfs full (`/private/tmp` ENOSPC mid-session) broke CLI output capture | this session | set `CLAUDE_CODE_TMPDIR` to a roomy dir / clear tmp |

---

## Recommended sequence

```
P0:  #1 W2 idle short-circuit  +  #2 W1 readiness gate    ← ship together, biggest drop
P1:  #5 W3 rotation (small)  →  #6 triage  →  #3 done-gate (rides triage L2)
     #4 factory instructions (makes gates real, not rubber-stamps)
     #7 G3 hard-kill  +  #10 G3 tests
P2:  #8 W4  →  #9 W5  →  #11 protocol
```

## Dependencies that matter

- **#3 done-gate fix rides triage Layer 2 (#6)** — same function/file.
- **#9 W5 needs #1 W2 first** — a slow global cadence is safe only after the idle-skip lands.
- **#8 W4 best after #5 W3** — rotation keeps the resumed session small; W4 trims the fresh review payload.
- **#7 G3 hard-kill + #10 tests** ship together — the test proves the kill.

## The single highest-leverage move

Ship **#1 + #2 (W1 + W2) together** — two small pre-wake gates that kill C1 + C2
(the ~12M of pure B1 waste) and reuse machinery that already exists. Everything else
is cost-shaping on top of a system that no longer burns on idle or brain-dead agents.

## Three load-bearing legs (independent)

1. **Triage** (`triage-gate-plan.md`) — cuts *how many* agents gate a task.
2. **Wake-cost / readiness** (`wake-cost-and-readiness-plan.md`) — cuts *what each wake costs* and *whether it should happen*.
3. **Burn guard** (`platform-burn-guard-plan.md`, shipped) — hard ceiling under everything.

No single leg is load-bearing alone; together they make small→big task management work.
