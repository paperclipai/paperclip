# 2026-04-12 Heartbeat Run Summary Rebaseline

Measured on synthesized issue comments after stripping command-result boilerplate:

- Prior issue comment on this payload: `137` chars, estimated `35` tokens
- Current issue comment on the same payload: `30` chars, estimated `8` tokens
- Paperclip -> model delta on this payload: `-107` chars, `-27` estimated input tokens

## Verification

- `pnpm vitest run server/src/__tests__/heartbeat-run-summary.test.ts -t "filters command-result boilerplate out of issue comments"`
- `pnpm --filter @paperclipai/server typecheck`

## Notes

- This slice trims Paperclip-owned issue comment replay without touching Hermes or server configuration.
- Hermes-specific prompt deltas are not instrumented in this restored checkout yet.
