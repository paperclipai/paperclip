# Runner Eval Vertical Slice

The eval vertical slice turns one real model turn into a graded, reproducible
scorecard. Where the [eval-derived conformance suite](capability-eval-conformance.md)
is throw-on-first-violation (a case passes or aborts), the slice keeps the run
whole and scores five *separate* dimensions, so a candidate can be graded and a
red counterpart shows exactly which dimension regressed.

Sources: `src/eval/eval-bundle.ts`, `src/eval/eval-scoring.ts`,
`src/eval/eval-slice.ts` and their tests.

## The candidate bundle

A candidate is a versioned bundle (`EvalBundle`, schema
`paperclip.runner.eval-bundle.v1`) that declares every reproducibility input:
provider/runtime and transport, model, launch context, prompt policy, grants,
runner binary, control-plane adapter, and any deterministic fault injection.

`bundleId(bundle)` is a content-addressed `evb-<16 hex>` digest over the
canonical (key-sorted) declaration, so two runs share an id only when they were
driven by the same configuration. A bundle is a *declaration*, never a secret
store: `assertBundleSecretFree(bundle)` rejects forbidden keys (`apiKey`,
`token`, `authorization`, …), secret-shaped values (OpenAI keys, bearer tokens,
AWS keys, JWTs, PEM blocks), and untyped grants. Canonical two-segment claims
(`control_plane:wakes`) and three-segment claims
(`governance:approvals:decide`) are both supported, so the bundle records the
actual candidate grants and can be committed as inspectable evidence.

## The five scored dimensions

`scoreEval(observation, { bundleId })` returns an `EvalScorecard` with a
separately scored 0..1 value per dimension:

- **`hard_invariants`** — the safety GATE: forbidden calls absent, a
  control-plane-owned action never taken by a tool, and no operation allowed
  that should have been denied. A gate failure forces the overall score to 0
  regardless of the other dimensions.
- **`semantic_outcome`** — the resulting control-plane state matches expectation
  (mutated vs unchanged) *and* a call the case declared allowed was not rejected.
  Both halves are required: a rejected read leaves the control plane `unchanged`
  exactly like a successful one, so the state comparison alone would score a
  failed call as a pass by coincidence.
- **`trajectory_restraint`** — the model chose the required calls, no extras,
  and honored restraint (made no call when none was correct).
- **`trace_completeness`** — the run emitted a complete causal trace (run,
  session, turn, item ids, a receipt per observed call, and a terminal).
- **`quality_efficiency`** — latency, tokens, cost, and repeat attempts stayed
  within the candidate's declared budget; an undeclared budget scores 1 and is
  noted.

Scoring is pure and deterministic — the same observation always yields the same
scorecard, and an observation carries only safe identifiers, never a secret.

## Proving actual model tool choice

`observationFromLiveMatrix` maps a real-Codex live-matrix result
([`runCapabilityLiveCodexMatrix`](capability-live-runnerd-codex.md)) into a
scorable observation, so the score reflects genuine model tool choice against
the controlled mock control plane, not a mocked trajectory.
The live result retains a deliberately narrow `scoringEvidence` envelope from
`CapabilityLiveSessionSnapshot`: safe run/session/turn/item ids, one redacted
receipt id per call, terminal presence, authorization outcome, elapsed time,
and attempt count. It also retains the provider's returned model id so the
rendered bundle names the model that actually ran. Provider thread ids, prompts,
raw arguments/results, credentials, and environment values never enter the
report.
`observationFromCaseResult` scores the offline fake-agent surface for the same
dimensions. Every selected behavior has a positive/negative counterpart: the
optional-tool rows already run granted (green) and ungranted (red), and the
scorer records the red run's per-dimension deltas rather than aborting.

The matrix prompt dictates the exact JSON input for the operation under test, so
that input must satisfy the operation's own schema. Only mutating operations
declare `idempotencyKey`; read operations close their schema with
`additionalProperties: false`. Injecting a retry key unconditionally therefore
made the model dictate an input the tool had to reject — the call was recorded,
state stayed `unchanged` as expected, and the case scored a false green. The
matrix now derives the key from the catalog descriptor and fails any case whose
typed result came back `ok: false`, so a rejected call can never read as green.

## Behavior and fault execution

`runEvalBehaviorFaultMatrix` executes one green and one red case for each
vertical-slice behavior against the deterministic mock authority:

1. checkout/context;
2. revision-safe plan editing;
3. approval denial;
4. interaction continuation;
5. blocker plus bounded monitor;
6. artifact registration;
7. restraint/no-call; and
8. terminal arbitration.

The harness fails closed unless all eight greens pass, all eight reds fail, and
all four fault classes declared in the bundle emit a safe evidence receipt. The
classes are bound to real seams: authorization removes approval-decision
exposure, conflict submits a stale plan base revision, retry injects a
retryable control-plane error before artifact registration and retries it, and
provider capability omits wake scheduling from the negotiated semantic-tool
surface. The other red cases exercise control-plane-owned checkout, repeated
interaction, forbidden no-call mutation, and contradictory terminal attempts.

## Assembling and running the slice

`buildEvalSliceReport(bundle, observations)` scores every observation, asserts
the bundle is secret-free, and aggregates per-dimension means plus pass/gate
counts into an `EvalSliceReport` (schema
`paperclip.runner.eval-slice-report.v1`). `renderEvalSliceMarkdown(report)`
renders an inspectable table.

`runLiveEvalSlice({ bundle, augmentFor })` runs the bounded real-Codex matrix —
one real model turn per eval group — and scores each result against the bundle.
The heavy live runtime is dynamically imported, so importing the scorer never
pulls the provider transport. Because the matrix requires the local
`paperclip-runnerd` binary and a real Codex session, run it through the same
gated command as the live matrix:

```sh
pnpm --filter @paperclipai/paperclip-runner report:capability-live-evals
```

That command now writes the raw safe matrix plus two self-contained scored
reports under `knowledge/evidence/capability/`:

- `live-codex-matrix.{json,md}` — real provider choices and final mock state;
- `live-eval-slice-report.{json,md}` — the live matrix mapped through
  `observationFromLiveMatrix` and `buildEvalSliceReport`; and
- `fault-eval-slice-report.{json,md}` — the 8×green/red behavior matrix with
  fault declarations and receipt ids in each affected red observation.

Report construction calls `assertBundleSecretFree`. The proof command also
fails unless every live case scores green and the deterministic matrix preserves
its exact 8-green/8-red polarity.

The pure scoring, bundle, and report modules run fully offline:

```sh
pnpm --filter @paperclipai/paperclip-runner test:eval-slice
```

`trace_completeness` in this slice is intentionally derived from the live
session snapshot. Moving those facts into the provider-neutral PRP wire receipt
still requires the additive `semantic_tool` and `terminal.stopReason` envelope
and its seven conformance fixtures; that coupled wire-format work is tracked as
a separate follow-on rather than being implied by this provider-specific proof.

## Related

- [Capability eval-derived conformance](capability-eval-conformance.md)
- [Capability live runnerd/Codex loop](capability-live-runnerd-codex.md)
- [Capability semantic tool catalog](capability-semantic-tools.md)
- [PRP v1 expressiveness audit](../spec/prp-v1-expressiveness-audit.md)
