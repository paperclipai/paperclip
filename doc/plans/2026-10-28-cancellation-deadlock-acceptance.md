# Cancellation deadlock retry acceptance

This existing correctness slice (#17895) retries only the operator Stop database
transaction after PostgreSQL reports `40P01`, at most three times. Provider Stop,
workspace settlement, and activity publication remain after commit. This is not
a new polling or scheduling duty.

## Current parent and outstanding review

The previous published head is
`fffc8d0c46fbbeb3da4a23a36e638fefd3b8fe3d`, originally based on native progress
`08d07ead105dc89c2af9b62f4d90bff8cc93540c`. The slice is prepared by a normal
merge of verified native progress `6f365285f5b233a89acc714eadfead5ab145100e`.
All four original changed-file hunks retain their exact content and context.
Only the run-control blob index hashes differ because the parent also changed
that file. The automatic composition is clean and preserves those parent edits.

The prior Ponytail review said Ship with an actionable coverage request: existing
deadlock tests did not reach a correlated native failed run's claimed state before
rollback. The follow-up adds two real PostgreSQL cases in the existing run-control
suite, with no new production behavior:

1. Keep retry authority: claim the correlated Stop, fence the failed native run,
   cancel its real board terminal handoff, and persist cancellation activity inside
   the first transaction. Raise PostgreSQL `40P01` before commit. Retry succeeds;
   exactly one cancellation activity is durable and exactly one live notice is
   published. The correlation belongs to the committed attempt.
2. Revoke retry authority: after that aborted transaction rolls back, an independent
   coordinator update retires retry eligibility. The second attempt returns 409,
   preserves the failed run and uncancelled handoff, publishes no cancellation
   activity, and performs no provider or workspace cleanup.

The existing actual two-connection lock-cycle regression and the bounded retry/
non-deadlock cases remain in the complete suite. The new tests exercise claims
and activity produced before a real PostgreSQL transaction abort; they do not
infer correctness from a mocked retry callback alone.

## Evidence and failure accounting

- Both new cases pass against the retained production reset logic.
- Removing only `publications.length = 0` makes the preserved-authority case fail:
  two live cancellation notices appear for one committed activity. Production was
  restored byte-for-byte to its integrated index before further validation.
  `/tmp/sleep-aux-native-retry-mutation-proof.json` records that comparison.
- The negative-control harness initially expected an untruncated assertion line;
  Vitest abbreviates that line. Its actual named failure and 1-versus-2 result were
  inspected, and the matcher was corrected without rerunning or altering production.
- Typechecking caught an optional live-event payload in the new assertion. The
  assertion now uses optional access. Preserve the original failed typecheck at
  `/tmp/sleep-aux-current-parent-types.log`; the final typecheck passes at
  `/tmp/sleep-aux-current-parent-types-final.log`.
- **228 distinct complete cases pass:** all 48 run-control cases, including the two
  additions, and all 180 native-session runtime cases, including the existing
  controlled timeout/late-append fixture. The two targeted probes are included in
  48 and are not counted again.
- Server typechecking, build, and module-boundary checks pass. `server/tsconfig.json`
  excludes `src/__tests__`, but includes service-local test files such as
  `run-control.test.ts`; typechecking does not replace test execution. Earlier
  statements about tests omitted by production typechecking must be read with
  that path boundary.

The three PostgreSQL probes use separate new disposable databases on the owned
local cluster. Full-run results and exit receipts are in
`/tmp/sleep-aux-current-parent-{types-final,build,boundaries,control,runner}.log`.
The targeted positive and mutation logs are
`/tmp/sleep-aux-native-retry-regression.log` and
`/tmp/sleep-aux-native-retry-mutant-red.log`.

## Remaining gates and limits

This is local preparation. The dependency must merge, the normal merge onto its
actual landed master must preserve this tested patch and all master changes, and
fresh exact-head CI plus Greptile 5/5 must pass before protected merge. Prior
review scores and checks on older heads are not current passes. The previous
Snyk status was pending and is not called successful here. No shared OS resource
cleanup, schema change, whole-repository local matrix, live provider execution,
external alarm, physical suspension, or savings qualification is claimed.
