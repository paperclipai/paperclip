# Fast response implementation and verification

## Finish line

Optional company-wide acknowledgements use existing API connections, preserve the normal agent turn, retain server-controlled provenance, and account for provider work exactly once. OpenRouter leads live verification; other providers are verified by HTTP contracts. Existing decision behavior remains unchanged.

## Implementation

- Company settings, shared API connection selection, model catalog/manual IDs, fixed sample test, availability and Costs history.
- SDK-backed direct generation across native providers and configured Messages, Responses, Chat Completions, Bedrock and local routes.
- Durable deduplicated accepted-turn requests with a three-second admission deadline, bounded workers, authorization and budget checks, one inference attempt, and restart quarantine.
- Platform receipts in task and agent chat, board chat and shared external intake/publication, excluded from completion, unanswered-turn recovery and interaction resolution.
- Small context prompts, source isolation for external destinations, provenance details and labeled agent context.

## Evidence collected

Isolated checkout `codex/fast-response`, app at `http://127.0.0.1:3109`, cloned database under `/private/tmp/paperclip-fast-response-home`.

- Live OpenRouter `openai/gpt-oss-120b` settings test: UI 0.95 seconds, 212 input / 31 output tokens, reported cost 0.00504 cents.
- Live task `DOT-302`: initial acknowledgement admitted in 1.013 seconds, 261 input / 38 output tokens, reported cost 0.006195 cents. Subsequent human turns also received receipts.
- The dedicated OpenCode/OpenRouter agent subsequently produced a substantive recommendation in the same task. Its real run succeeded. The receipt did not complete the task; final task status remained in progress because the agent did not mark it done.
- Provider and service tests cover duplicate workers, provenance/no fabricated run, unchanged task status, unanswered-turn protection, reply/cancel/delete/reassign/edit/revoke races, expiry, unknown billing and fixed sample isolation.
- Full build passed before final UI refinements. Full typecheck initially found two redundant bot comparisons; they were fixed and the final repository typecheck passed. The full test run was stopped after setup timeouts and failures in workspace-runtime/execution-workspace suites; it is not green evidence.

## Verification still required

- Final email/budget tests and build gate. Stream/reset/sponsorship tests, 40 provider contracts, Slack/GitHub contracts, token gates and repository typecheck passed.
- Live Slack bot creation and conversation; browser login completed. A narrow callback relay is prepared. Cloudflare tunneling was rejected by automatic approval review; explicit user authorization is pending.
- Live GitHub test journey in `paperclipai/paperclip-permissions-smoke-20260926-pap57-fee7428e`.
- Final migration ordering against master, review and repository checks.

No credentials or prompt bodies belong in this record.
