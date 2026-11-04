# Frozen H5b application helpers

These are exact source snapshots of the four reviewed task helpers. `sources.json`
records their original paths, SHA256 values and the frozen inputs. No helper code
or embedded path was changed for packaging. The owning run receipt identifies the bytes
that actually executed. Copying tools into a delivery commit does not rerun or
change the provenance of earlier evidence.

The recorded SMALL post-read check used extractor SHA256
`00930574798e3d56257a4913d82400ccd739b4bb52e9a24d5cb18a36892be970`
(5445 bytes), retained with its raw 23-file artifact manifest. The packaged
extractor is the later reviewed SHA256
`a052375a80b3abad4513cdf019325e83fed63c67d935f1dc2accba753ce589f0`
(5704 bytes). It adds three existing-history prelude assertions: foreground run
identity, 1000 unique deltas, and verification before epoch with retained head.
It did not produce the SMALL proof. Measured driver bytes are unchanged.

The executed driver is tag `native-ingestion-h5b`, annotated tag object
`34498d7e09b61493e0f6703c354291c485836298`, commit
`179fe6fa6da1b24ca08c1162301538d3e3788af6`. Its lock SHA256 is
`54a81b2ed3f1f85eaa085c034560ac248e384db34fbc7aba8c5a3846c29b3ce8`.
The delivery lock is different. Do not replace it or describe a delivery checkout
as that executed driver. The [frozen registration](../../../tests/e2e/fixtures/native-ingestion-h5.md)
sets the independent-agent geometry, deadlines and evidence gates.

## Recorded Linux setup

Use a disposable, quiet Linux host with the recorded Node/pnpm, PostgreSQL,
Chromium and native Runner inputs. Install and normally build each exact APP
revision independently; retain its build receipt and all four inventory roots.
Keep source, node_modules, TypeScript output and compiled APP output separate.
Only the native Rust target could be reused: all 15 native inputs matched exactly,
including Rust tree `bbe29bba574ce8d5cfddf2f7461ae0eb5983df07`.
The build receipts do not imply three fresh Rust compilations. The three APP
revisions and directory names are in `sources.json`. Raw B2 `ca7cba1` is the unoptimized
batching base. A future Rust candidate needs a new immutable revision, normal
build and qualified inventory; none is supplied here.

Keep the recorded layout under `/home/ubuntu/native-ingestion`: the independent
179 driver at `harness-h5b`, APP trees at `aligned-baseline`, `aligned-cursors`
and `aligned-batching`, qualified build receipts and inventories in their recorded
locations, and these four helpers in `helpers` under their original basenames.
Verify their copied bytes against `sources.json`. The qualification/readiness
wrappers intentionally retain those paths. Any path-portable derivative must
record its changes and separate hashes.

Run this snippet from the current tools checkout. The paths retain the recorded
Linux layout. A new driver/output path must be absent before creation.

```sh
TOOLS_CHECKOUT="$(git rev-parse --show-toplevel)"
DRIVER_ROOT=/home/ubuntu/native-ingestion/harness-h5b
HELPERS_ROOT=/home/ubuntu/native-ingestion/helpers
git -C "$TOOLS_CHECKOUT" show-ref --verify --quiet refs/tags/native-ingestion-h5b ||
  git -C "$TOOLS_CHECKOUT" fetch origin tag native-ingestion-h5b
test "$(git -C "$TOOLS_CHECKOUT" rev-parse 'native-ingestion-h5b^{commit}')" = 179fe6fa6da1b24ca08c1162301538d3e3788af6
git -C "$TOOLS_CHECKOUT" worktree add --detach "$DRIVER_ROOT" native-ingestion-h5b
pnpm --dir "$DRIVER_ROOT" install --frozen-lockfile --offline --ignore-scripts
mkdir -p "$HELPERS_ROOT"
for helper in native-ingestion-run-h5b-browser.mjs native-ingestion-linux-h5b-qualification.py native-ingestion-h5b-linux-readiness.mjs native-ingestion-extract-h5b-qualification.py sources.json; do
  cp "$TOOLS_CHECKOUT/scripts/native-ingestion/h5b/$helper" "$HELPERS_ROOT/$helper"
done
node "$DRIVER_ROOT/scripts/describe-native-ingestion-h5.mjs"
node "$TOOLS_CHECKOUT/scripts/native-ingestion/h5b/native-ingestion-run-h5b-browser.mjs"
```

The last two commands are dry runs. They start no app or performance arm.
The recorded driver install is independent of each APP's normal install/build.
Use the original frozen driver for active comparisons and later same-source H4d
confirmation, even when these source bytes also appear in the delivery PR.

## Qualification and comparisons

Only start one released stage in an exclusive quiet window. Unset inherited
`DATABASE_URL`, `PAPERCLIP_RUNNER_STATE_DIR` and diagnostic overrides as the wrapper does.
Use fresh output names; preserve failures and existing output. After the build
and live-inventory checks, the recorded qualification commands are:

```sh
QUALIFICATION_OUTPUT=/home/ubuntu/native-ingestion/evidence/h5b/qualification/NEW-FULL
python3 /home/ubuntu/native-ingestion/helpers/native-ingestion-linux-h5b-qualification.py --tree=B0 --name=NEW-SMALL
python3 /home/ubuntu/native-ingestion/helpers/native-ingestion-linux-h5b-qualification.py --tree=B0 --full --name=NEW-FULL
python3 /home/ubuntu/native-ingestion/helpers/native-ingestion-extract-h5b-qualification.py "$QUALIFICATION_OUTPUT" --revision=bac53ec3bfeaf6546e7aaeaee516487b30534654 --full
```

The extractor's `--full` must match the qualification. It verifies retained
reports and emits qualification-only output. The readiness helper additionally
checks actual B0/B1 inventories, native target, PATH and physical quiet; its
output path must be fresh. It does not start an APP.

The browser orchestrator prints its five stages without arguments. A stage needs
an explicit byte-frozen `--release=...`, `--stage=...`, `--output-root=...` and
`--execute`. Static `--validate-release` checks do not execute an arm. Release
inputs bind the exact driver, tools, APP/build inventories, stage order and prior
noise reports. Qualify full B0 and forecast duration before fresh B0 and B1 A/A;
freeze both noise results before implementing another product optimization.

H5b uses 100 normal independent agents, one concurrent run each, and eight setup
workers. Counts, rates and original polls stay fixed. H5 observation has explicit
600s streaming and 1200s invocation limits. The original 120/180/900s outcomes stay
separate; final B2 must meet every original SLA in every arm and later pass H4d
on the same frozen source/geometry/SUT. The 30-minute resource watchdog grants no
SLA extension or performance acceptance.

Status at the recorded 2026-11-04 05:27:45 UTC launch: B0 SMALL passed functional
qualification; full B0 had started. The later full B0 H5b attempt **failed**:
83 runs succeeded and 17 failed; owning Playwright duration was 742.825s.
Existing-history and Stop were not reached. Authority checks verified 100 distinct
agents, and source clocks verified all 51,200 emissions. Complete canonical
persisted counts are not yet established. Full PostgreSQL causal forensics remain
pending. This is not a passed FULL qualification or an accepted performance arm.

This source package claims no A/A, browser gain or application acceptance.
The old 2-agent × 50-run failure remains a product limitation. Current run receipts
and the dated benchmark report, not this source package, establish later outcomes.
