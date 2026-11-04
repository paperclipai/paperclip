# Frozen H5d application driver

This package retains the six exact H5d source overlays and six reviewed helpers.
`sources.json` records their hashes. Execute immutable driver **2df9897e1ce2ca90be29fa097d776c3766e217ad**,
tag `native-ingestion-h5d`, annotated object `47ef6d1a5d81c31d4602aad50666f67c58f4cdb4`.
Its measurement hash is `e1d8930c47b4d3a287aa0f3baf09fbd3aa04ac30b9313b707616dea7a3fec5d4`;
its lock is `54a81b2ed3f1f85eaa085c034560ac248e384db34fbc7aba8c5a3846c29b3ce8`.
The mixed delivery checkout has a different lock and is not an executed driver.
The [blocked Stop companion](../blocked-stop/README.md) uses a separate immutable
checkout inheriting H5c measurement `2265aabe…`, not H5d measurement `e1d8930c…`.

## Recorded qualification and limits

As of 2026-11-04 09:30 UTC, H5d SMALL passed: 48 deltas, three results and a
nine-delta Stop prefix with no result; all 40 sealed files and cleanup were checked.
FULL's owning Playwright test passed in 853,339 ms with strict physical quiet.
The frozen assessor retains the original loaded 120-second streaming miss:
41/512 foreground markers near 119.841 seconds. The original 900-second duration
gate passed. All 51,200 loaded deltas and 100 results were independently verified,
including 43 recovered `provider_transport_failed` failures, 402,584 ms through
verified completion, and all leases closed. These are qualification facts,
not accepted A/A noise or evidence of application improvement.

The existing-history workload is one foreground run with 1,000 emitted and
verified prelude deltas under nine fresh background runs. It does not create ten
history-bearing runs. Retain all source performance results separately from app
measurement. No application A/A campaign had passed at the recorded cutoff.
The lead's dated application report owns subsequent campaign progress.

The old offline reader `968fbbfc…` failed an unsupported `runIds[0]` assumption.
The new foreground reader `b1e74ffd…` correlates the unique prelude run through
actual durable/provider-clock nonce, marker, activation and authority identities.
Root and peer reviewed its old-red, permutation and nine-negative checks and its
readback of a COPY of the same owning PASS raw report. Original failure, first
seal and raw bytes remain preserved. This repairs a qualification postreader;
it changes no SUT or measurement source and cannot promote a failed owning test.
The old reader is not packaged as the current reader.

## Independent setup

Use a disposable Linux host with the recorded Node **v26.4.0**, pnpm **9.15.4**,
PostgreSQL, Chromium and native toolchain. Node 24 is the local Mac check toolchain.
Capture actual executable paths and exact outputs before release: `node --version`,
`node -p process.execPath`, `pnpm --version`, `rustc --version`, `cargo --version`,
and the actual PostgreSQL and Chromium executables with `--version`. Runtime
release pins must use those values. Never infer a version from this package.

```sh
TOOLS_CHECKOUT="$(git rev-parse --show-toplevel)"
BASE=/home/ubuntu/native-ingestion
DRIVER_ROOT="$BASE/harness-h5d"
HELPERS_ROOT="$BASE/helpers"
git -C "$TOOLS_CHECKOUT" fetch origin tag native-ingestion-h5d
test "$(git -C "$TOOLS_CHECKOUT" rev-parse 'native-ingestion-h5d^{commit}')" = 2df9897e1ce2ca90be29fa097d776c3766e217ad
git -C "$TOOLS_CHECKOUT" worktree add --detach "$DRIVER_ROOT" native-ingestion-h5d
pnpm --dir "$DRIVER_ROOT" install --frozen-lockfile --offline --ignore-scripts
mkdir -p "$HELPERS_ROOT"
cp "$TOOLS_CHECKOUT"/scripts/native-ingestion/h5d/*.mjs "$HELPERS_ROOT/"
cp "$TOOLS_CHECKOUT"/scripts/native-ingestion/h5d/*.py "$HELPERS_ROOT/"
node "$HELPERS_ROOT/native-ingestion-run-h5d-browser.mjs"
```

Use a fresh driver path and install its own locked tools. Verify copied bytes
against `sources.json`. Build every measured application independently with its
normal locked install and build. Recorded aligned builds are B0 `bac53ec3…`, B1
`07061a60…`, and unoptimized B2 `ca7cba17…`; qualified build receipt SHA is
`a1259ba760f3cbbe44817e333f9f620bcf3769fb0a6c16f9ce2f0f5b2ed60d94`.
Validate all four artifact roots, UI shadow absence and native inputs every arm.
`ca7cba17` is not a final B2 candidate; a new candidate requires actual immutable
source, normal build and qualified descriptor. No candidate is invented here.

The exact setup/readiness wrappers use recorded absolute paths and new output
namespaces: `h5d/setup` and `h5d/setup-full-b0`. Read them before use; they perform
live inventory/quiet checks. After an explicit quiet-window execution release,
the recorded functional commands are:

```sh
mkdir -p "$BASE/evidence/h5d/setup"
node "$HELPERS_ROOT/native-ingestion-h5d-linux-readiness.mjs"
python3 "$HELPERS_ROOT/native-ingestion-linux-h5d-qualification.py" --tree B0 --name small-b0
# In a separate released quiet window, with its distinct setup/output namespace:
mkdir -p "$BASE/evidence/h5d/setup-full-b0"
node "$HELPERS_ROOT/native-ingestion-h5d-full-linux-readiness.mjs"
python3 "$HELPERS_ROOT/native-ingestion-linux-h5d-qualification.py" --full --tree B0 --name full-b0
```

The qualification wrapper runs real production-built app/browser/database/provider
paths. Do not execute it during another timing window. Its 30-minute resource
watchdog does not enlarge the original 120/180/900-second gates or H5 observation
600/1200-second limits. Qualification flags and source caps remain unchanged.

On a COPY of a completed qualification output, run the current offline reader,
then frozen validator. Omit `--full` for SMALL. These read evidence, not the SUT:

```sh
python3 "$HELPERS_ROOT/native-ingestion-extract-h5d-qualification-foreground.py" "$QUALIFICATION_COPY" --revision=bac53ec3bfeaf6546e7aaeaee516487b30534654 --full
node "$HELPERS_ROOT/native-ingestion-validate-h5d-evidence.mjs" "$QUALIFICATION_COPY" "$DRIVER_ROOT"
```

## Fresh measurements

The runner's default invocation is a dry run. A byte-frozen concrete release
binds source/helper hashes, exact build/native/UI inventories, six actual runtime
outputs, output ownership, qualification and prior noise/series hashes.

```sh
node "$HELPERS_ROOT/native-ingestion-run-h5d-browser.mjs" --release="$RELEASE_JSON" --stage=browser-aa-b0 --output-root="$EVIDENCE_ROOT" --validate-release
```

Only the sole benchmark owner executes the released stage by replacing
`--validate-release` with `--execute`, using the same frozen release bytes. Run
`browser-aa-b0`, `browser-aa-b1`, `browser-b0-b1`, `browser-b1-b2`, `browser-b0-b2`
in order: five fresh alternating pairs each, 50 full arms. Both suitable A/A
artifacts and their exact absolute/relative noise must freeze before comparisons
or further optimization. No qualification arm is reused. Stop and preserve raw
on any owner, cleanup or suitability failure. No replacement sample or looser
budget follows from a failure. A final candidate must pass all original SLAs
and the separate default `browser-finalize-h4e` proof after both comparisons.

The main and companion 50-arm campaigns have separate workloads and noise.
Diagnostic profiles and counter instrumentation are separate; the unqualified
counter wrapper is intentionally absent from this package.
