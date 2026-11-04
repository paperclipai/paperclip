# Prospective candidate source binding, v4

This source-only packet succeeds immutable v3
`caab406f96294313b9ab05ed4f26a083023cbb4d61075993cfbf9b8fc15129c7`.
It removes the helper's fixed B2 source constant. Candidate source is already
supplied by `perVariantBuilds.B2` in the exact authorized root release and bound
to its own actual qualified receipt. No override flag, unqualified-source path
or additional registration framework is introduced.

**Current75 remains the only registered candidate.** This helper change does
not register a future source, suggest a Rust optimization or change product code.
Any future candidate must first be chosen from actual noise/performance evidence,
then prospectively registered through a new exact authorized root release with
its actual independently qualified source/build/native/inventory descriptor.
Register it before its first comparison. Never retarget completed candidate
comparisons: the unchanged prior-stage checks bind their source revision and
qualified inventory to the current release, rejecting a different candidate.

## Minimal executable change

Both byte-identical candidate validators now reject either frozen B0/B1 source
revision used as B2. They retain every existing exact receipt-role/revision,
compiled-stamp, clean source, live Git HEAD/input, fifteen native input paths,
compiler/configuration/metadata, isolated target, serving binary hash, four-root
inventory and within-role identity check. B0/B1's exact static source/receipt/
artifact pins remain unchanged. There is no cross-role binary-novelty or
binary-equality requirement; artifact provenance still requires an actual build.

The executable diff only removes `B2_REVISION`, replaces its assertion with the
B0/B1 exclusion, updates the dry-run pending-input wording and propagates new
helper hashes to copied wrappers. All other helper bytes equal v3. Measurement
drivers, comparator, oracle, workloads, gap/control/durability rules, original
SLA, timers, stage order, five pairs/four wins, noise thresholds, resources,
quiet guards, six-runtime preflight, four inventory roots and arm seal sets are
unchanged. Every template remains `authorized:false`; no new B2 descriptor is
invented or included by this packet.

## Control compatibility and required next qualification

Main A/A comparison/noise identity does not bind the orchestrator hash. Its
registered harness/measurement, baseline build/receipt/inventory, runtime and
raw-evidence requirements remain unchanged. Existing v3 main B0 A/A can continue
under its already issued v3 release. Preserve its installed helper, release and
evidence bytes exactly; this packet neither interrupts nor rewrites that run.
Completed suitable main v3 controls may be consumed only after their ordinary
owning evidence and unchanged identity checks pass.

Companion identity explicitly binds both dependency and orchestrator hashes.
Therefore **old v3 companion qualification/noise cannot be reused with v4**.
Freeze and review this candidate-neutral helper before any companion A/A. After
the sole operator's quiet boundary, run one fresh V4 B0 functional qualification
under the new hashes and fresh evidence path, then collect all new companion
A/A controls before any further product/Rust optimization. Those controls must
establish their noise envelope before choosing any subsequent fix. No new
companion arm is released by this source packet.

All four A/A gates—main B0, main B1, companion B0 and companion B1—must establish
their frozen observed noise before any further product optimization. The retained
explorer report `candidate-registration-compatibility.json` documents why main
v3 controls may carry forward and old companion identities may not.

The copied readiness/Python qualification wrappers retain their existing static
setup paths and inputs; do not infer current/future B2 qualification from their
historical B2-base setting. Actual candidate descriptors belong in root releases
and require actual source/build receipts and ordinary qualification. No existing
VM source, output directory, release or accepted raw evidence was edited here.

## Verification and reproduction

The same 91 source/guard tests are retained. The current75 positive case now also
tests a coherent hypothetical future descriptor and rejects a different receipt
revision. The removed fixed75 pin assertion test now rejects both frozen
baseline sources relabelled as B2. Existing wrong receipt-role, actual source,
compiled stamp, native/configuration, target, runtime and artifact tests remain.
The synthetic future source is fixture metadata, not a real registered commit.

Actual RED runs the future-descriptor cases against immutable v3; both reject
solely at the fixed75 source assertion. GREEN runs all91 against v4. The unchanged
frozen comparator's six CLI tests also run, retaining cross-role qualified hash,
serving/receipt mismatch, within-role/A/A drift and later-confirmation checks.

```sh
python3 /private/tmp/native-ingestion-h5e-tools-v4/compose.py
python3 /private/tmp/native-ingestion-h5e-tools-v4/generate_templates.py
python3 /private/tmp/native-ingestion-h5e-tools-v4/run_checks.py
python3 /private/tmp/native-ingestion-h5e-tools-v4/finalize_packet.py
```

Only local source composition, pure metadata/CLI checks, syntax parsing, dry
runs and authorization denials occurred. No SUT, provider, browser, DB, product
build, network or VM action ran; no primary files or prior packets were edited.
Peer/root review, new companion functional qualification and noise controls,
and the original measured application/correctness acceptance gates remain open.
