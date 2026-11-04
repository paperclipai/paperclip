# Native ingestion experiment helpers

For fresh cursor results and the current interleaved source reproduction, see [the new source report](../../doc/benchmarks/2026-11-03-native-event-ingestion-interleaved.md). The frozen runner below preserves the earlier experiment. Current application reproduction uses the separately frozen [H5d driver and helpers](h5d/README.md) and [v3 blocked-write Stop companion](blocked-stop/README.md). Each requires its own immutable checkout and locked install: main `2df9897e` uses measurement `e1d8930c…`, while companion `bc33f09c` inherits H5c measurement `2265aabe…`. This mixed delivery tree and its lock are not an executed driver. Functional qualifications passed; no application A/A or performance gain is established at the recorded 09:30 UTC cutoff. The versioned [H5c helpers](h5c/README.md), H5b and older H4c runner below retain historical evidence. Each current campaign has 50 fresh arms and independent noise gates; source reproduction commands are in its linked README.

These helpers reproduce the experiment registered on November 3, 2026. They
retain its immutable application revisions, harness revision, workload hashes,
acceptance checks and failure behavior. They are not a benchmark against an
arbitrary current checkout. Measurements and their qualification status belong
in the dated plan and evidence report; copying these helpers proves no gain.

## Provenance

The source helpers were snapshotted from the following task-owned files. The
hashes describe the originals before the small packaging changes below.

| Committed file | Original in `/private/tmp/` | Original SHA256 |
| --- | --- | --- |
| `run-frozen.mjs` | `native-ingestion-run-frozen.mjs` | `09879a9d6a4554b98bd0435cdc222915b0613cb9dfb22b36615ede8794f70435` |
| `diagnostic-run.mjs` | `native-ingestion-diagnostic-run.mjs` | `06cc3de3b67dcaa97dfa90f57562fd72b4fdf39b4f9e33c2cac543d569087681` |
| `diagnostic-preload.mjs` | `native-ingestion-diagnostic-preload.mjs` | `2afb5e0b9fff878cb7abc7e8a4e236e1620ac35eede9ca06accfec845756d10a` |
| `verify-delivery-runtime.py` | `native-ingestion-verify-delivery-runtime.py` | `a2d9d2fe4ed2e2b0bff61b9d264f1678b84266d0407d43e19cf9f4063819a7d4` |

Packaging changes: the diagnostic runner imports its renamed adjacent
`diagnostic-preload.mjs`; its dry-run message uses the committed path; the
acceptance runner rejects both the original and packaged preload filenames in
`NODE_OPTIONS`. Application, protocol, compiled-anchor and gate hashes are
unchanged. The diagnostic preload remains an exact original copy. The runtime comparison helper later gained the optional explicit CI base described below; its SHA above records its original-copy provenance.

The frozen experiment revisions are:

| Role | Revision |
| --- | --- |
| B0 baseline | `83b5f7d486e70e484acd9a41bc957054f4e10175` |
| B1 cursor | `7922802f069ab3b39e9f79368c46615ba2201ba9` |
| B2 cursor and batching | `6afeba4edafd47120e8117f736641d5424b27d4a` |
| H browser driver | `f5c560d80d9d4ee089297d3b3f300c052db17c9e` |

H is a separate test-driver checkout. Folding its test changes into a later
delivery commit does not change the recorded H revision. Check out these exact
revisions to repeat this experiment; do not update the constants to pass a guard.

## Preparation and quiet windows

Use Node 26.4.0 and pnpm 9.15.4, matching the captured experiment environment.
Install each measured application independently with `pnpm install
--frozen-lockfile` and run its normal `pnpm build`. Every application owns its
workspace dependencies, TypeScript output and UI output. The build stamp must
equal that checkout's exact revision. The original experiment shared only a
verified identical Rust target cache; cache sharing is optional.

The historical H setup linked only its root and server `node_modules` to B1's
locked driver tools. H did not supply application source or compiled output to
any measured application. The runner records this setup in the evidence's
`PAPERCLIP_INGESTION_DRIVER_DEPENDENCIES` description. Preserve it when reproducing
the historical runner. Install the matching Playwright Chromium build first.

Select a disposable quiet host with PostgreSQL and Chromium available. The
service harness starts a real embedded PostgreSQL database; browser cases start
the compiled application and shipped UI against a disposable database. No cloud
account, production data or provider credential is required. Run one stage at a
time, with no competing build, test, profiler or benchmark. Setup and warmup are
excluded from timed append samples. The production-built browser experiment
includes offered-load queueing and terminal backlog drainage.

Set the following shell variables to your own absolute checkout and output
paths. `TOOLS_CHECKOUT` contains this committed helper directory. `B1_CHECKOUT`,
`B0_CHECKOUT`, `B2_CHECKOUT` and `H_CHECKOUT` contain the exact revisions above.
Choose a new output directory for every independent experiment; existing evidence
is never overwritten. Always supply the roots explicitly because the fallback
paths preserve the historical local setup.

```sh
node "$TOOLS_CHECKOUT/scripts/native-ingestion/run-frozen.mjs" \
  --root="$B1_CHECKOUT" --b0-root="$B0_CHECKOUT" --b2-root="$B2_CHECKOUT" \
  --harness-root="$H_CHECKOUT" --output-root="$EVIDENCE_DIR"
```

Without `--execute`, this prints the registered stages and launches no work.
After qualification and release of a quiet window, add `--execute` and one
`--stage=<name>` from the following sequence:

1. `service-aa-b0`, `service-b0-b1`, `service-aa-b1`, `service-b1-b2`,
   `service-b0-b2`.
2. `browser-smoke-b0`, `browser-smoke-b1`, `browser-smoke-b2`, then
   `browser-full-qualification-b0`.
3. `browser-aa-b0`, `browser-b0-b1`, `browser-aa-b1`, `browser-b1-b2`,
   `browser-b0-b2`.

Stop on failure, retain its evidence, and diagnose before continuing. A timeout
or cleanup error is incomplete evidence. The process watchdogs bound resources;
they do not relax performance gates. Readiness must admit all 100 participants
before the common emission epoch in the full browser workload.

## Acceptance and interpretation

Service A/A requires five alternating pairs for all nine latency cases:
ordered, replay and warm-suffix at 1k, 10k and 100k retained histories. Every case
must have at most 20% maximum paired relative difference and 10% median arm
drift. Each timed sample contains 16 groups of 32 events. Late-gap closure has a
separate structural/correctness check; its one-shot timing is not a latency gate.

Candidate improvement must exceed the observed per-case A/A noise in at least
four of five individual pairs and in the median. Cursor comparisons require
10k/100k improvement and 1k nonregression. Browser comparisons preserve sparse
streaming, inter-chunk, first-render and Stop nonregression gates. The batching
and combined comparisons additionally require improvement for loaded `burst512`
p95 emission-to-render, p95 intended-to-render and terminal drainage. Every
background run requires independent durable delta proof. Browser A/A suitability
still requires review of its actual noise; successful execution alone is not a
repeatability conclusion.

These are local service/application measurements. They establish neither
deployed production improvement nor qualification of a 10,000-agent fleet. The
live-provider integration journey is separate. Do not interpret sparse raw
transport output as universally durable merely because its wire ACK was sent.

## Separate diagnostics

```sh
node "$TOOLS_CHECKOUT/scripts/native-ingestion/diagnostic-run.mjs" \
  --root="$B1_CHECKOUT" --b0-root="$B0_CHECKOUT" --b2-root="$B2_CHECKOUT" \
  --harness-root="$H_CHECKOUT" --tree=B2 --output=/tmp/native-ingestion-profile-new
```

This is also a dry run until `--execute` is supplied. Start with `--smoke` to
qualify the assembled diagnostic observer; it has no CPU profile and cannot
establish acceptance. Full diagnostics require successful marker coverage and
all compiled instrumentation anchors to be exercised. Their qualification must
be recorded separately from their presence in this directory.

The observer records actual normalized queue depth, postcommit source markers,
SQL/transaction attempts without SQL text or parameters, server Node CPU/memory,
event-loop delay, and sampled PostgreSQL process CPU/RSS. Full runs also capture
an app-only Node CPU profile. The outputs are explicitly `diagnosticOnly` and
ineligible for unprofiled acceptance. Queue observation excludes collector,
iterator, in-flight write and raw transport buffers. CPU/SQL window brackets
include disclosed sampling overshoot and may include verification reads.
PostgreSQL RSS sums double-count shared pages. Server Node CPU excludes Rust,
providers, Chromium and the external driver. Preserve these limits with any chart
or table derived from the diagnostic outputs.

The diagnostic output must be a new owned directory under `/tmp/` or
`/private/tmp/`. The test-only provider wrapper leaves production environment
sanitization unchanged. Unknown compiled-module SHA values fail immediately;
do not add an unreviewed hash to make a different build run.

## Delivery-source comparison

```sh
python3 "$TOOLS_CHECKOUT/scripts/native-ingestion/verify-delivery-runtime.py" \
  --repo="$TOOLS_CHECKOUT" \
  --frozen=7922802f069ab3b39e9f79368c46615ba2201ba9 \
  --delivery=3b77c1ca29467fbd742e9b6df4885bccef0acf08
```

For B2, supply its frozen and delivery commits instead. This read-only Git source/input comparison preserves the two documented test-typecheck script exceptions. CI helpers and those two scripts must match the immutable `--ci-base` commit, which defaults to `8ab89f41e499032e3e55d261f457a3463d754a1d` for historical reproduction. Later upstream helpers require an explicit full commit ID; the current evidence-only914→d05 comparison uses the tested frozen914 commit. The result reports both the selected-base match and the independent historical8ab match. Installed dependencies and compiled artifacts need separate equivalence receipts. Later delivery revisions must remain explicit full commit IDs.

## Evidence retention

Keep paired samples, exact command manifests, source/protocol hashes, environment,
correctness and cleanup results together. Keep diagnostic evidence separate.
Retain failed qualifications and their primary errors, record retry linkage and
confidence in the diagnosis, and never promote a failed report by rewriting its
status. Publish compact JSON and interpretation with the owning PR; link raw
artifacts by a durable location and SHA256. Temporary local paths alone are not a
reviewable final evidence location. Scan live-provider artifacts for credentials
before publishing; these deterministic helpers require none.
