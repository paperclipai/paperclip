# Prompt Injection Prevention delivery

Branch: `codex/prompt-injection-prevention`. Rebased base: `1f3695ac67`.
Endpoint: one reviewable PR; no shared-instance deployment.

The company opts in to a shared OpenRouter connection, defaulting to
`openai/gpt-oss-safeguard-20b`. Existing tool-result guards prefer a valid model
verdict, fall back to the original regex on classified dependency failures,
and preserve signing, return values, authorization and accounting.

| Acceptance | Required evidence | State |
| --- | --- | --- |
| Strict provider policy/parser, full redacted input, cancellation | Controlled HTTP tests and bounded live corpus | HTTP tests pass; all nine final-policy corpus examples returned correct live verdicts across bounded runs |
| Company settings, stale selections, permissions | Database/API tests | Passing |
| Budget admission, charges, recovery, retained holds | Database tests | Twenty-four database/API tests pass, including configuration race, cancellation, and credential-provider failure |
| Existing six gateway boundaries and replay | Service integration tests | All six paths pass; blocked virtual-result HTTP mapping verified |
| Connections always visible, draft/save/test | UI tests and isolated running app | UI journey passes; both fixed model samples and real gateway benign/attack checks pass on reviewed revision `e88bc3da18` |
| Documentation, maps, stories, required checks | Commands and PR evidence | Migration, tokens, maps, catalog, full typecheck/build passed. PR holds final full-suite and review status |

The isolated test-drive uses a disposable company and the local board role.
Fast Responses was off for initial navigation and enabled to verify section order.
The shared OpenRouter connection was seeded through the normal API using an
authorized local key. All model requests used the official live OpenRouter
endpoint. With the initial policy, both fixed samples passed (0.99 and 0.80 seconds). A real gateway
echo returned the original benign diff and blocked the model-only instruction
override. Persisted classifier, cost, and gateway event rows were checked.
A deliberately invalid model exercised regex fallback, including an attack
beyond 4,000 characters. Disabling model use produced no classifier invocation.
GitHub write replay and delayed-provider cancellation use controlled fixtures.

The final policy adds explicit definitions and labeled examples. After initial
rate-limited attempts, all nine corpus examples returned their expected verdicts
across bounded runs. On reviewed revision `e88bc3da18`, both fixed samples
passed (0.54 and 1.11 seconds); the real gateway returned the complete benign
diff and blocked the instruction override with `prompt_injection_blocked`.
The classifier records, independent cost events, and model detector metadata
were inspected. No incorrect live model verdict was observed.

Retained failures: earlier OpenRouter HTTP 429 responses used regex fallback,
reproducing the original regex false positive and missed attack. These are
dependency failures, not accuracy passes; later successes do not erase them.
The first test-drive PostgreSQL initialization and one later focused database
suite initialization failed; standalone initdb probes and subsequent launches
succeeded. Those initialization causes remain unresolved. A later preview
restart reported PostgreSQL semaphore exhaustion explicitly. Reducing only
the disposable instance's `max_connections` from 100 to 20 restored the preview;
no system limits or shared instances were changed.
The running preview was not deployed to the shared development instance.

PR: https://github.com/paperclipai/paperclip/pull/16976.
CI found missing OpenAPI inventory coverage and an outdated General-settings
expectation; both are fixed and tested. Review found credential-outage fallback
and a stale decision-history link; both are fixed, with 121 focused regression
tests passing. The final check/review status is maintained in the PR to avoid
making a mutable build-status claim in this implementation note.

Use pinned pnpm 9.15.4; do not commit the lockfile.
