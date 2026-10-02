# JEV shadow issue-lane isolated test report

Date: 2026-10-02

## Result

The optional observer satisfies the shadow boundary under isolated tests. It is
disabled by default, automatic assignment remains off, and no live TypeSafe API
request was made. A live accuracy or provider-latency claim would be premature
until the operator installs the server credential and separately confirms the
reviewed trial corpus.

## Current vs proposed routing

| Stage | Current route | Shadow-enabled route |
| --- | --- | --- |
| Admission | Paperclip pause, budget, dependency, ownership, and stale-run gates | Unchanged |
| Claim | Paperclip selects the assigned agent and claims the run | Unchanged |
| Dispatch | Paperclip invokes the selected adapter | Unchanged |
| Observation | None | Fire-and-forget JEV suggestion after claim; local run-log receipt only |
| Ambiguity | Existing Paperclip/XO route | Existing route remains authoritative; JEV may return `needs_review` only |
| Mutations | Existing control-plane code | No JEV issue, assignment, status, priority, dependency, approval, or wake mutation |

The hook does not await the SDK promise. Provider timeout, retry, invalid
response, missing key, or receipt-write failure therefore cannot hold or change
dispatch.

## Corpus and correctness

The registry contains five synthetic, code-reviewed summaries. No raw issue
field is a fallback.

| Case | Expected lane | Isolated result |
| --- | --- | --- |
| Engineering | `engineering` | pass |
| Provider | `provider` | pass |
| Studio | `studio` | pass |
| Ambiguous | `needs_review` | pass |
| No match | `no_match` | pass |

- Contract-fixture accuracy: **5/5 (100%)**.
- False routes: **0/5** in the SDK-mock contract corpus.
- Live model accuracy: **not measured**; live calls are explicitly gated on
  credential installation and corpus confirmation.
- XO/local comparison: JEV has no selection authority, so the comparison result
  is non-displacement by construction. Ambiguous/low-confidence output is
  `needs_review`; the existing route still runs.

These are integration-contract results, not a claim that the live model will
achieve 100% accuracy.

## Safety and failure cases

Focused tests prove:

- blocked, dependency-blocked, duplicate, and unapproved work makes zero SDK calls;
- two concurrent observations for one run make exactly one SDK call;
- low confidence maps to `needs_review`;
- timeout fails open with only the bounded `timeout` category;
- malformed probabilities, confidence, usage, or returned model fail open as
  `invalid_response`;
- invalid provider-controlled model text is not copied into the receipt;
- only suggested lane, finite probabilities, pinned/returned validated model,
  elapsed time, token counts, and bounded error category reach the run log;
- raw summaries, issue identifiers, request/response bodies, provider errors,
  and key values are absent from receipts.

## Timing

Local Node 24 synthetic measurements, 5,000 iterations each:

| Measurement | p50 | p95 | Maximum |
| --- | ---: | ---: | ---: |
| Feature-disabled hook | 0.000292 ms | 0.001042 ms | 0.691176 ms |
| Enabled fire-and-forget scheduling with pending mock | 0.002292 ms | 0.003334 ms | 2.053317 ms |
| Adapter end-to-end with resolved SDK mock | 0.002459 ms | 0.005209 ms | 0.715014 ms |

These measure local integration overhead, not network/provider latency. The SDK
timeout is 1.5 seconds per attempt with at most one retry; neither attempt is on
the awaited dispatch path. Live p50/p95 remains unmeasured.

## API failures and cost

- Live calls: **0**.
- Live API failures: **0 observed**; timeout and malformed response paths were
  exercised with mocks.
- Actual provider cost for this test: **$0**.
- The mock reports 25 input and 5 output tokens per successful request solely to
  verify receipt accounting; those are fixtures, not a billing estimate.

## Independent review and follow-up

Claude Code completed an independent integration and data-boundary review. The
review found no material security or authority-boundary defects.

A later PR review found that the new run-log event initially flowed through the
generic runtime-progress projection. That could replace the visible adapter
activity message with the JEV receipt message. The event now returns no runtime
progress projection, while it remains persisted in the local run log. A focused
regression test proves this behavior.

## Verification commands

```text
pnpm exec vitest run server/src/services/jev-decision-adapter.test.ts server/src/__tests__/heartbeat-auto-checkout.test.ts
  PASS: 19 tests

pnpm exec vitest run server/src/__tests__/heartbeat-run-status-payload.test.ts
  PASS: 12 tests

node server/node_modules/typescript/bin/tsc --noEmit -p server/tsconfig.json
  PASS

pnpm --filter @paperclipai/server typecheck
  BLOCKED before server TypeScript: cargo is not installed while the required
  paperclip-runner prepare step builds the Rust binary.
```

The direct server TypeScript compile passed after the scripted typecheck hit the
environmental Rust-toolchain blocker.
