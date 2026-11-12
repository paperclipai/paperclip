# Environment runtime test audit — 2026-10-12

Parent: #16083 (`codex/test-audit-r14-browser`), exact head
`1113d4c9eaa49311c9b269c96b79bbae06d42e25`.

## Change and keeper

`server/src/__tests__/environment-runtime.test.ts:1405–1420` repeats the local
projectless acquisition already executed by the lifecycle test at1371. Both
use the same `seedEnvironment()` call, runtime, suite hooks and acquisition
input. The seed/acquire statements are AST-identical. Both tests originated
in `70679a33216` (Add sandbox environment support, #4415).

Move the unique `lease.executionWorkspaceId` null assertion into the keeper
at1383. Keep the exact `leaseContext` equality, which already checks its two
null fields. Every original keeper statement remains unchanged and ordered.
The keeper also releases the lease and checks the durable released row.

One file: +2/-17 test lines, net15 fewer lines. One registered case and one
redundant seed/acquisition/setup/cleanup cycle disappear (162→161 cases).
No production behavior changes. Provider, SSH, company access, secret
resolution/redaction, timeout precedence, session and recovery cases remain.

## Exact-parent proof

| Phase | Passed | Failed | Filtered/pending |
|---|---|---|---|
| Full baseline | 162 | 0 | 0 |
| Full candidate | 161 | 0 | 0 |
| Unmutated keeper control | 1 | 0 | 160 |
| Production mutation, intended keeper | 0 | 1 | 160 |
| Owner restored, full candidate | 161 | 0 | 0 |
| All source reverted, full parent | 162 | 0 | 0 |

Proof-only production mutation at `environment-runtime.ts:4047`: acquisition
returns `lease: { ...lease, executionWorkspaceId: lease.executionWorkspaceId
?? input.environment.id }`. This real return-mapping fault leaves context and
DB setup intact. The relocated assertion at1383:49 rejects the environment
UUID because a projectless lease must return null. Production bytes were
restored before the full candidate replay. The mutation is not in this PR.

The first reverted run had a suite-level startup failure (3 pure tests passed,
159 DB cases pending, no assertion failure). JSON-only output omitted the
hook diagnostic. An unchanged-source rerun with the default reporter passed
162/162. The failed attempt remains in the temporary receipt. No CI speedup
is claimed from the single local samples.

## Hashes and receipts

- Parent test SHA-256: `a7370481526c91044a020cf0e56a5ab4f27a7289c6ee8bcf94e414d7b70ab35a`.
- Candidate test SHA-256: `39069f6d8261886b9c9521a7e3e5026051d90287b5e14c471d589fde384832e7`.
- Production owner SHA-256: `77da04770ef8e87dd868f90a65c10ae2322a95ad1d8d78e73facb1be3443c0f8`.
- Identical seed/acquisition AST SHA-256: `d25af395dc9775474276cefbedd2d736ddfca7c57263db5543c603e52b6f96d3`.

Full read: 7,223 lines, 100 declarations, 162 cases, two suites and four hooks.
The full ledger, case mapping, patch, preservation proof and JSON/log receipts
are in `/private/tmp/test-audit-environment-runtime/`.

Local verification uses the full owner with the unchanged server Vitest
configuration. Full repository test/build preflight is deferred to isolated
CI because this audit worktree shares dependency symlinks and preflight
rewrites workspace package links. CI must pass before a green handoff.
