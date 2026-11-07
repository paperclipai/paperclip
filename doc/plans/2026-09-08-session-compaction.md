# Session Compaction Proposal

Status: proposal. No code changes. Seeks maintainer direction before any
Path-2 implementation work.

## Context

Long-lived agent sessions degrade. Context fills with tool output, old
decisions go stale, and adapters slow down or fail past model limits.
Paperclip already rotates overgrown sessions, but rotation drops working
context: the replacement session restarts from a thin handoff. DeepSeek
Harness closes the same gap with a compaction seam (`packages/compaction/*`
plus `packages/guard/*` spill policy): pressure-triggered and
operator-invoked (`/compact`) summarization that replaces old history with a
structured checkpoint while keeping a verbatim tail. This proposal ports the
summarize-and-continue half to Paperclip's rotation model.

## What We Know Today

- Session resume state lives in `agent_task_sessions.session_params_json`,
  keyed by company, agent, adapter type, and task key, plus adapter-native
  session stores referenced by `heartbeat_runs.session_id_before/after`.
  Read path: `getTaskSession` in `server/src/services/heartbeat.ts`.
- Twelve adapters (`packages/adapters/*`) each own their session format,
  mostly behind per-adapter codecs (`sessionCodec` serialize/deserialize).
  OpenClaw Gateway is the exception: it has no `sessionCodec` and derives
  a session key from its configured strategy (`sessionKeyStrategy`:
  issue, fixed, or run), so any history-read or rewrite seam needs an
  explicit OpenClaw path, not just codec coverage.
- Rotation already exists and is policy-driven:
  `packages/adapter-utils/src/session-compaction.ts` resolves a per-adapter
  policy (run count, raw input tokens, session age; defaults 200 runs, 2M
  tokens, 72h; native-context-management adapters opt out of threshold
  rotation) with agent overrides and source tracking. The dispatch-side
  decision (`SessionCompactionDecision` in `heartbeat.ts`) rotates past
  threshold and attaches a deterministic handoff markdown: previous session
  id, rotation reason, last-run summary, and a continuation summary excerpt.
- Related work already open: proactive session rotation costs (#4496),
  compact-usage status parsing as a pressure signal (#4577), policy
  resolver coverage (#4920), Codex recovery compaction handoffs (#7838),
  adapter stdout compaction (#10249). This proposal builds on that line, it
  does not restart it.
- Continuation summaries (`server/src/services/issue-continuation-summary.ts`)
  are deterministic metadata rollups (8,000 char cap), not conversation
  summaries. They preserve outcomes, not reasoning.
- Per-run token usage is recorded (`heartbeat_runs.usage_json`).
- A fresh-session reset exists end to end (`forceFreshSession`).
- Prior art studied in DeepSeek Harness:
  - `compaction-basic`: threshold ratio 0.8 of model context, 0.16 verbatim
    tail retention, per-model policy overrides, auxiliary-LLM summarization
    with a fixed checkpoint schema (intent, concepts, files, errors, pending,
    current work, next step, critical context), prefix-cache-aligned replay.
  - `region`: token-metered span selection, tool-pairing balance,
    transactional commit with stability guarantees across async
    summarization.
  - `command-compact`: argument-free operator command with a closed failure
    taxonomy (busy, cancelled, changed, summary, commit, persistence).
  - `compaction-tool-result-pruner` and `spill-policy`: oversized tool
    results are pruned/spilled before they enter history.

## The Gap

Rotation answers *when* to restart a session. It does not answer *what to
carry over*. Today's handoff holds the last run's summary plus a
continuation excerpt. Everything else — reasoning chains, file context,
pending-job nuance, corrections — is dropped. Operators also have no
way to trigger this early on a session they can see going stale, and no
visibility into per-session pressure before rotation fires.

## Goals

1. Upgrade rotation handoffs from last-run summaries to condensed
   checkpoints that preserve reasoning and working context.
2. Provide an operator-invoked compact action for sessions visibly going
   stale, reusing the rotation commit path.
3. Give operators per-session pressure visibility (runs, tokens, age vs
   policy) before rotation fires.
4. Charge summarization cost explicitly and log every compaction in the
   activity trail.

## Non-Goals

- Changing adapter session formats, the resume codec contract, or the
  rotation policy resolver. Compaction plugs into the existing decision
  point.
- Silent automatic rewrites. Manual compaction first; automatic
  checkpoint-on-rotation only after per-adapter safety is demonstrated.
- Cross-issue or cross-agent memory. Compaction stays within one task
  session. Durable knowledge is the Memory/Knowledge roadmap item, separate.
- Replacing continuation summaries or the deterministic handoff. The
  checkpoint augments them.

## Proposed Model

### Phase 1: pressure visibility (Path-1 sized, no prompt changes)

- Derive per-task-session pressure from existing rows: run count and error
  streak from `heartbeat_runs`, token usage from `usage_json`, session age,
  each against the resolved rotation policy for that adapter. Token math
  must respect reporting shape: per-run usage is summed, while adapters
  that report cumulative session usage on each run contribute only deltas,
  or pressure reads inflated past the threshold.
- Surface it where operators already look: the run/session UI and wake
  metadata (numbers only, never content).
- No summarization, no rewrites, no new prompts. Pure observability that the
  later phases read. Complements #4577 (usage parsing as signal).

### Phase 2: summarize-and-continue (Path-2, this proposal's core)

- New operator action on a task session: `compactSession`. New automatic
  behavior later: attach a checkpoint where rotation currently attaches
  only the deterministic handoff.
- Execution, mirroring the harness commit protocol and reusing the
  rotation decision point:
  1. Select a span: the session history minus a verbatim tail (propose the
     reference default of 0.16 measured context). Prerequisite: a history
     read API. The shared codec handles opaque resume metadata only, and
     the rotation path reads run summaries, not adapter conversation
     history — span selection with version checking needs a shared or
     per-adapter history seam first, without which the non-goal of leaving
     adapter contracts unchanged cannot hold.
  2. Summarize the span with an auxiliary model call using a fixed
     checkpoint schema (adopt the reference sections: intent, concepts,
     files, errors, pending, current work, next step, critical context).
     Prior checkpoints merge forward (preserve true facts, drop stale
     ones), never copied verbatim.
  3. Commit transactionally: verify the span is unchanged since selection,
     write the checkpoint, rotate through the existing rotation path with
     the checkpoint as the handoff body, record the attempt and outcome in
     `heartbeat_run_events` and the activity log.
  4. Closed failure taxonomy like the reference: busy, cancelled, changed,
     summary, commit, persistence. Any failure leaves the session runnable
     on its pre-compaction state.
- Per-adapter handling: adapters with confirmed native context management
  (already opted out of threshold rotation) need an explicit decision —
  drive their native compaction, or run Paperclip checkpoints above it.
  One pilot adapter first (propose `codex_local`, building on #7838).
- Summarizer model and budget: explicit per-company configuration, default
  off; summarization spend recorded as its own cost event, never folded
  into the agent's task budget silently.

### Phase 3: automatic checkpoint-on-rotation (later, needs phase 2 data)

- Where rotation currently attaches the deterministic handoff, attach a
  checkpoint instead, gated per adapter. Operator-visible, logged, with
  fresh-session reset kept as the escape hatch (reset discards the active
  session and starts clean; it does not restore pre-compaction state, so
  true rollback would need a snapshot mechanism defined separately).

## Open Questions for Maintainers

1. Who pays for the summarizer call: the agent's budget, a company-level
   compaction budget, or instance config? Who chooses the model?
2. Should the checkpoint schema be shared across adapters or per-adapter?
3. Where should checkpoints live: inside `session_params_json`, as issue
   documents beside continuation summaries, or a new table?
4. Does the wake prompt need a "compacted context" marker so agents trust
   but verify checkpoints (low-trust implications)?
5. Confirm `codex_local` as the rewrite-seam pilot, and the desired behavior
   for native-context-management adapters?
6. Should phase 1 pressure numbers feed existing budgets/watchdogs, or stay
   advisory until phase 2?
7. What provides the history-read seam for span selection: a shared
   adapter-history API, per-adapter implementations, or reuse of an
   existing transcript surface?

## Risks

- A bad summary loses working context mid-task. Mitigation: verbatim tail,
  transactional commit, failure taxonomy, fresh-session escape hatch, and
  the deterministic handoff stays attached regardless.
- Twelve adapters means twelve behaviors to verify. Mitigation: reuse the
  existing policy resolver and native-management flags, one pilot first.
- Summarization adds model spend (the concern behind #4496). Mitigation:
  explicit config default off, separate cost events.

## Alternatives Considered

- Rotation handoffs as-is (status quo). Rejected: last-run summaries drop
  reasoning and working context; operators cannot trigger early.
- Fresh-session reset only. Rejected: loses all working context.
- Extending deterministic continuation summaries. Rejected: metadata
  rollups cannot preserve reasoning, file context, or pending-job nuance.
- Per-adapter native compaction as the primary path. Rejected: inconsistent
  across twelve adapters and invisible to Paperclip governance; acceptable
  as a fallback under the control-plane seam.
- Doing nothing. Rejected: session growth is the primary quality cliff for
  24/7 autonomous operation (MAXIMIZER MODE direction).
