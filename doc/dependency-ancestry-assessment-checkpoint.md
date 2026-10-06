# Dark dependency ancestry assessment checkpoint

The dark restoration coordinator now requires an explicit `clear` assessment from the shared tree service. `held` and `indeterminate` are vetoes before readiness, canonical update, and durable intent creation. Cycles, missing/cross-company ancestry and exhaustion of the 100-issue traversal budget are indeterminate. An empty hold snapshot does not skip strict ancestry traversal. The legacy nullable gate retains its empty-hold fast path and nullable results; production callers are not switched to strict assessment.

This is snapshot validation, NOT tree/graph writer serialization. Concurrent hold insertion, parent edits, gate changes and re-block/owner/relation races remain open. The coordinator is still UNWIRED. Production emitters, native ledger/statusVersion integration, caller effects publication, queue admission/revalidation, orphan expiry and the live 15-minute bound are not implemented here. No merge, deployment or activation is authorized.

## Observed verification

With API/DB/Forgejo credentials unset and profile scratch TMPDIR, the original focused cycle command timed out after 45 seconds (exit 124). Changed approach: forks pool, maxWorkers=1, PATH=/opt/homebrew/bin. Canonical suite then completed in 43.07 seconds: 9 PASS / 1 expected RED (`intent-1` instead of null). After implementation, canonical + coordinator completed in 50.63 seconds: 33 PASS, exit 0.

Six additional assessment controls were then added: missing ancestor with/without unrelated holds, cross-company projected ancestor, deep holds at depths 99/100, and a complete root at the last allowed depth. These final additional controls have NOT completed verification. The subsequent five-file combined run with forks/maxWorkers=1 timed out at 60 seconds (exit 124). Work stopped after the second timeout; no repeat, no full-suite PASS claim. The two original route/writer RED diagnostics were not removed, and no new result is claimed for them. Existing Vite configLoader/__dirname warning persists. Typecheck/full gates not run.

All fixtures are recording mocks, not PostgreSQL SQL/lock/concurrency/rollback evidence. The service receives the supplied transaction, but common writer fences are still required before wiring. The existing human-only request for disposable offline PostgreSQL scope remains pending and is neither replaced nor accepted. The delivery remains a draft checkpoint for independent review and later bounded test reproduction.
