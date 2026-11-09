# Proven Grok stale-promotion cleanup consolidation

Proof base: #16106 exact head 397459400c6e7b18b462dcac3d8886b390ca8e8c. Supplied patch SHA256 verified as 06b3f1bdafc81bc0da4b47d18d9348101cb94a647de2da269bfe4903b73f6a3a. Original test, promotion production module, decision wrapper/CJS, home resolver and directory lock source match exact-head blobs. Isolated temporary snapshot only; serial full-owner runs; no shared checkout edits, commits, pushes or PR.

Result: PROVEN. Owner packages/adapters/grok-local/src/server/adapter-auth-promotion.test.ts shrinks 658 -> 633 lines (25 net); cases 30 -> 29; one fixture/two promotion calls retired. The production call chain also removes one real local Node predicate child: the empty-home first promotion seeds in-process, while the second same-identity promotion calls writeSameIdentityCredentialIfFresher → decideGrokAuthMerge → execFile("node", [grok-auth-merge-decision.cjs,...]). This is a source-proven call delta, not a measured child counter or provider run. Supplied static map's zero-subprocess statement overlooked that local predicate. No wall-time claim.

Keeper `keeps the home when the login is older than the existing same-identity credential` gains the retired case's actual company-home readdir equality. Retire `leaves no staged temporary file in the company home after a kept (not-fresher) outcome`.

Both original cases allocate the same root/env, promote UUID_A marker fresher expiry June2026 into companyA, then promote marker staler expiry January2026, user initiated=true, readiness=ready, soleOwner and noopLog. Keeper retains exact kept outcome and persisted fresher-token receipt, then checks actual entries===auth.json. Static Babel proof reports identical fixture/action prefixes after location/comment removal; runtime uses real scoped persistence, canonical directory lock and real decision predicate. Tied-expiry, success cleanup, redaction, user/sole-owner gates and cross-company cases remain untouched. No ownership or expected value changes.

| Complete-owner phase | Cases | Pass | Fail | Exit |
|---|---:|---:|---:|---:|
| baseline | 30 | 30 | 0 | 0 |
| candidate | 29 | 29 | 0 | 0 |
| reverted-owner | 30 | 30 | 0 | 0 |
| kept-temp-leak-original | 30 | 29 | 1 | 1 |
| kept-temp-leak-keeper | 29 | 28 | 1 | 1 |
| restored-candidate | 29 | 29 | 0 | 0 |
| integrated-stack | 29 | 29 | 0 | 0 |

Every run has zero pending/todo/skipped cases. Reverted-owner is a complete positive run of the exact original source before mutation, not only a source copy.

## Actual production mutation

Remove only `await rm(stagedTempPath, { force: true }).catch(() => undefined);` from writeSameIdentityCredentialIfFresher's finally. Leave the separate initial-publish writeAuthFileAtomically cleanup, handle close, decision predicate and rename intact. Actual stale same-identity keep outcome leaks .auth-PID-UUID.tmp alongside auth.json. Original retired case and keeper each fail their real readdir equality directly; each complete owner has exactly one failure. Keeper still observes kept and the correct persisted fresher credential before failing cleanup equality, so the mutation does not substitute a wrong identity/status outcome as proof.

Verbose original/keeper logs show the actual randomly generated temp filename as a received directory entry; no synthetic filename or expected list is produced by the mutation. Initial JSON-only original-control output abbreviated the received array, so its evidence harness declined to qualify the filename check. Source was restored and the sequence repeated with verbose+JSON reporters; accepted controls show actual leaked entries. The initial positive/control report copies remain in initial-json-reporter-attempt/; no production/assertion modification was used to expose a different outcome.

Production/test restore occurs in finally and is byte/hash-verified. Restored full candidate passes 29/29; all source finally returns to exact #16106 originals. Test afterEach removes its fake credential fixture roots, including leaked files; async predicate execFile awaits/reaps its child. No real provider, credentials, global instance home or other company was touched.

## Hashes and integrated stack

- Original test SHA256: 6925e2b73d52a02ada9457122a2d2262237b937028840443a4aaf38a8f2a2291
- Proven candidate test SHA256: 653f85a7b4933e2db534155f3cfbdde1599e0c063b973d490125f58832b7b222
- Original/restored promotion production SHA256: aa21740457ceef46e6cddf76dc640f1ed9056e16337ca8ed6def8a2b046e1543

All four proven shard/provisioning/Codex/Grok patches pass git apply --check and apply together without conflict on exact #16106. Integrated Grok owner passes 29/29 with all four patches present; integrated-receipt.json pins their test hashes and report digest. All four tests restore to exact #16106 bytes afterwards. Other three owners are not claimed rerun in that combined state.

Use checked-in root Vitest projects config (Grok has no separate config), exact full owner filter, same isolated workspace-source links and immutable third-party dependency graph as the Codex proof. Five additional root third-party links needed for root config loading are recorded in base-hashes.json; no shared workspace source links. No custom mocked resolver, provider, decision or credential comparison replaces production behavior.

## Checkout reproduction

Use a fresh checkout at the exact proof base above with repository dependencies installed through the pinned pnpm version. All commands below run from the repository root. After the baseline, fetch the reviewed branch and generate the candidate-only patch: `git fetch origin codex/test-audit-grok-auth-promotion && git diff 397459400c6e7b18b462dcac3d8886b390ca8e8c FETCH_HEAD -- packages/adapters/grok-local/src/server/adapter-auth-promotion.test.ts > /tmp/grok-candidate.patch`. Check and apply it with `git apply --check /tmp/grok-candidate.patch && git apply /tmp/grok-candidate.patch`.

```sh
node node_modules/vitest/vitest.mjs run packages/adapters/grok-local/src/server/adapter-auth-promotion.test.ts --reporter=verbose
```

Expected baseline: 30 passing cases. Apply `/tmp/grok-candidate.patch`, then run the same command: 29 passing cases. Restore the original test from `397459400c6e7b18b462dcac3d8886b390ca8e8c` and rerun the same command: 30 passing cases.

With the original test restored, execute this exact production mutation:

```python
from pathlib import Path

owner = Path("packages/adapters/grok-local/src/server/adapter-auth-promotion.ts")
source = owner.read_text()
start = source.index("async function writeSameIdentityCredentialIfFresher(")
end = source.index("/**\n * Promotes a Grok", start)
section = source[start:end]
cleanup = "    await rm(stagedTempPath, { force: true }).catch(() => undefined);"
assert section.count(cleanup) == 1
owner.write_text(source[:start] + section.replace(cleanup, "") + source[end:])
```

Run the same full-owner test command. Expected original control: 29 passing and one failure at `leaves no staged temporary file in the company home after a kept (not-fresher) outcome`; verbose diff shows actual `.auth-<pid>-<uuid>.tmp` and `auth.json` versus the fixed expected `["auth.json"]`.

Apply `/tmp/grok-candidate.patch` and run the same command under unchanged mutated production. Expected keeper control: 28 passing and one failure at `keeps the home when the login is older than the existing same-identity credential`, with the same actual-directory mismatch.

Always restore `packages/adapters/grok-local/src/server/adapter-auth-promotion.ts` from the exact proof-base commit in a finally/trap cleanup, even when either deliberately failing command exits 1. Leave the candidate test applied and rerun the same full-owner command: 29 passing cases. Confirm restored production SHA256 equals the value above. The mutation intentionally changes only the second writer's cleanup line; removing the first writer's cleanup or its handle-close line is a different control and must not be substituted.

For combined integration, apply the other three proven test patches plus this Grok patch to a fresh exact #16106 checkout, require each `git apply --check` to succeed, and run the same full Grok-owner command: 29 passing. No production mutation remains during this positive check.

The candidate patch is reproducible from the exact proof base and reviewed branch with the fetch/diff command above. Detailed raw phase logs and JSON remain in the original isolated proof workspace and are not claimed as checked-in deliverables. The mutation and restore steps below are fully specified. No broader typecheck/build/default-suite success claim.
