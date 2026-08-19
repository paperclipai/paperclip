# ADR 0001: Runner, Testing, and Eval Package Boundaries

- Status: Accepted
- Date: 2026-08-11
- Decision owners: Paperclip App and Paperclip Evals

## Context

The runner package previously exported production contracts, deterministic
mocks, conformance fixtures, scenario/eval helpers, and demo servers from one
root. A workspace checkout hid two packaging defects: consumers could use
undeclared deep surfaces, and the public semantic dispatcher loaded `ajv` even
though `ajv` was only a development dependency.

Paperclip Evals must consume App contracts and test helpers without making the
App runtime depend on the Evals repository. Paperclip App may use generic eval
orchestration in CI, but scenario content and provider experiments are not
product runtime dependencies.

## Decision

Ownership is:

| Owner | Stable responsibility |
|---|---|
| Paperclip App | PRP schemas and fixtures, canonical semantic catalog and dispatcher, runnerd/client interfaces, `ControlPlanePort`, the production binding, deterministic mock, and mock/real parity fixtures |
| Paperclip Evals | Scenario corpus, candidate matrices, provider configuration, scorers, experiment reports, and eval orchestration |

The production binding remains App code at
`server/src/services/native-runtime/paperclip-control-plane-port.ts`. It
implements the App-owned `ControlPlanePort`; the runner package never imports
the server, database, UI, or CLI.

Public runner exports are:

| Export | Stability and purpose |
|---|---|
| `@paperclipai/paperclip-runner` | Runtime contracts, runner clients/backends, PRP validation/replay, canonical catalog/dispatcher, and compatibility preflight |
| `@paperclipai/paperclip-runner/evals` | Versioned native-attempt/build metadata, explicit runnerd artifact resolver, and complete App/Evals compatibility negotiation |
| `@paperclipai/paperclip-runner/testing` | Deterministic mocks, PRP port conformance, and provider-neutral semantic conformance kit |
| `./browser`, `./react`, `./standalone`, `./styles.css` | Existing explicitly named UI/standalone consumers |

Mock adapters and conformance constants are no longer package-root exports.
Tests and Evals must use `./testing`. Scenario content, matrices, reports, and
provider configuration are not public App package exports.

The testkit remains an App `./testing` subpath rather than a separate package.
It shares the runner protocol/catalog release cadence, and no independent
consumer or version cadence currently justifies another package. Split it only
after an independent release requirement exists; a directory preference is not
sufficient.

The generic matrix engine is a separate
`@paperclipai/paperclip-eval-kernel` package. It contains only structural matrix
orchestration and callbacks: no scenario, provider, product fixture, scorer, or
report content. It has no dependency on the runner package. Paperclip App may
install it only as a development dependency; the runner's dependency,
optional-dependency, and peer-dependency sets must remain free of Evals
packages.

The dependency graph is acyclic:

```text
Paperclip App production binding
            |
            v
@paperclipai/paperclip-runner (runtime contracts)
            ^
            |
Paperclip Evals ----> @paperclipai/paperclip-runner/testing
      |
      +-------------> @paperclipai/paperclip-eval-kernel

Paperclip App tests/CI --dev-only--> @paperclipai/paperclip-eval-kernel
```

No arrow points from App runtime to Paperclip Evals.

## Compatibility and versioning

Package semver describes distribution compatibility. Independently versioned
contracts are published in `PAPERCLIP_RUNNER_COMPATIBILITY`:

| Component | Current contract | Compatibility rule |
|---|---:|---|
| Canonical catalog | 1 | Operation removals, renames, placement changes, or incompatible schemas require a new contract version |
| PRP | 1 | Highest overlapping required protocol version; no overlap fails closed |
| Runner client | 1 | Breaking runnerd/client interface changes require a new version |
| runnerd artifact | 1 | Binary metadata/package disagreement or digest mismatch fails before launch |
| Harness driver | 1 | Breaking descriptor/config/session/conformance behavior requires a new version |
| Native execution | 1 | Breaking App attempt-bundle semantics require a new schema version and converter |
| Evals integration | 1 | Breaking package/binary/catalog/driver join behavior requires a new version |
| Control-plane adapter | 1 | Breaking `ControlPlanePort` or production-binding expectations require a new version |
| Testkit | 1 | Breaking mock seed, vector, observation, or conformance behavior requires a new version |
| Eval corpus | 1 | Runner declares a supported inclusive corpus-version range; out-of-range bundles fail before execution |
| Eval kernel API | 1 | Versioned by `PAPERCLIP_EVAL_KERNEL_COMPATIBILITY`, independently of scenario content |

`assertPaperclipRunnerCompatibility` performs a fail-closed preflight. It emits
`paperclip_runner_incompatible` with stable issue codes for component mismatch,
unsupported corpus versions, unknown catalog operations, missing provider
capability declarations, and provider-operation gaps. Provider-specific runtime
errors must not stand in for this preflight.

## Clean-consumer proof

Run:

```sh
pnpm --filter @paperclipai/paperclip-runner check:package-boundaries
pnpm --filter @paperclipai/paperclip-runner check:clean-consumers
```

The second command builds and packs both packages, then installs tarballs into
two newly created consumers:

1. An Evals-side consumer imports only declared runner root, `./evals`, and
   `./testing` exports; validates the native bundle; executes deterministic PRP
   and harness-driver conformance; resolves a separately copied runnerd by
   explicit path/digest; and proves provider/driver mismatches fail explicitly.
2. An App-side consumer installs the eval kernel as a development dependency,
   runs a generic matrix after runner compatibility preflight, and proves the
   runner manifest has no Evals runtime dependency.

Neither consumer uses a workspace protocol, source-relative import, or deep
package path. This is the packaging gate; workspace tests alone are not proof.

## Consequences

- Existing tests importing mock/conformance values from the package root must
  migrate to `@paperclipai/paperclip-runner/testing`.
- `ajv` is a runtime dependency because the public dispatcher imports it.
- The semantic conformance kit defines normalized comparison; real App service
  adapters and risk-weighted vectors may evolve behind its testkit version.
- Scenario corpus changes do not force an App runtime release unless their
  declared compatibility requirement changes.
