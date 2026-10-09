# Paperclip Evals Integration Contract

## Stable consumer inputs

Paperclip Evals consumes two explicit App artifacts:

1. a packed/released `@paperclipai/paperclip-runner` package; and
2. an explicit `paperclip-runnerd` executable path plus its
   `sha256:<lowercase hex>` digest.

The consumer must not import App source paths, search a workspace for a binary,
or infer compatibility from a process failure. The package exposes three
relevant entry points:

- package root: PRP, runner, semantic-tool, and control-plane runtime contracts;
- `./evals`: build metadata, native-attempt schema/fixture, compatibility
  negotiation, semantic receipts/catalog, and explicit runnerd resolution;
- `./testing`: deterministic driver/control-plane fakes and conformance kits.

`resolvePaperclipRunnerdArtifact` resolves only the supplied path, verifies its
bytes against the supplied digest, and invokes that exact executable with
`--build-metadata`. It never searches `PATH` or the App repository.

## Versioned join

`assertPaperclipRunnerEvalCompatibility` checks the complete join before any
provider process starts:

| Dimension | V1 rule |
| --- | --- |
| Package | Exact package version matches loaded build metadata. |
| Binary | runnerd package version and binary-artifact contract match the package. |
| PRP | Package, runnerd, and consumer version ranges have a common version. |
| Semantic catalog | Contract version and canonical content digest both match. |
| Harness driver | Contract and negotiated PRP versions match and every required capability is explicitly true. |
| Native output | Consumer and runnerd both select `paperclip-runner/native-execution/v1`. |

Failures use `paperclip_runner_eval_incompatible` and include all detected
component issues with expected and received values. A catalog, driver, or PRP
mismatch cannot degrade into an attempted run.

## Native attempt bundle

`paperclip-runner/native-execution/v1` is the App-owned raw attempt. Its checked
schema is `protocol/schemas/native-execution.schema.json`; the no-spend seeded
fixture is `protocol/fixtures/evals/native-execution-seeded.json`.

The bundle pins run/case/config/attempt identity, case and config digests,
package/binary/catalog/driver versions and digests, ordered PRP events, semantic
tool definitions/calls/results/denials, terminal state, check-ready
observations, usage/cost/time/request totals, transcript completeness, and
content-addressed artifacts. Unknown additive fields survive parsing.

The parser fails closed on an unknown native schema, malformed digest, event
run mismatch, missing or conflicting terminal, semantic indexes that omit or
reinterpret their PRP tool envelopes, denied results without matching denial
receipts, inconsistent token totals, or ambiguous incomplete transcripts.
Unknown additive fields are retained at nested contract objects as well as the
bundle root. The seeded fixture deliberately preserves a rejected governed
tool effect as `denied`; it never turns that effect into a successful mutation.

Evals owns conversion of this bundle into Evalbook ledger, scores, and reports.
The App package does not implement an Evalbook environment loader, importer,
grid, comparison, or report renderer.

## Deterministic conformance

`runHarnessDriverConformance` with `DeterministicHarnessDriver` covers, without
network or provider credentials:

- capability and unsupported-feature description;
- valid/invalid config handling;
- session open, turn, snapshot, recovery, close, and cancel lifecycle;
- paired provider-neutral semantic tool events;
- PRP event validation;
- interrupt and cancelled terminal behavior;
- usage reporting; and
- complete transcript accounting.

The input fixture is
`protocol/fixtures/evals/harness-driver-conformance.json`. The packed
clean-consumer gate builds runnerd with Cargo's `release` profile, copies it
into an isolated artifact directory, packs the package, installs it offline,
resolves only declared exports, validates the native fixture, runs driver
conformance, verifies binary metadata/digest, and exercises both compatible
and incompatible negotiation. It never qualifies a debug binary.

Run it with:

```sh
pnpm --filter @paperclipai/paperclip-runner check:clean-consumers
```

Set `PAPERCLIP_CLEAN_CONSUMER_OUTPUT_DIR` to retain the qualifying inputs and
machine-readable proof outside the temporary consumer. The output contains the
package tarball, platform-named release runnerd, `SHA256SUMS`, and
`paperclip-runner-consumer-conformance.json`. That record is produced by the clean
consumer after it imports only the packed package, resolves the explicit binary
and digest, and completes deterministic conformance without provider calls.

```sh
PAPERCLIP_CLEAN_CONSUMER_OUTPUT_DIR=/absolute/release/directory \
  pnpm --filter @paperclipai/paperclip-runner check:clean-consumers
```
