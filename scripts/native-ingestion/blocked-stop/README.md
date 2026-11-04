# Frozen blocked-write Stop companion

These are exact source snapshots of the independently reviewed companion and
orchestrator. `sources.json` records every hash. Packaging itself proves no runtime
qualification, control nonregression or application performance gain. The exact
v3 helper is SHA256 `5748b6c1d271cf9ab270d5473873b85da295ffb03bb55ebc63693369c9b1a29d`;
source freeze receipt SHA256 is `210002a6699059ff9b5f74a49558c9f7f0f5866cd9ed3f786507b3ee12fc7b38`.

Use independent driver tag `native-ingestion-blocked-stop-v3`, annotated object
`a49c24dc2a690764d1cfcc080077f90485218df7`, commit
`bc33f09cae26404352848169d92a20c89480a5f5`. It inherits unchanged H5c `e431ec63`
and lock SHA256 `54a81b2ed3f1f85eaa085c034560ac248e384db34fbc7aba8c5a3846c29b3ce8`.
The delivery checkout has a different lock and must not replace that frozen driver.
Main H5d is the separate frozen `2df9897e` driver (measurement `e1d8930c…`);
this companion requires its inherited H5c measurement `2265aabe…`. The mixed
delivery checkout cannot execute either frozen protocol in place of its own driver. The [frozen protocol](../../../tests/e2e/fixtures/native-ingestion-blocked-stop.md)
defines the real row-lock, durable intent, physical Stop, transcript and noise gates.

The helper imports only six checked exports from the unchanged H5c helper,
SHA256 `6b6376b01de6cdc15ca05343a0bdd5c00424f1d6c546b9b4d61cd76716b253c4`:
qualified build/live inventory, preferred UI absence, physical quiet and raw seals.
It never invokes H5c's stage plan or release loader. Copy that exact dependency
from `../h5c/` to its recorded path before using a companion release.

## Recorded qualification and retained failures

As of 2026-11-04 09:30 UTC, ONE v3 functional qualification passed: 1,000 prelude
deltas, a 12-delta canonical Stop prefix with zero results, 1,010 ms held across
15 samples, own committed intent/ACK audits, both exact PIDs and both groups
absent, a bound latest server retirement receipt with cleared identity, released
lease, persisted reload and strict quiet. No manual signals were used. This is
not an accepted A/A or performance sample; the separate 50 fresh arms remain.
The immutable protocol document describes the prospective state at source freeze.

V1 failed before epoch on an unsupported shared-PGID assumption; API200 and port
release did not establish physical quiet, and exact owned cleanup was retained.
V2 failed an unconditional retirement-receipt assertion although retained original
identity after physical exit is supported. Its later transcript/reload/lease gate
was not reached. V3 accepts only the explicit retained or cleared identity contracts;
all independent physical, lease, audited ACK and original-birth gates remain.
Keep both failed trials, old tags/helpers and raw evidence. No failed timing data
is reused or regraded as qualification.

## Independent setup and source-only checks

The benchmark VM uses Node **v26.4.0** and pnpm **9.15.4**. Node 24 was used for
local Mac source checks; it is not the recorded VM runtime. Normally install and
build measured apps independently. Preserve actual qualified build receipts,
native inputs and all four inventoried artifact roots. No new B2 candidate or
qualified optimized build is supplied here; the old `ca7cba17` is rejected as final B2.

Run from this tools checkout on a disposable host. The driver path must be new:

```sh
TOOLS_CHECKOUT="$(git rev-parse --show-toplevel)"
DRIVER_ROOT=/home/ubuntu/native-ingestion/harness-blocked-stop-v3
HELPERS_ROOT=/home/ubuntu/native-ingestion/helpers
git -C "$TOOLS_CHECKOUT" show-ref --verify --quiet refs/tags/native-ingestion-blocked-stop-v3 ||
  git -C "$TOOLS_CHECKOUT" fetch origin tag native-ingestion-blocked-stop-v3
test "$(git -C "$TOOLS_CHECKOUT" rev-parse 'native-ingestion-blocked-stop-v3^{commit}')" = bc33f09cae26404352848169d92a20c89480a5f5
git -C "$TOOLS_CHECKOUT" worktree add --detach "$DRIVER_ROOT" native-ingestion-blocked-stop-v3
pnpm --dir "$DRIVER_ROOT" install --frozen-lockfile --offline --ignore-scripts
mkdir -p "$HELPERS_ROOT"
cp "$TOOLS_CHECKOUT/scripts/native-ingestion/h5c/native-ingestion-run-h5c-browser.mjs" "$HELPERS_ROOT/native-ingestion-run-h5c-browser.mjs"
cp "$TOOLS_CHECKOUT/scripts/native-ingestion/blocked-stop/native-ingestion-run-blocked-stop-v3.mjs" "$HELPERS_ROOT/native-ingestion-run-blocked-stop-v3.mjs"
node "$HELPERS_ROOT/native-ingestion-run-blocked-stop-v3.mjs"
node "$DRIVER_ROOT/tests/e2e/fixtures/native-ingestion-blocked-stop-validate.mjs" --registration
```

The last two commands are dry runs and start no app or arm. Verify both copied
helpers against `sources.json`. The release's `h5HelperFile` is the exact recorded
`/home/ubuntu/native-ingestion/helpers/native-ingestion-run-h5c-browser.mjs` path.
Keep the frozen driver install independent from every app's normal locked build.

Capture actual runtime versions and executable locations before preparing a
release: `node --version`, `node -p process.execPath`, `pnpm --version`,
`rustc --version`, `cargo --version`, and the actual PostgreSQL and Chromium
executables with `--version`. Use exact absolute executable, argument and output
values in `runtimeChecks`; do not guess provider/browser/database versions. Before
each arm, the helper additionally resolves bare PATH `node` under the exact app
cwd and launch environment and verifies its canonical executable and version.

## Explicit release and evidence gates

The dry run prints all required release fields. A release binds authorization,
stage/output, helper hash, exact driver revision and nine hashes, inherited H5c
hash/lock, workload and precision rules, actual runtime checks, qualified app
builds and earlier report/noise file hashes. Source validation is separate from
runtime qualification:

```sh
node "$HELPERS_ROOT/native-ingestion-run-blocked-stop-v3.mjs" \
  --release="$RELEASE_JSON" --release-sha256="$RELEASE_SHA256" \
  --stage=qualification-b0 --output-root="$EVIDENCE_ROOT" --validate-release
```

After the concrete release and quiet window are reviewed, replace
`--validate-release` with `--execute`. First run only `qualification-b0`: one
actual journey, owning Playwright pass, exact attached raw bytes, full functional
oracle, actual build/UI/native inventory, independent cleanup and sealed proof.
Inspect that evidence before separately releasing any calibration.

Then release `b0-aa`, `b1-aa`, `b0-b1`, `b1-b2`, `b0-b2` in order. Each has five
fresh alternating pairs, for 50 timing arms. Qualification is never reused as a
timing arm. Freeze both suitable A/A noise JSON files and their actual hashes
before further product optimization or comparisons. Unsuitable calibration
retains every raw arm and writes its noise artifact before stopping. No deadline
or precision budget is enlarged after observation. Each owning test keeps its
900-second limit; the 30-minute watchdog only bounds resources.

A passed arm requires immutable source, compiled/native/UI checks, one unretried
recording-off test, functional lock/intent/audit/process/lease/transcript proof,
exact raw/owner/build seals and physical cleanup. The helper revalidates prior
proofs and compares only against that companion's frozen noise. Preserve failed
or censored runs and stop the stage; it never kills unrelated observed processes.
This deterministic local-provider companion does not establish live Cloud Stop
acceptance or replace the main application's performance measurements.
