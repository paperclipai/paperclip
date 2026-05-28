# Tool Result Encoding

## Background

Early versions of this adapter double-encoded every tool result:

1. `paperclip-tools.ts` handlers returned `JSON.stringify(result)` — a compact, escape-quoted string.
2. `execute.ts` emitted the transcript entry via `JSON.stringify(entry)`, escape-quoting the already-stringified `content` a second time.

The result was opaque logs (`\"` noise throughout) and walls of escape sequences sent to the model.

## Current design

There is now a single serialization point per consumer.

### Tool handlers (`paperclip-tools.ts`)

All Paperclip API tool handlers return the **raw API response object** — no `JSON.stringify`. Workspace tools (`read_file`, `run_command`, etc.) continue to return plain strings, which is appropriate for shell output.

### Dispatch layer (`tools.ts`)

`ToolHandler.execute` returns `Promise<unknown>`. `ToolDispatchOutcome.content` is `unknown`.

`dispatchToolCall` stores object results as-is and applies truncation only to string results (shell output can be large; API response objects are bounded).

`serializeForModel(content: unknown): string` is the single function that converts any tool result to the string the OpenAI messages array requires. Objects are pretty-printed with `JSON.stringify(content, null, 2)` so the model receives readable structured data rather than a compact escaped blob.

### Transcript emit (`execute.ts`)

Tool result transcript entries are built as plain objects and passed directly to `JSON.stringify`, so `content` serializes as a nested JSON value rather than an escape-quoted string:

```
{"kind":"tool_result","toolName":"list_issues","content":{"id":"0763c37c","title":"Fix widget","status":"in_progress"},"isError":false}
```

All other entry kinds continue to go through the typed `emit` helper.

### UI parser (`ui-parser.ts`)

The local `tool_result` type uses `content: unknown` to match the wire format.

## Constraints respected

- **Single-line emit is preserved.** The `buildTranscript` pipeline in the UI splits stdout by newline and calls `parseStdoutLine` per line. Multi-line JSON would break parsing. Each entry remains one line.
- **Adapter-only change.** No shared packages (`adapter-utils`, `ui/`) were modified. This keeps the change self-contained on the `feat/openrouter-agent-adapter` branch.

## Files changed

```
packages/adapters/openrouter-agent/src/server/
  paperclip-tools.ts       — handlers return raw objects; formatApiError returns Record
  tools.ts                 — ToolHandler/ToolDispatchOutcome use unknown; serializeForModel added
  execute.ts               — tool_result emit bypasses typed helper; model message uses serializeForModel
src/
  ui-parser.ts             — content: unknown in tool_result variant
src/server/
  paperclip-tools.test.ts  — updated assertion to check raw object instead of JSON.parse(string)
```
