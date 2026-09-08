# Session Compaction Proposal

Status: proposal. No code changes. Seeks maintainer direction before any
Path-2 implementation work.

## Context

Long-lived agent sessions degrade. Context fills with tool output, old
decisions go stale, and adapters slow down or fail past model limits.
Operators today have two levers, both blunt: let the session keep growing,
or reset to a fresh session and lose all working context.

DeepSeek Harness solves this with a compaction seam (`packages/compaction/*`
plus `packages/guard/*` spill policy): pressure-triggered and operator-invoked
(`/compact`) summarization that replaces old history with a structured
checkpoint while keeping a verbatim tail. This proposal ports that idea to
Paperclip's heartbeat and adapter model.

## What We Know Today

- Session resume state lives in `agent_task_sessions.session_params_json`,
  keyed by company, agent, adapter type, and task key, plus adapter-native
  session stores referenced by `heartbeat_runs.session_id_before/after`.
  Read path: `getTaskSession` in `server/src/services/heartbeat.ts`.
- Twelve adapters (`packages/adapters/*`: Claude, Codex, Cursor, Gemini,
  Grok, Kimi, OpenClaw, OpenCode, Pi, Hermes, and cloud variants) each own
  their session format behind per-adapter codecs (`sessionCodec`
  serialize/deserialize in `heartbeat.ts`).
- A fresh-session reset already exists end to end
  (`forceFreshSession` from UI/API through `heartbeat.ts` into dispatch).
  Reset drops context; there is no middle ground.
- Continuation summaries (`server/src/services/issue-continuation-summary.ts`)
  are deterministic metadata rollups (run status, errors, excerpts; 8,000
  char cap), not conversation summaries. They preserve outcomes, not reasoning.
- Per-run token usage is recorded (`heartbeat_runs.usage_json`), but no
  pressure signal is derived from it. Nothing measures session size, age, or
  cost-to-continue per task session.
- Wake-prompt pressure valves exist piecemeal (comment truncation in
  `buildPaperclipWakePayload`, spill-behind-flag work in progress), but they
  bound single wakes, not session growth across runs.
- Prior art in DeepSeek Harness, studied for this proposal:
  - `compaction-basic`: threshold ratio 0.8 of model context, 0.16 verbatim
    tail retention, per-model policy overrides, auxiliary-LLM summarization
    with a fixed checkpoint schema (intent, concepts, files, errors, pending,
    current work, next step, critical context), prefix-cache-aligned replay.
  - `region`: token-metered span selection, tool-pairing balance, transactional
    commit with stability guarantees across async summarization.
  - `command-compact`: argument-free operator command with a closed failure
    taxonomy (busy, cancelled, changed, summary, commit, persistence).
  - `compaction-tool-result-pruner` and `spill-policy`: oversized tool
    results are pruned/spilled before they enter history.

## Goals

1. Give operators visibility into session pressure (size, age, run count,
   estimated tokens) per task session before quality degrades.
2. Provide an operator-invoked compact action that summarizes a session and
   resumes it, without losing pending work or auditability.
3. Add automatic pressure-triggered compaction only after manual compaction
   proves safe per adapter.
4. Charge summarization cost to explicit budgets and log every compaction in
   the activity trail.

## Non-Goals

- Changing adapter session formats or the resume codec contract.
- Silent automatic rewrites in phase 1 and 2. Every rewrite is operator
  visible and reversible (fresh-session reset remains the escape hatch).
- Cross-issue or cross-agent memory. Compaction stays within one task
  session. Durable knowledge is the Memory/Knowledge roadmap item, separate.
- Replacing continuation summaries. They remain the deterministic outcome
  record; compaction checkpoints cover reasoning and working context.

## Proposed Model

### Phase 1: pressure visibility (Path-1 sized, no prompt changes)

- Derive per-task-session pressure from existing rows: byte size of
  `session_params_json`, run count and error streak from `heartbeat_runs`,
  summed tokens from `usage_json`.
- Surface it where operators already look: the run/session UI and the wake
  payload metadata (numbers only, never content).
- No summarization, no rewrites, no new prompts. Pure observability that the
  later phases read.

### Phase 2: operator compact action (Path-2, this proposal's core)

- New operator action on a task session: `compactSession`.
- Execution, mirroring the harness commit protocol:
  1. Select a span: everything except a verbatim tail (propose 0.16 of
     measured context, same default as the reference).
  2. Summarize the span with an auxiliary model call using a fixed
     checkpoint schema (adopt the reference sections: intent, concepts,
     files, errors, pending, current work, next step, critical context).
  3. Commit transactionally: verify the span is unchanged since selection
     (`changed` failure otherwise), write the checkpoint, rewrite
     `session_params_json` through the adapter's own codec, record the
     attempt and outcome in `heartbeat_run_events` and the activity log.
  4. Closed failure taxonomy like the reference: busy, cancelled, changed,
     summary, commit, persistence. Any failure leaves the session runnable.
- Per-adapter rewrite seams: each adapter implements
  `rewriteSessionForCheckpoint(codecParams, checkpoint)` or opts out
  (opt-out adapters fall back to fresh-session reset with the checkpoint
  attached as context, never silently).
- Summarizer model and budget: explicit per-company configuration, default
  off; summarization spend recorded as its own cost event, never folded
  into the agent's task budget silently.

### Phase 3: automatic pressure compaction (later, needs phase 2 data)

- Threshold-triggered compaction (propose 0.8 pressure ratio default) after
  per-adapter safety is demonstrated. Operator-visible, reversible, logged.

## Open Questions for Maintainers

1. Who pays for the summarizer call: the agent's budget, a company-level
   compaction budget, or instance config? Who chooses the model?
2. Should the checkpoint schema be shared across adapters or per-adapter?
3. Where should checkpoints live: inside `session_params_json`, as issue
   documents (like continuation summaries), or a new table?
4. Does the wake prompt need a "compacted context" marker so agents trust
   but verify checkpoints (low-trust implications)?
5. Which adapter goes first for the rewrite seam pilot?
6. Should phase 1 pressure numbers feed existing budgets/watchdogs, or stay
   advisory until phase 2?

## Risks

- A bad summary loses working context mid-task. Mitigation: verbatim tail,
  transactional commit, failure taxonomy, fresh-session escape hatch.
- Twelve adapters means twelve rewrite behaviors to verify. Mitigation:
  opt-out fallback, one pilot adapter first.
- Summarization adds model spend. Mitigation: explicit config default off,
  separate cost events.

## Alternatives Considered

- Fresh-session reset only (status quo). Rejected: loses all working
  context; operators already avoid it for long tasks.
- Extending deterministic continuation summaries. Rejected: metadata
  rollups cannot preserve reasoning, file context, or pending-job nuance.
- Per-adapter native compaction (e.g. relying on each provider's own
  compaction). Rejected as the primary path: inconsistent across twelve
  adapters and invisible to Paperclip governance; acceptable as a fallback
  under the control-plane seam.
- Doing nothing. Rejected: session growth is the primary quality cliff for
  24/7 autonomous operation (MAXIMIZER MODE direction).
