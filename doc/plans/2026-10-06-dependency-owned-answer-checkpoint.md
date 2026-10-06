# Dark owned question-answer checkpoint

Source-only, unwired root-owned answerQuestionsWithLifecycleFence now captures effective routing, input and audience restriction before transaction startup. Its callback reuses actual supplied canonical answer, company fence, issue/card locks, audience evaluator, answer CAS and delivery INSERT. Supplied capture is shared rather than reimplemented. Ordinary path is unchanged.

Actual root identity remains a caller precondition. Do not wrap an existing tx under earlier locks. Return is delayed until outer transaction resolves. Caller still owns postcommit delivery dispatch, touch and telemetry; this is not native settlement, provider delivery or authenticated answer authority.

Server cwd verification, env without PAPERCLIP_API_KEY/DATABASE_URL/FORGEJO_TOKEN and TMPDIR pointing to profile scratch:

/opt/homebrew/bin/node ../node_modules/vitest/vitest.mjs run --config vitest.config.ts src/__tests__/interaction-lifecycle-answer.test.ts src/__tests__/interaction-lifecycle-withdraw.test.ts src/__tests__/interaction-lifecycle-withdraw-owned.test.ts src/__tests__/interaction-lifecycle-withdraw-native.test.ts --pool=forks --maxWorkers=1 --testTimeout=15000

Four files, 86 PASS, exit 0 (8.76s). Five added controls cover deferred startup containment/result barrier, inherited veto, missing-company/getter pre-effect rejection, delivery error and simulated outer commit rejection. Initial missing-export RED preceded implementation. Moving capture into callback produced two FAIL/24 skipped; initial mutant replay also exposed an unhandled observer cleanup flaw in the test. Finally releases and rejection observation fixed it; clean mutant replay two FAIL/24 skipped, no unhandled error (5.80s). Mutant removed.

Separate writer-boundary/human-gates recording: 19 PASS/one original missing durable-intent RED, exit 1 (7.19s). No route/listener replay, DB/embedded PG, adapter, typecheck/build/full gates. Eager answered/delivery rows survive simulated rejection: not SQL rollback or real commit. Agent-run and lost-CAS composition, native provider settlement, full common participant protocol, restoration production wiring, queue/orphan/live15min acceptance and separate conflict rebase/fresh-head validation remain incomplete. Pending human DB scope and activation gates unchanged.
