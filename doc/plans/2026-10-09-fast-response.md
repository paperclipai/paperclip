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
- Full build passed after rebasing onto master, including the final UI refinements. Repository typecheck passed before the rebase; a fresh check is running. The full test run was stopped after setup timeouts and failures in workspace-runtime/execution-workspace suites; it is not green evidence.
- All 40 provider contracts passed. Slack/GitHub shared intake/outbox contracts and the email reply-only outbox contract passed. Token gates passed after rebase. The regenerated migration follows master migration 0322 and passes migration safety checks.
- Final review corrected accepted/queued wording: a run serving the current turn does not count as older work. Email uses the same state check.

## Verification still required

- Final focused regression rerun and post-rebase typecheck. The previous service run had two test timeouts under concurrent build load; these require a clean rerun.
- Live Slack bot creation and conversation; browser login completed. A narrow callback relay is prepared. Cloudflare tunneling was rejected by automatic approval review; explicit user authorization is pending.
- Live GitHub test journey in `paperclipai/paperclip-permissions-smoke-20260926-pap57-fee7428e`.
- Review and remaining repository checks. The isolated app also encountered an unrelated startup recovery error in a copied historical run (`in_progress issues require an assignee`); preserve its live evidence while repairing startup.

No credentials or prompt bodies belong in this record.
