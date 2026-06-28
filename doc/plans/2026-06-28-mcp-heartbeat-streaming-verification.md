# MCP Heartbeat Streaming Verification

## Scope

PEN-1191 coordinates the transport-level MCP resource streaming work for Paperclip heartbeat run output. The implementation was split across focused dependency issues and merged back to `master` before this verification pass.

## Integrated Pull Requests

- `#513` / PEN-1195: bridge-safe read-only heartbeat-run routes.
- `#514` / PEN-1192: stdio heartbeat-run resources and fallback tail tool.
- `#517` / PEN-1194: Streamable HTTP MCP heartbeat-run resources and notifications.
- `#519` / PEN-1193: stdio heartbeat-run resource subscription lifecycle.

## Verified Contract

- Stdio MCP reads expose run metadata, log metadata, resumable log chunks, events, and touched issues.
- Stdio MCP subscriptions emit `notifications/resources/updated` as change signals and clean up on unsubscribe, close, terminal run state, and polling/send failures.
- Streamable HTTP MCP sessions expose the same resources and deliver resource update notifications over the HTTP/SSE session path; clients without subscription support use the fallback tail tool for polling instead of receiving server-pushed updates.
- `paperclipTailHeartbeatRunLog` remains available for clients without resource subscription support.
- Bridge-only runtimes can read the heartbeat-run routes required by MCP resources while heartbeat-run mutation routes remain denied.

## Verification Commands

Run from the repository root:

```sh
pnpm --filter @paperclipai/mcp-server test
pnpm --filter @paperclipai/mcp-external test
pnpm exec vitest run packages/adapter-utils/src/sandbox-callback-bridge.test.ts
```

Verified on 2026-06-28:

- `@paperclipai/mcp-server`: 3 files, 44 tests passed.
- `@paperclipai/mcp-external`: 5 files, 98 tests passed.
- `packages/adapter-utils/src/sandbox-callback-bridge.test.ts`: 1 file, 14 tests passed.

## Regression Test Path

- Failures in `@paperclipai/mcp-server` tests indicate a stdio resource read, fallback tail tool, or subscription lifecycle regression.
- Failures in `@paperclipai/mcp-external` tests indicate a Streamable HTTP resource read or HTTP/SSE notification regression.
- Failures in `packages/adapter-utils/src/sandbox-callback-bridge.test.ts` indicate a bridge callback allowlist regression for heartbeat-run read routes or denied mutation routes.
