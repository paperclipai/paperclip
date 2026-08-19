# PRP Compatibility and Versioning Policy

## Authority

The JSON Schema files in [`protocol/schemas/`](../protocol/schemas/) are the
language-neutral source of truth for the Replay and Local runner executable contract. The
generated TypeScript schema module is checked against those files before every
TypeScript typecheck. Rust consumes the same fixtures and must produce the same
golden parity summaries.

The broader normative protocol remains the
[native-runner spike specification](../spec/native-runner-contract.md).
Local runner reuses this contract for local live events. It adds package-local stdio
and stream envelopes, but it does not add durable transport, persistence, or
production control-plane behavior.

## Version fields

| Field | Replay support | Compatibility rule |
|---|---:|---|
| `protocolVersion` | `1` | Required. Negotiate the highest overlapping version; no overlap fails closed. |
| `fixtureVersion` | `1` | Required by the conformance corpus. Unknown values fail closed. |
| `event.schemaVersion` | `1` | Required on every event. Unknown values fail closed before reduction. |
| `capabilities.semanticTools.schemaVersion` | `1` | Optional advertisement. When present, an unknown required version fails closed. |
| `payload.semantic_tool.schemaVersion` | `1` | Optional on paired semantic tool input/result events. When present, an unknown required version fails closed. |
| `terminal.stopReason.schemaVersion` | `1` | Optional budget/cost receipt. When present, an unknown required version fails closed. |
| Typed `schema` discriminators | `*.v1` | Required. Unknown required schema identities fail JSON Schema validation. |

Wire protocol versions and fixture-corpus versions are independent. A fixture
format can evolve without changing PRP, and a future PRP version can be
represented only after the consumer advertises support for it.

## Forward compatibility

- Unknown object properties are accepted and preserved by validation. Reducers
  ignore fields they do not understand until a later schema version gives those
  fields defined behavior.
- Unknown required versions, schema discriminators, enum values, and required
  fields fail closed. A consumer must never guess at their semantics.
- Scripted fixtures bind every event to the fixture run/session, require
  contiguous controller command order, exactly one unique proposed result, and
  exactly one unique terminal event.
- The top-level fixture result must equal the `run.result.proposed` payload after
  canonical key ordering. Repeated `sourceEventId` deliveries must be
  byte-equivalent after the same normalization.

The forward-compatibility fixture proves that optional fields survive validation
without changing the v1 snapshot. The unsupported-version fixture proves that a
required v2 protocol cannot be replayed by this consumer.

## Provider-neutral semantic receipts

- `capabilities.semanticTools` advertises stable operation IDs, availability,
  required claims, and redaction disposition without naming a provider API.
- `mcp_app.tool_input` and `mcp_app.tool_result` may carry paired
  `semantic_tool` envelopes. Correlation IDs must match the containing event;
  operation ID and idempotency key must match across the pair.
- Content is represented by a canonical SHA-256 digest plus allowlisted typed
  references. Raw credentials, provider payloads, and hidden identifiers do not
  belong on the wire.
- Result receipts distinguish success, denial, conflict, exact duplicate,
  unavailable, and failure. They can name the authorization boundary, safe
  revision, artifact/work-product refs, immutable governed targets, and bounded
  wake/monitor causality.
- `terminal.stopReason` records budget/cost kind, stable code, retryability,
  limit class, safe aggregate, and decision receipt.

These fields are trace evidence only. The v1 reducer ignores `semantic_tool`
payloads, so adding or extending the optional envelope has no projection
effect. Eval `trace_completeness` treats PRP wire receipts as authoritative when
present and retains the pre-existing scalar fallback for live evidence that has
not yet emitted them.

Seven conformance fixtures cover artifact success, redacted denial without
fallback, stale conflict plus duplicate retry, governed target and continuation
causality, budget/cost stop, unknown optional fields, and rejection of an
unknown required version. The six accepted fixtures have shared TypeScript and
Rust golden parity summaries.

## Replay semantics

- Events are applied in fixture order and ordered independently by
  `(sourceKind, sourceInstanceId, sourceSeq)`.
- A repeated source event ID has no second projection effect.
- A forward source-sequence gap is recorded explicitly; the reducer never
  invents a missing event.
- An event at or behind the committed source cursor is ignored and recorded as
  out of order.
- Replaying an already-applied batch leaves the snapshot unchanged.

The CLI and browser import the same `replayReplayFixtureText` function, so
validation, compatibility errors, and final snapshots cannot drift between the
two surfaces.

## Local envelope rules

- Mock-core commands use `paperclip.prp.command.v1` over stdin JSONL.
- Runner output uses `paperclip.runner.stream.v1` over stdout JSONL.
- Fake-harness commands use `paperclip.fake_harness.command.v1`.
- Fake-harness output uses `paperclip.fake_harness.message.v1`.
- An equivalent repeated `commandId` returns a duplicate receipt and has no
  second driver effect. Reuse with different data is rejected.
- A new command must use the next contiguous `controllerSeq`.
- Harness logs are bounded diagnostic data. They are not canonical PRP events.
- `run.result.proposed`, `harness.exited`, and `run.terminal` are separate facts
  and appear in that order when a semantic result exists.
- The live browser rejects an event with an invalid schema, run ID, or session
  ID before it reaches the reducer.

These envelopes are local Local runner implementation contracts.

## Durable wire rules

- The runner opens an outbound WebSocket and sends PRP v1 `hello` before any
  command result or event.
- A one-use bootstrap bearer capability returns a short-lived connection lease
  in `welcome`. Later connections use that lease. Neither raw capability is
  durable state.
- `hello.resume` reports the last processed controller sequence, next source
  sequence, cumulative ACK cursor, and current unacknowledged range.
- `welcome` selects the one overlapping protocol version, returns the core's
  cumulative ACK cursor, and carries at most one durable pending command.
- An event is durable before send. Event IDs and source sequences stay stable
  across replay and process restart.
- An ACK is cumulative. The runner rejects a cursor behind its durable ACK or
  beyond its produced source cursor.
- An equal repeated command ID and canonical digest returns its stored result.
  Reuse with different bytes fails closed and cannot repeat an effect.
- Frames are bounded at 1 MiB and upgrade headers at 16 KiB. Unknown or invalid
  required protocol data fails closed; malformed JSON is a bounded diagnostic.

These are package-local Durable recovery rules. Production TLS, control-plane admission,
and deployment policy remain separately reviewed work.

## Change policy

1. Change JSON Schema first.
2. Regenerate the TypeScript schema module.
3. Add or revise a shared fixture and its golden snapshot/summary.
4. Prove TypeScript and Rust parity.
5. Update this policy and the normative spike specification when behavior
   changes.

Breaking changes require a new required version. Additive optional fields may
remain in v1 only when old consumers can safely ignore them.

## Package-level compatibility

PRP is one independently versioned component of the runner bundle. Catalog,
runner-client, control-plane-adapter, testkit, and eval-corpus compatibility is
declared by `PAPERCLIP_RUNNER_COMPATIBILITY` and checked before execution by
`assertPaperclipRunnerCompatibility`. A mismatch fails with
`paperclip_runner_incompatible` and stable per-issue codes; a provider-specific
tool error is not a compatibility negotiation mechanism.

See [ADR 0001](adr/0001-runner-testing-eval-package-boundaries.md) for the
component rules and clean-consumer packaging gate.

## Evals integration negotiation

The packed `./evals` entry point adds a stricter execution preflight for the
App/Evals join. `assertPaperclipRunnerEvalCompatibility` requires simultaneous
agreement on package semver, runnerd build metadata, a common PRP version,
semantic catalog version and SHA-256 digest, harness-driver contract and
required capabilities, and the native-execution version. It reports
`paperclip_runner_eval_incompatible` with expected/received values for every
mismatch and must run before launching a provider.

runnerd itself reports `paperclip-runner/runnerd-build-metadata/v1` from
`--build-metadata`. The consumer passes its path and expected content digest to
`resolvePaperclipRunnerdArtifact`; implicit PATH or source-tree discovery is
not part of the contract. Native attempt output is
`paperclip-runner/native-execution/v1`, whose parser accepts unknown additive
fields but rejects unknown required versions and inconsistent terminal,
semantic-denial, usage, or transcript facts. Full fields and the deterministic
gate are documented in [the Evals integration contract](evals-integration.md).
