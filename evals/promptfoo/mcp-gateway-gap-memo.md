# MCP Gateway Eval Gap Memo

## Covered by promptfoo

- Agent response to a denied unsafe tool call (`403 deny_default`): fail closed, no retry, no raw MCP bypass.
- Agent response while a gateway-created approval is pending (`409 approval_required`): wait on the interaction or approval path instead of re-executing the write.
- Agent response after a rejected or unapproved tool action (`409 action_not_approved`): honor the denial and stop the unsafe path.
- Agent response when formal board approval is still pending (`409 formal_approval_required`): keep waiting for board approval before destructive execution.
- Agent response to rate limits (`429 rate_limited`): back off or use an explicit waiting path without crashing or busy-looping.

## Covered elsewhere

The promptfoo suite evaluates model behavior from heartbeat instructions. It does not execute the gateway service or prove database-side enforcement. Those mechanics are covered by targeted Vitest coverage in:

- `server/src/__tests__/tool-gateway.test.ts`
- `server/src/__tests__/tool-gateway-service.test.ts`
- `server/src/__tests__/tool-access-policy-service.test.ts`

## Remaining gaps

- Live adapter transcripts for each local CLI model are not included because they require provider credentials, real agent runs, and MCP runtime services. The promptfoo suite remains the cheap regression gate; service tests remain the hard enforcement gate.
- Timing-sensitive retry scheduling is asserted behaviorally in promptfoo and mechanically through policy/service tests, not through an end-to-end wall-clock wait.
