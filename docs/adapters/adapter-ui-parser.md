---
title: Adapter UI Parser Contract
summary: Ship a custom run-log parser so the Paperclip UI renders your adapter's output correctly
---

When Paperclip runs an agent, stdout is streamed to the UI in real time. The UI needs a **parser** to convert raw stdout lines into structured transcript entries (tool calls, tool results, assistant messages, system events). Without a custom parser, the UI falls back to a generic shell parser that treats every non-system line as `assistant` output — tool commands leak as plain text, durations are lost, and errors are invisible.

## The Problem

Most agent CLIs emit structured stdout with tool calls, progress indicators, and multi-line output. For example:

```
[hermes] Session resumed: abc123
┊ 💬 Thinking about how to approach this...
┊ $ ls /home/user/project
┊ [done] $ ls /home/user/project — /src /README.md  0.3s
┊ 💬 I see the project structure. Let me read the README.
┊ read /home/user/project/README.md
┊ [done] read — Project Overview: A CLI tool for...  1.2s
The project is a CLI tool. Here's what I found:
- It uses TypeScript
- Tests are in /tests
```

Without a parser, the UI shows all of this as raw `assistant` text — the tool calls and results are indistinguishable from the agent's actual response.

With a parser, the UI renders:

- `Thinking about how to approach this...` as a collapsible thinking block
- `$ ls /home/user/project` as a tool call card (collapsed)
- `0.3s` duration as a tool result card
- `The project is a CLI tool...` as the assistant's response

## How It Works

```
┌──────────────────┐     package.json        ┌──────────────────┐
│  Adapter Package  │─── exports["./ui-parser"] ──→│  dist/ui-parser.js │
│  (npm / local)    │                          │  (zero imports)  │
└──────────────────┘                          └────────┬─────────┘
                                                       │ plugin-loader reads at startup
                                                       ▼
┌──────────────────┐   GET /api/:type/ui-parser.js   ┌──────────────────┐
│  Paperclip Server  │◄────────────────────────────────│  uiParserCache    │
│  (in-memory)      │                                 └──────────────────┘
└────────┬─────────┘
         │ serves JS to browser
         ▼
┌──────────────────┐   fetch() + eval   ┌──────────────────┐
│  Paperclip UI     │─────────────────────→│  parseStdoutLine │
│  (dynamic loader) │   registers parser  │  (per-adapter)   │
└──────────────────┘                     └──────────────────┘
```

1. **Build time** — You compile `src/ui-parser.ts` to `dist/ui-parser.js` (zero runtime imports)
2. **Server startup** — Plugin loader reads the file and caches it in memory
3. **UI load** — When the user opens a run, the UI fetches the parser from `GET /api/:type/ui-parser.js`
4. **Runtime** — The fetched module is eval'd and registered. All subsequent lines use the real parser

## Contract: package.json

### 1. `paperclip.adapterUiParser` — contract version

```json
{
  "paperclip": {
    "adapterUiParser": "1.0.0"
  }
}
```

The Paperclip host checks this field. If the major version is unsupported, the host logs a warning and falls back to the generic parser instead of executing potentially incompatible code.

| Host expects | Adapter declares | Result |
|---|---|---|
| `1.x` | `1.0.0` | Parser loaded |
| `1.x` | `2.0.0` | Warning logged, generic parser used |
| `1.x` | (missing) | Parser loaded (grace period — future versions may require it) |

### 2. `exports["./ui-parser"]` — file path

```json
{
  "exports": {
    ".": "./dist/server/index.js",
    "./ui-parser": "./dist/ui-parser.js"
  }
}
```

## Contract: Module Exports

Your `dist/ui-parser.js` must export **at least one** of:

### `parseStdoutLine(line: string, ts: string): TranscriptEntry[]`

Static parser. Called for each line of adapter stdout.

```ts
export function parseStdoutLine(line: string, ts: string): TranscriptEntry[] {
  if (line.startsWith("[my-agent]")) {
    return [{ kind: "system", ts, text: line }];
  }
  return [{ kind: "assistant", ts, text: line }];
}
```

### `createStdoutParser(): { parseLine(line, ts): TranscriptEntry[]; reset(): void }`

Stateful parser factory. Preferred if your parser needs to track multi-line continuation, command nesting, or other cross-call state.

```ts
let counter = 0;

export function createStdoutParser() {
  let suppressContinuation = false;

  function parseLine(line: string, ts: string): TranscriptEntry[] {
    const trimmed = line.trim();
    if (!trimmed) return [];

    if (suppressContinuation) {
      if (/^[\d.]+s$/.test(trimmed)) {
        suppressContinuation = false;
        return [];
      }
      return []; // swallow continuation lines
    }

    if (trimmed.startsWith("[tool-done]")) {
      const id = `tool-${++counter}`;
      suppressContinuation = true;
      return [
        { kind: "tool_call", ts, name: "shell", input: {}, toolUseId: id },
        { kind: "tool_result", ts, toolUseId: id, content: trimmed, isError: false },
      ];
    }

    return [{ kind: "assistant", ts, text: trimmed }];
  }

  function reset() {
    suppressContinuation = false;
  }

  return { parseLine, reset };
}
```

If both are exported, `createStdoutParser` takes priority.

## Contract: TranscriptEntry

Each entry must match one of these discriminated union shapes:

```ts
// Assistant message
{ kind: "assistant"; ts: string; text: string; delta?: boolean }

// Thinking / reasoning
{ kind: "thinking"; ts: string; text: string; delta?: boolean }

// User message (rare — usually from agent-initiated prompts)
{ kind: "user"; ts: string; text: string }

// Tool invocation
{ kind: "tool_call"; ts: string; name: string; input: unknown; toolUseId?: string }

// Tool result
{ kind: "tool_result"; ts: string; toolUseId: string; content: string; isError: boolean }

// System / adapter messages
{ kind: "system"; ts: string; text: string }

// Stderr / errors
{ kind: "stderr"; ts: string; text: string }

// Raw stdout (fallback)
{ kind: "stdout"; ts: string; text: string }
```

### Linking tool calls to results

Use `toolUseId` to pair `tool_call` and `tool_result` entries. The UI renders them as collapsible cards.

```ts
const id = `my-tool-${++counter}`;
return [
  { kind: "tool_call", ts, name: "read", input: { path: "/src/main.ts" }, toolUseId: id },
  { kind: "tool_result", ts, toolUseId: id, content: "const main = () => {...}", isError: false },
];
```

### Error handling

Set `isError: true` on tool results to show a red indicator:

```ts
{ kind: "tool_result", ts, toolUseId: id, content: "ENOENT: no such file", isError: true }
```

## Constraints

1. **Zero runtime imports.** Your file is loaded via `URL.createObjectURL` + dynamic `import()` in the browser. No `import`, no `require`, no top-level `await`.

2. **No DOM / Node.js APIs.** Runs in a browser sandbox. Use only vanilla JS (ES2020+).

3. **No side effects.** Module-level code must not modify globals, access `window`, or perform I/O. Only declare and export functions.

4. **Deterministic.** Given the same `(line, ts)` input, the same output must be produced. This matters for log replay.

5. **Error-tolerant.** Never throw. Return `[{ kind: "stdout", ts, text: line }]` for any line you can't parse, rather than crashing the transcript.

6. **File size.** Keep under 50 KB. This is served per-request and eval'd in the browser.

## Lifecycle

| Event | What happens |
|---|---|
| Server starts | Plugin loader reads `exports["./ui-parser"]`, reads the file, caches in memory |
| UI opens run | `getUIAdapter(type)` called. If no built-in parser, kicks off async `fetch(/api/:type/ui-parser.js)` |
| First lines arrive | Generic process parser handles them immediately (no blocking). Dynamic parser loads in background |
| Parser loads | `registerUIAdapter()` called. All subsequent line parsing uses the real parser |
| Parser fails (404, eval error) | Warning logged to console. Generic parser continues. Failed type is cached — no retries |
| Server restart | In-memory cache is repopulated from adapter packages |

## Error Behavior

| Failure | What happens |
|---|---|
| Module syntax error (import fails) | Caught, logged, falls back to generic parser. No retries. |
| Returns wrong shape | Individual entries with missing fields are silently ignored by the transcript builder. |
| Throws at runtime | Caught per-line. That line falls back to generic. Parser stays registered for future lines. |
| 404 (no ui-parser export) | Type added to failed-loads set. Generic parser from first call onward. |
| Contract version mismatch | Server logs warning, skips loading. Generic parser used. |

## Building

```sh
# Compile TypeScript to JavaScript
tsc src/ui-parser.ts --outDir dist --target ES2020 --module ES2020 --declaration false
```

Your `tsconfig.json` can handle this automatically — just make sure `ui-parser.ts` is included in the build and outputs to `dist/ui-parser.js`.

## Testing

Test your parser locally by running it against sample stdout:

```ts
// test-parser.ts
import { createStdoutParser } from "./dist/ui-parser.js";

const parser = createStdoutParser();
const sampleLines = [
  "[my-agent] Starting session abc123",
  "Thinking about the task...",
  "$ ls /home/user/project",
  "[done] $ ls — /src /README.md  0.3s",
  "I'll read the README now.",
  "Error: file not found",
];

for (const line of sampleLines) {
  const entries = parser.parseLine(line, new Date().toISOString());
  for (const entry of entries) {
    console.log(`  ${entry.kind}:`, entry.text ?? entry.name ?? entry.content);
  }
}
```

Run with: `npx tsx test-parser.ts`

## Skipping the UI Parser

If your adapter's stdout is simple (no tool markers, no special formatting), you can skip the UI parser entirely. The generic `process` parser will handle it — every non-system line becomes `assistant` output. This is fine for:

- Agents that output plain text responses
- Custom scripts that just print results
- Simple CLIs without structured output

To skip it, simply don't include `exports["./ui-parser"]` in your `package.json`.

## Next Steps

- [External Adapters](/adapters/external-adapters) — full guide to building adapter packages
- [Creating an Adapter](/adapters/creating-an-adapter) — adapter internals and built-in integration
