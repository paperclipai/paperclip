# PRP v1 expressiveness audit

## Verdict

PRP v1 is sufficient for runner lifecycle, replay integrity, negotiated runner
features, runtime/issue-thread request routing, structured work disposition,
terminal causality, and provider-neutral semantic-control-plane receipts. The
optional `semantic_tool` and `terminal.stopReason` envelopes now type tool
invocation, authorization denial, redaction, optimistic concurrency, mutation
receipts, artifacts, governed targets, causal continuations, and budget stops.
They remain receipts for control-plane-owned operations, not a provider tool
catalog or permission to move control-plane policy into the runner.

`prp-v1-expressiveness-crosswalk.json` is the machine-checked source for this
verdict. Its Vitest gate rejects an unclassified required fact, a fact justified
only by a permissive field, an unbounded control-plane-local fact, or an
accepted additive change without required fixtures.

## Evidence boundary

This audit compares the canonical capability authority and its traceability
inputs, the real-surface ledger, the deterministic mock, live Codex/runnerd
transport, and PRP schemas/replay fixtures. The wire contract is not the tool
catalog: capability placement controls exposure, while PRP carries execution
and causality. `generic_api_request` remains test-only and cannot satisfy any
coverage row.

## What v1 proves directly

- `capabilities.schema.json` negotiates driver identity, session reuse,
  steering, interruption, resume, runtime requests, structured results, typed
  events, and explicit unsupported features.
- Events have stable source instance/event ids, source ordering, run/session/
  turn/item correlation, priority, and an explicit v1 schema version. Replay
  rejects unsupported required event versions, requires byte-equivalent
  duplicate source events, records source gaps, and is side-effect free.
- Commands have controller ordering and preconditions; runtime and issue-thread
  requests have typed kinds/statuses; results require completion claims,
  verification, artifacts, and blocker/yield continuations where applicable.
- `run.terminal` is a typed terminal envelope with terminal state, work
  assessment, and issue-status decision references. Existing golden replay,
  duplicate-event, unknown-optional-fields, and unsupported-required-version
  fixtures demonstrate the compatibility boundary.
- `capabilities.semanticTools` advertises versioned, provider-neutral operation
  availability and redaction rules. Paired `mcp_app.tool_input` and
  `mcp_app.tool_result` events carry one safe `semantic_tool` envelope per call.
- `terminal.stopReason` carries a safe budget/cost aggregate and the decision
  receipt that stopped the run. Eval `trace_completeness` reads these PRP wire
  receipts when available while retaining the existing live-evidence fallback.

## Landed additive v1 envelope

The correction is one optional, versioned `semantic_tool` envelope for
`mcp_app.tool_input` / `mcp_app.tool_result`, plus an optional
`terminal.stopReason` envelope. It defines:

- operation id, call id, correlation ids, idempotency key, outcome, stable
  code, retryability, and audit/operation receipt id;
- admitted input/output references or digests, redaction disposition, and only
  safe identifiers; never raw credentials, hidden-company identifiers, or
  secret payloads;
- authorization boundary (`company`, `actor`, `active_task`, `grant`,
  `governed_action`, `lock`, or `revision`), current revision where safe, and
  a deterministic conflict/duplicate result;
- artifact/work-product references linked to the semantic receipt and terminal
  result; immutable interaction/approval document or decision targets; and
  budget stop reason/aggregate/decision id.

This remains additive because existing v1 consumers can ignore the optional
typed envelopes. The reducer intentionally does not project them into session
state; they supply inspectable trace evidence only. Unknown optional fields are
accepted, while an unknown required envelope version fails closed.

## Classification and fixture plan

The crosswalk assigns every required fact to exactly one of: direct v1,
compositional v1 with a listed invariant, control-plane-local, additive v1,
missing fixture/docs, or breaking v2 work. Direct and compositional support is
never inferred merely from `additionalProperties: true`.

The additive change graduated to direct support with these fixtures and golden
projections:

1. `semantic-tool-artifact-happy-path.json` — artifact and work-product receipt;
2. `semantic-tool-denial-redaction.json` — denied/redacted with no fallback;
3. `semantic-tool-conflict-duplicate-retry.json` — stale conflict and exact retry;
4. `semantic-tool-governance-wake-monitor.json` — immutable governed targets and continuation chain;
5. `budget-cost-stop-reason.json` — typed terminal budget/cost stop;
6. `semantic-tool-unknown-optional-envelope.json` — optional fields accepted with unchanged projection;
7. `semantic-tool-unsupported-required-version.json` — required v2 envelope rejected fail-closed.

The six accepted fixtures replay to TypeScript/Rust parity summaries and golden
snapshots. Shared high-risk semantic vectors compare normalized receipt and
state-diff observations across deterministic mock and production bindings.

## Explicit exclusions

Checkout/release, task selection, wake routing, budget enforcement, audit and
run persistence/replay, assignment, and monitor management are control-plane
actions, not runner-wire semantic operations. Cross-company discovery, broad
audit access, destructive document lifecycle, and company administration are
breaking v2/product-governance work. The runner must report typed unavailable
or denied outcomes rather than tunnel those operations through generic payloads.

## Review checklist

- Golden replay, duplicate/retry, and unknown-version fixtures accompany every
  accepted protocol schema/event addition.
- A semantic receipt is typed and safe before any surface is marked supported.
- Control-plane-local decisions stay out of the semantic tool wire.
- Eval trace scoring consumes wire receipts without changing projection semantics.
