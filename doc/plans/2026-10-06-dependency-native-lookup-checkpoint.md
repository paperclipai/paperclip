# Dark native cancellation lookup checkpoint

SOURCE/MOCK only, no production caller, DB, listener, adapter, activation or approval decision.

The supplied transaction lookup captures only fields consumed by authorizedNativeRun before awaiting the company lifecycle fence. It performs the actual canonical scoped run SELECT and returns the ordinary queued/running eligibility result without storing a marker, issuing cancellation or returning an authorization receipt. The marker participant now shares that private identity capture; its fence and persistence remain unchanged. The root must acquire the company fence before earlier domain locks. Returning an ID for another transaction does not preserve this snapshot and is not permission to cancel a provider.

Test runner (cwd server): env -u PAPERCLIP_API_KEY -u DATABASE_URL -u FORGEJO_TOKEN TMPDIR=<infra-profile-scratch> /opt/homebrew/bin/node ../node_modules/vitest/vitest.mjs run --config vitest.config.ts <explicit files> --pool=forks --maxWorkers=1 --testTimeout=15000.

Initial focused test: 1 expected missing-export RED / 30 skipped, 4.50s. First implementation: 31 PASS, 4.17s. Expanded terminal/terminal-expiry/publication/ownership files: 80 PASS, 8.36s. Temporary missing-await lookup mutation: 1 FAIL / 39 skipped, 4.04s (heartbeat read before fence release); removed. Final 29 explicit participant suites: 692 PASS, 31.44s, exit 0. Terminal file contains 40 controls, ten more than prior head. Original writer/human characterization: 19 PASS / 1 unchanged known RED, 5.80s, exit 1; ordinary blocker writer still stores no durable dependency intent.

New controls cover scoped SQL rendering, no marker/live effect, suspended fence identity mutation, fence and read error identity, missing-company denial, invalid binding, queued/running/non-live results and ordinary nonfenced lookup parity. Synthetic returned rows do not execute SQL filtering or prove authenticated authority, locks, concurrency, commit, rollback, native ledger/recovery sweep or provider cancellation. No typecheck, build, full gates or route/listener replay.

Restoration remains unwired. Interaction lifecycle, hire effects and other common participants/native ledger/effects/legacy intents, production wiring and queue admission/revalidation/orphan/live15min acceptance remain incomplete. The open draft conflicts with upstream and needs separate rebase plus fresh validation/review. Pending human-only offline PostgreSQL scope remains unchanged; code/mock work is allowed, DB tests and activation are not authorized by this checkpoint.
