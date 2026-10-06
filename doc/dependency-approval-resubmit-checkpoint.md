# Dark canonical approval resubmission checkpoint

The opt-in resubmit lifecycle is source/mock-only, not production activation.
Ordinary routes still call resubmit(id, payload) without an opt-in. No approval
is decided, no hire effects are applied and no dependent is restored here.

The canonical owned opt-in starts a transaction before domain reads. The supplied
entry captures company/approval routing and JSON payload before suspension,
awaits the company lifecycle fence and uses shared canonical persistence.
The scoped UPDATE requires revision_requested and company, and rejects empty
RETURNING. Ordinary omitted/false callers retain ID-only reads/writes, non-owning
execution, nullish payload fallback and undefined on empty RETURNING.

Payload snapshots use the actual approvals.payload driver encoder/decoder before
owned transaction startup and supplied fence suspension. Null/undefined caller
payload retains the authoritative existing payload. A non-null value encoding
JSON null or absent output is deliberately rejected with 422 before effects;
this restricted dark contract does not preserve those exotic inputs. Driver-
compatible toJSON, nested arrays and Date materialize before waits. Cyclic JSON
propagates encoding rejection before effects. No schema or authorization claim.

Verification (server cwd, env without PAPERCLIP_API_KEY/DATABASE_URL/FORGEJO_TOKEN,
TMPDIR set to profile scratch, /opt/homebrew/bin/node ../node_modules/vitest/vitest.mjs
run --config vitest.config.ts <explicit files> --pool=forks --maxWorkers=1
--testTimeout=15000): initial ownership contract 1 expected RED, then 7 PASS with
approvals-service. Payload containment 2 expected RED/1 PASS; null/absent encoding
4 expected RED/3 skipped; after snapshots 7 PASS. Expanded new suite 41 controls,
five approval suites 108 PASS/8.13s. Missing-await mutant 2 FAIL/39 skipped/2.04s,
removed. Twenty explicit participant suites 453 PASS/24.92s. Original writer,
route and selector-characterization suites 27 PASS/2 known RED/10.89s: ordinary
route remains blocked and ordinary writer lacks durable intent. No timeout.

Builder predicates and synthetic outcomes do not execute SQL filters or establish
CAS/exclusion, authorization, concurrency, rollback or common serialization.
Error propagation is not rollback. Driver recording is not database persistence.
Typecheck/build/full gates were not run. Other approval create/decisions/interaction
writers and remaining lifecycle/native/finalize participants, ledger/statusVersion,
effects/publication/legacy intents and restoration production wiring remain.
Queue admission/revalidation/orphan expiry and approved live fifteen-minute bound
remain incomplete. Keep queue hygiene; no merge/deploy/activation approval.
