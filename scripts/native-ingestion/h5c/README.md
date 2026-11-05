# Frozen H5c application helpers

This package preserves the exact four reviewed helpers listed in `sources.json`.
No embedded path or code was changed for packaging. The owning run receipt
identifies the bytes actually executed; copying source into a delivery commit
establishes no application or performance result.

The driver is the independent tag `native-ingestion-h5c`, annotated tag object
`0ff37cd81dd922ce9def66fa656549e8e68d6a50`, commit
`e431ec63d41fe90c6fd68bd2fc2bb969feeca917`. Its lock SHA256 is
`54a81b2ed3f1f85eaa085c034560ac248e384db34fbc7aba8c5a3846c29b3ce8`.
The delivery checkout has a different lock. Reproduce with that immutable driver,
including later H4e confirmation, even though its seven changed source files are
also included in this PR. The [frozen protocol](../../../tests/e2e/fixtures/native-ingestion-h5.md)
contains the workload, settlement rules and pass/fail gates.

## Why H5c exists

The historical H5b FULL B0 attempt failed qualification. It retained 51,200
lossless durable deltas and 100 accepted results across 100 independent agents,
but its terminal snapshot showed 83 succeeded runs and 17 retryable failures.
Those 17 lacked timely provider drain receipts. The observer stopped the app
before their first supported retry, scheduled 30 seconds later. Existing-history
and Stop were not reached. That failed attempt remains retained; neither later
recovery nor a root cause for the late receipts was established.

H5c keeps failed native `retryable_failure` runs pending inside the same original
180-second terminal window. It uses normal run-detail reads, records bounded
state transitions, and reads the exact run set once after timing to retain current
and recovered error classes. Recovery is performed only by the normal app. Final
success, durable results, exact deltas and lease cleanup remain mandatory. Fresh
A/A freezes the observed retry-rate envelope; candidate comparisons reject new
recorded error classes and rate increases outside that envelope. Retained
recovery metadata records the last failure, not an exhaustive failure history.

The original 120-second streaming, 180-second terminal and 900-second invocation
limits remain unchanged. H5c can observe a known streaming miss for up to 600
seconds and an invocation for 1200 seconds, while keeping that original miss a
failure. Final B2 must pass every original SLA in every arm and later pass one
H4e default-mode full invocation on the same source, geometry and qualified build.
The 30-minute process watchdog bounds resources; it grants no performance pass.

## Reproduction layout and preparation

Use one quiet disposable Linux host with the recorded Node/pnpm, PostgreSQL,
Chromium and Runner inputs. Normally install and build each exact app revision
independently. Retain its build receipt and inventories for `server/dist`,
`ui/dist`, `packages/db/src` and `packages/shared/src`. Keep the driver install,
application dependencies and compiled output separate. Native target reuse is
allowed only when all 15 native inputs match exactly; the historical three app
builds reused a target with Rust tree `bbe29bba574ce8d5cfddf2f7461ae0eb5983df07`.

The recorded app directories and full revisions appear in `sources.json`: B0
`bac53ec3`, B1 `07061a60`, B2 `ca7cba17`. Qualified build receipt SHA256 is
`a1259ba760f3cbbe44817e333f9f620bcf3769fb0a6c16f9ce2f0f5b2ed60d94`.
Those bytes describe the recorded builds; a source checkout alone is no compiled
attestation. The old B2 is the unoptimized batching base. A final Rust candidate
requires a new immutable source, normal build and qualified inventory. The
orchestrator rejects the old B2 as a final candidate.

Keep the recorded layout under `/home/ubuntu/native-ingestion`: app trees in
`aligned-baseline`, `aligned-cursors`, `aligned-batching`; driver in `harness-h5c`;
build receipts and inventory summaries at their recorded locations; helpers in
`helpers` under their original basenames. Verify every copied helper against
`sources.json`. Path-portable derivatives need separate hashes and provenance.
Run this setup from the tools checkout; the driver path must not exist yet.

```sh
TOOLS_CHECKOUT="$(git rev-parse --show-toplevel)"
DRIVER_ROOT=/home/ubuntu/native-ingestion/harness-h5c
HELPERS_ROOT=/home/ubuntu/native-ingestion/helpers
git -C "$TOOLS_CHECKOUT" show-ref --verify --quiet refs/tags/native-ingestion-h5c ||
  git -C "$TOOLS_CHECKOUT" fetch origin tag native-ingestion-h5c
test "$(git -C "$TOOLS_CHECKOUT" rev-parse 'native-ingestion-h5c^{commit}')" = e431ec63d41fe90c6fd68bd2fc2bb969feeca917
git -C "$TOOLS_CHECKOUT" worktree add --detach "$DRIVER_ROOT" native-ingestion-h5c
pnpm --dir "$DRIVER_ROOT" install --frozen-lockfile --offline --ignore-scripts
mkdir -p "$HELPERS_ROOT"
for helper in native-ingestion-run-h5c-browser.mjs native-ingestion-linux-h5c-qualification.py native-ingestion-h5c-linux-readiness.mjs native-ingestion-validate-h5c-evidence.mjs; do
  cp "$TOOLS_CHECKOUT/scripts/native-ingestion/h5c/$helper" "$HELPERS_ROOT/$helper"
done
node "$DRIVER_ROOT/scripts/describe-native-ingestion-h5.mjs"
node "$HELPERS_ROOT/native-ingestion-run-h5c-browser.mjs"
```

The last two commands are dry runs. They launch no app or performance arm. The
readiness helper checks actual B0/B1 file inventories, native target, PATH,
preferred-UI-shadow absence and physical quiet. Its output directory
`evidence/h5c/setup` must exist and its receipt files must be new. An output-path
change for another readiness check must have its own retained helper hash.

## Qualification and comparisons

Run one released operation at a time, with no competing builds, tests, profiles
or benchmarks. Preserve every failed or censored attempt. After actual build and
quiet checks, qualify SMALL first with a new output name:

```sh
python3 "$HELPERS_ROOT/native-ingestion-linux-h5c-qualification.py" --tree=B0 --name=NEW-SMALL
node "$HELPERS_ROOT/native-ingestion-validate-h5c-evidence.mjs" /home/ubuntu/native-ingestion/evidence/h5c/qualification/NEW-SMALL "$DRIVER_ROOT"
```

Inspect its actual raw evidence and cleanup before separately releasing FULL:

```sh
python3 "$HELPERS_ROOT/native-ingestion-linux-h5c-qualification.py" --tree=B0 --full --name=NEW-FULL
node "$HELPERS_ROOT/native-ingestion-validate-h5c-evidence.mjs" /home/ubuntu/native-ingestion/evidence/h5c/qualification/NEW-FULL "$DRIVER_ROOT"
```

The post-run validator binds exact driver helpers, SUT revision, FULL/SMALL case
matrix, the owning Playwright attempt and its attached evidence, settlement,
recorded errors and external cleanup. It creates a new qualification-only
summary. It cannot turn qualification into an accepted A/A sample.

The browser orchestrator prints its five stages without arguments. Execution
requires explicit byte-frozen `--release=...`, `--stage=...`, `--output-root=...`
and `--execute`. `--validate-release` checks bindings without starting an arm.
After successful FULL qualification, forecast the full experiment duration and
freeze fresh B0 A/A and B1 A/A before any further product optimization. Each stage
has five alternating pairs; all 50 arms are fresh. Loaded browser latency and
final backlog drainage must improve beyond frozen noise in the median and at
least four of five pairs; sparse streaming and control must not regress. The
later H4e proof finalizes the same sealed comparison samples with
`--original-h4e-proof`, `--original-h4e-inventory` and `--require-acceptance`.

At packaging, only one H5c SMALL B0 qualification had been released. No H5c
runtime pass, A/A suitability or browser gain was established. Historical H5b
helpers remain in [h5b](../h5b/README.md). Run receipts and the dated evidence
report establish later results; this source package claims none.
