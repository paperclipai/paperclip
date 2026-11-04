# Current H5e reproduction tools

This directory packages the reviewed candidate-neutral H5e V4 helpers and the
combined resource V3 diagnostic. The snapshots are exact copies: `sources.json`
records every original path, length and SHA256. Original absolute paths inside
those copies are provenance, not portable defaults. These source snapshots and
examples grant no execution release.

Large compiled entry/postgres fixture files are intentionally whole: the tests
verify complete original bytes and exact transform anchors, so splitting them
would invalidate that proof. The retained TAP failure log includes four blank
lines with trailing spaces; the local Git attribute preserves those exact raw
bytes instead of editing evidence to satisfy a whitespace check.

The common framework belongs to cursor PR #18817. Batching PR #18818 inherits it
and owns incremental/combined results and final-source live/cloud Stop evidence.
The [current evidence index](evidence/current-status.json) records completed
functional qualifications, active calibration, exact artifact hashes and pending
publication. No application noise envelope or improvement has passed at this
packaging snapshot. The [application report](../../../doc/benchmarks/2026-11-04-native-event-ingestion-application.md)
retains earlier failures and limits.

## Exact independent inputs

| Role | Published tag | Immutable commit |
| --- | --- | --- |
| B0 | `native-ingestion-benchmark-2026-11-04-cf-b0` | `7550ffa5d6447d2615bc89fc5313f4cbb958b615` |
| B1 | `native-ingestion-benchmark-2026-11-04-cf-b1` | `2cf1454406cbd582a11f04476713eceb746eada5` |
| Current TypeScript B2 | `native-ingestion-benchmark-2026-11-04-cf-b2-ts` | `75b3578cfccf040b087a55a624e01baa2bca37f9` |
| Main driver | `native-ingestion-h5e` | `73ea8516739e81fa7f37cd67651b4a2c73674014` |
| Blocked-Stop driver | `native-ingestion-blocked-stop-v4` | `a89f321ab5654211cbff7be1ee15c110b8db4a5f` |

Use separate clean checkouts and independent locked installs. The main driver
measurement is `7995ffdb…`; the companion's inherited main measurement is
`e70ae872…`. Both driver locks are `54a81b2e…`. Exact hashes, annotated tag
objects and source trees are in [the freeze receipt](evidence/driver-source-freeze.json).
This mixed delivery tree and its lock cannot replace either executed driver.
Do not move the published tags or edit an active helper/release.

The recorded serving toolchain is Linux Node 26.4.0 and pnpm 9.15.4, with exact
six-runtime executable/output checks in every release. Source checks also run on
Node 24.22.2. Actual source/build/native/configuration, isolated canonical target,
compiled stamp and four-root inventory guards remain mandatory. The current
TypeScript implementation requires no Rust product change. Its actual B2 build
has its own receipt and target even though all fifteen native inputs and its
native binary match CF B0/B1. A future candidate needs prospective exact
registration and actual qualification; old completed comparisons cannot be
retargeted.

## Runtime source parity at delivery

The serving candidate remains source75 and its independently built Mac/Linux
artifacts. A later evidence-packaging delivery head is a different Git identity;
do not relabel the built candidate or force an application rebuild solely for
documentation/tools. Before handoff, retain a read-only diff/input receipt:

1. Compare this packaging slice to cursor delivery parent
   `b578b95d3257af93d3f2696b0203bb4bcb0c6bcf`. Only benchmark tools and related
   documentation may differ. Preserve the existing frozen B1 `2cf14544…` to
   delivery-parent runtime-equivalence proof.
2. After PR2 incorporates the common package, compare its production source,
   lock/build configuration and fifteen native input objects to built candidate
   `75b3578cfccf040b087a55a624e01baa2bca37f9`. Confirm that every difference is
   benchmark/test/documentation scope; recheck any actual product/input change.
3. Keep actual serving source stamps, binary and four-root inventory receipts
   pinned to the tested built revision. Run fresh delivery-head CI and review
   for the packaging commits. Existing acceptance evidence keeps its actual
   runtime identity; no source receipt or completed sample is rewritten.

This is a proof plan for the final delivery heads, not a claim that an uncreated
commit has already passed CI or equivalence checks. Final live/cloud helper
changes and qualifications remain owned separately by PR #18818.

## Offline package checks

```sh
node scripts/native-ingestion/h5e/verify-package.mjs
node --test scripts/native-ingestion/h5e/packaging.test.mjs
node scripts/native-ingestion/h5e/run-source-checks.mjs --suite=h5e \
  --main-root="$MAIN_DRIVER_CHECKOUT" \
  --companion-root="$COMPANION_DRIVER_CHECKOUT"
```

The H5e command runs the 91 source/provenance cases, two expected actual V3 RED
cases and six frozen comparator CLI cases. It verifies both checkout revisions
and clean state first. Only temporary copies of test fixture locations and
composition parent paths change. Helpers, tested assertions, sealed fixtures
and the original checkouts stay unchanged. It needs the exact driver Git objects
and existing comparator test dependencies; it performs no install or network
access and launches no application. Temporary copies are removed in `finally`.

Resource and external pure checks can be reproduced separately:

```sh
node scripts/native-ingestion/h5e/run-source-checks.mjs --suite=resource
python3 scripts/native-ingestion/h5e/snapshots/resource-v3/analyze-pg-windows.test.py
node scripts/native-ingestion/h5e/run-source-checks.mjs --suite=external
python3 -m unittest discover \
  -s scripts/native-ingestion/h5e/snapshots/resource-v3/external \
  -p test_external_resources.py
```

These use fixture directories, extracted actual source and in-memory process/
SQL/module stubs. They do not inspect live `/proc`, start systemd or PostgreSQL,
or qualify serving hooks. Exact unchanged source/fixture closure can reuse the
retained passing receipts; packaging path changes need their affected checks.

The original `compose.py`, `run_checks.py`, generators and readiness/Python
qualification wrappers are preserved authoring snapshots. Do not run them as a
portable setup sequence: they retain historical private paths, guard inputs and
the unoptimized `B2-base=0b616…` selector. That selector does not qualify current
75. The portable check runner replaces only their test-location dependency; it
does not weaken any runtime guard or introduce an alternate qualification path.

## Configuration and execution boundaries

Use the exact helpers under `snapshots/h5e-v4/` for newly registered stages.
Their no-argument invocation is a dry run. The main helper accepts `--execute`,
`--stage`, `--release` and `--output-root`; the companion also requires an exact
`--release-sha256`. All four copied templates remain `authorized:false`.
New explicit root releases supply actual build descriptors, runtime readbacks,
fresh paths, guard evidence, prerequisites and frozen noise reports. Hashes must
describe the bytes actually used; never infer them from an example.

`relocate-template.mjs` can move path locations in an **unauthorized** template:

```sh
node scripts/native-ingestion/h5e/relocate-template.mjs \
  --template=scripts/native-ingestion/h5e/snapshots/h5e-v4/templates/main-aa-b0.unauthorized.json \
  --path-map="$PATH_MAP_JSON" --output="$NEW_UNAUTHORIZED_TEMPLATE"
```

The path map is an object of original absolute prefixes to new absolute prefixes.
The command refuses an authorized input and refuses to overwrite output. It
leaves source/hash/runtime values unchanged and cannot qualify a build or host.
Original qualified receipt references, baseline target isolation and original
artifact metadata remain facts; relocating a pointer does not change them or
make a newly built baseline interchangeable with a frozen one. This template
still needs the normal independent review and explicit release before execution.

Current main V3 A/A must finish with its existing helper/release unchanged.
Main controls can carry forward only after the ordinary identity and suitability
checks pass. The companion binds both helper hashes: old-wrapper qualification
or A/A cannot be reused with neutral V4. It needs one fresh functional
qualification followed by its own new A/As. All four main/companion B0/B1 noise
controls remain required before any further product optimization. Five
alternating pairs, four-of-five beyond-noise wins, original SLAs, durable
barriers and final drainage remain unchanged.

## Separate resource diagnostics

Read the [exact diagnostic README](snapshots/resource-v3/README.md),
[immutable counter definitions](snapshots/resource-v3/DEFINITIONS.md), and
[five-block protocol](evidence/resource-measurement-protocol.json). The source
packets and independent/root reviews are retained here. Source clearance does
not qualify actual Linux service permissions, controls, environment, authentic
exit receipt, exited-child CPU accounting, installed postgres3.4.9 bytes or any
serving hook. A separately released SMALL must exercise all six hooks, exact
SQL/postmaster binding, independent flush and normal cleanup before FULL.

The registered resource comparison is five alternating three-role matched
blocks (15 FULL invocations), supplying five pairs per contrast. Observations
shared across contrasts are correlated, not extra independent trials. Terminal
and fully verified windows stay separate; each CPU/SQL/outer-COMMIT numerator
needs six interior samples and at most 10% boundary uncertainty. The denominator
is independently verified unique durable text deltas. Stop/short/incomplete
windows retain raw counters without ratios. Server Node CPU is server-only,
proc CPU is a lower bound, and whole-PG CPU includes the SQL observer. Without
CPU-specific noise calibration, report measured costs and interval bounds,
not an improvement beyond noise. These diagnostics never replace unprofiled
application/control acceptance.

Resource packet version 3 keeps ABI `combined-h5e-resource-v2`. Its expected B2
pins are current75 only. The port fixture's Mac-build origin and cryptographic
equality to the qualified Linux manifest are explicit; this is not actual
Linux installed-module or serving qualification.

## Evidence and publication

Keep commands, exact identities, samples, raw arm seals, complete drain and
cleanup together. Preserve failed, censored, retried and ineligible observations
with their original errors and timing limits. The compact index records missing
durable artifact URLs explicitly; private paths alone are not final evidence
delivery. Add durable artifact links and hashes after the existing credential
and decompressed-artifact scans. Do not archive disposable server homes,
`owned-pg-environment`, `owned-initdb-password`, master keys or credentials.
Do not copy historical raw logs wholesale into Git. Final-provider/cloud helpers
and final-source journey evidence belong to PR #18818.
