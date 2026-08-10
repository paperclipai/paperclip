# Paperclip production-readiness audit

Date: 2026-08-10 (Europe/Dublin)  
Audit window: trailing 30 days  
Operating constraint: fleet remains paused; no broad LLM resume was performed.

## Executive verdict

**Conditional GO for a small Codex-first revenue smoke after the current live tip and the cross-adapter cap patch are promoted. NO-GO for a full-fleet or scheduled-LLM resume tonight.**

The deployed service is healthy, its serving worktree is clean, and the latest database backup is current. The post-incident controls have reduced daily burn sharply and all enabled routine triggers currently route to deterministic shell handlers. The remaining production risks are bounded and visible: the deployed SHA trails the current `live` hardening tip, the Claude/Gemini ACP lanes lack the shared default cap until this patch is promoted, and two integration/replay hardening tasks remain unresolved.

## Trailing-30-day token forensics

| Measure | Result |
|---|---:|
| Cost events / runs with usage | 13,057 |
| Input tokens | 11,417,419,199 |
| Cached input tokens | 12,788,377,777 |
| Output tokens | 113,290,494 |
| Total metered tokens | 24,319,087,470 |
| Runs at or above 250K | 9,829 |
| Runs at or above 1M | 5,083 |
| Runs at or above 5M | 1,140 |
| Runs at or above 10M | 423 |
| Largest run | 104,171,862 |
| Events without a reported monetary price | 9,525 |

Monetary cost is not a reliable primary comparator because most subscription usage is unpriced in the ledger. Token volume, repeat-run count, and useful business outcome are the reliable control measures.

### Largest model lanes

| Model | Runs | Metered tokens |
|---|---:|---:|
| gpt-5.4 | 7,658 | 17,149,575,875 |
| gpt-5.6-terra | 3,366 | 1,901,280,220 |
| gpt-5.5 | 313 | 1,662,130,730 |
| claude-opus-4-8 | 612 | 1,372,499,429 |
| claude-sonnet-4-6 | 523 | 690,128,138 |

### Largest company lanes

| Company | Metered tokens |
|---|---:|
| ThinkStack Recruitment | 5,018,102,121 |
| ThinkStack Media | 4,832,612,153 |
| ThinkStack BootCamp | 4,546,411,565 |
| TSMC | 4,329,677,239 |
| ThinkStack Capital | 1,980,864,652 |

### Largest agent lanes

| Company | Agent | Runs | Metered tokens |
|---|---|---:|---:|
| ThinkStack BootCamp | Bench-Manager | 604 | 3,545,947,998 |
| ThinkStack Media | Coder-Codex | 281 | 2,076,845,473 |
| ThinkStack Recruitment | CMO | 1,939 | 1,612,280,622 |
| TSMC | Astra-Codex | 910 | 1,563,319,132 |
| ThinkStack Media | Prometheus-Codex | 368 | 1,005,105,868 |

### Repeat-loop offenders

| Issue | Runs | Metered tokens | Failure pattern |
|---|---:|---:|---|
| TSR-4477 | 1,894 | 1,549,768,386 | A daily CMO delta rail repeatedly executed as LLM work |
| TSM-5677 | 28 | 287,997,894 | Repeated media rerender/build loop |
| TSM-5612 | 28 | 222,468,246 | Repeated flagship rebuild loop |
| TSBC-1141 | 7 | 218,714,764 | Oversized decision-matrix reruns |
| TSC-6900 | 308 | 168,295,853 | Deterministic halt detection repeatedly routed through runs |

The dominant incident shape was therefore not one large prompt. It was long-lived model sessions plus repeat assignment/routine/recovery loops, with cached context reprocessed on every turn.

## Context and tool-efficiency findings

Persisted wake context is compact relative to the runaway totals:

| Persisted context measure | Bytes |
|---|---:|
| Average | 5,740 |
| P50 | 5,013 |
| P95 | 10,537 |
| P99 | 16,112 |
| Maximum | 126,903 |

This rules out multi-megabyte outer wake JSON as the primary cause. The expensive growth happened inside continued sessions, tool-turn history, repeated task replay, and cached provider context. The correct controls are per-run token cancellation, session compaction/checkpoints, wake deduplication, same-task session reuse with bounded handoff summaries, and repeat-failure circuit breakers—not merely trimming a few kilobytes from the wrapper.

Tool-call waste cannot yet be quantified reliably: `tool_invocations` and `tool_call_events` contain no usable 30-day coverage while raw heartbeat logs total about 8.14 GB. Treat tool-event coverage as an observability backlog item; do not infer savings that the ledger cannot prove.

The deterministic read-only report is now captured in `scripts/token-burn-audit.sql`, so future monthly/off-incident analysis does not require an LLM to rediscover the same joins and thresholds.

## Controls already present on current `live`

- ACP per-run usage cancellation and a non-retryable `token_budget_exhausted` disposition.
- Codex normal-run default of 400K, with explicit reviewed exceptions supported.
- 250K warning and 1M high-input review/block policy, including cached input.
- Duplicate wake suppression, fresh-wake context deduplication, bounded recovery wrappers, and same-issue recovery session keys.
- Session checkpointing/compaction and compact continuation summaries.
- Hermes cumulative usage-delta repair and recovery containment.
- Routine cadence ceilings, budget ceilings, and deterministic shell routing.
- Repeat high-token task guard and equivalent-failure classification on the current live tip.

## Gap closed in this candidate

The shared ACP engine had a functioning token stopper, but only Codex supplied a default `maxTokensPerRun`. Claude and Gemini could therefore run uncapped unless each agent happened to define a value.

This candidate introduces one shared 400K constant and applies it to Codex, Claude, and Gemini ACP configurations and schemas. Explicit reviewed overrides remain available. No schedule, status, model, prompt, or production data is changed.

Residual limitation: CLI fallback lanes and non-ACP adapters do not receive the live in-turn ACP cancellation. They remain protected only by post-run guards and cadence/repeat controls. Keep high-risk fallback lanes paused or explicitly force ACP until an equivalent streaming stopper exists.

## QEC and leadership alignment

- 226 non-terminated agents were inspected.
- 197 are paused, 27 idle, one active, and one in error at the final snapshot.
- All 57 CEO/C-level instruction sets contain strategic/delegation and revenue/CASH direction.
- Representative CEOs explicitly require KB consultation, QEC/OM1 routing, delegation to lower lanes, WIP limits, and next-euro/revenue prioritisation.
- All 10 enabled routine triggers are assigned to `paperclip_shell_handler`; no enabled trigger currently launches an LLM routine.

The architecture is aligned. The operational failure was execution discipline: routine-like reporting and detectors were still able to generate hundreds or thousands of model runs. Resume must enforce the architecture by measurement: C-level agents decide, prioritise, unblock, and review; lower lanes produce; scripts count, poll, diff, detect thresholds, and file mechanical rails.

## Bounded verification completed

- API health: healthy; auth ready; clean serving worktree.
- Backup gate: current logical backup, no backup warnings.
- Adapter/runtime tests: 7 files, 165 tests passed.
- Type checks: adapter-utils, Codex, Claude, and Gemini packages passed.
- Deterministic token audit: executed successfully against the live database in read-only mode.
- Queue/routine check: no queued or running heartbeat run at the final snapshot; no due issue monitors; enabled routines are shell-only.

No production model wake was fired during this audit. This preserves the manual pause and avoids turning a safety verification into another uncontrolled token event.

## Resume sequence

1. Promote the current `live` hardening tip plus this cap candidate as one pinned, tested deployment. Verify the served SHA and repeat API/backup health checks.
2. Keep all LLM schedules disabled. Start with at most **two lower-lane Codex workers total**, each on one pre-scoped revenue task with a 100K explicit run cap and a clear artifact acceptance test.
3. Observe for 30 minutes. Stop if any run crosses 250K, an equivalent failure repeats, a completed run lacks a disposition, or a recovery wake replays the same task without new durable state.
4. Require evidence of useful output per run. A successful process exit without a cash-moving artifact or an explicit strategic decision does not pass QEC.
5. Add CEO/C-level lanes sequentially only for portfolio choice, prioritisation, delegation, unblock, and review. Do not assign production, routine reporting, polling, transcription, rendering, or detector work to them.
6. Keep Claude and Gemini paused until their quotas recover **and** the cross-adapter cap is served. Keep Hermes/Grok as scarce fallback capacity, not background routine capacity.
7. After a clean bounded wave, expand lower lanes in small batches. Leave LLM timer routines disabled for a 24-hour clean window; re-enable only routines with an explicit business owner, cadence ceiling, run cap, dedupe key, and deterministic alternative review.

## Current blockers before full-fleet GO

- `TSMC-20732` — integration proof and TSB migration remains blocked.
- `TSMC-20748` — prompt/context replay runaway hardening remains todo.
- `TSMC-20749` — equivalent-failure scoped action integration is todo/unassigned even though the classifier commit has landed on `live`; task disposition and end-to-end proof still need reconciliation.
- The served SHA is behind the current `live` hardening tip and behind this candidate.

These do not block a two-worker Codex revenue smoke after promotion. They do block broad scheduled or multi-provider production.
