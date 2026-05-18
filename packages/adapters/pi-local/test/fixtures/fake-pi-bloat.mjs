#!/usr/bin/env node
/**
 * Fake pi-coding-agent that emits a deterministic NDJSON stream simulating
 * the O(n²) accumulated-state bloat we observed in APE-213.
 *
 * Each `thinking_delta` event includes a `delta` field whose payload grows
 * by a fixed increment per event, modeling pi-agent's --mode json behavior
 * (every line carries the full accumulated thinking text plus metadata).
 *
 * Used by buffered-on-log.bloat.test.ts to verify the wrapper filter keeps
 * persisted log size bounded regardless of upstream bloat.
 *
 * Args: --turns=N (default 100)  --increment=BYTES (default 1024)
 */
const args = Object.fromEntries(
  process.argv
    .slice(2)
    .map((a) => a.replace(/^--/, "").split("="))
    .filter((p) => p.length === 2),
);
const turns = Number.parseInt(args.turns ?? "100", 10);
const increment = Number.parseInt(args.increment ?? "1024", 10);
// Optional: emit a single `tool_execution_end` carrying an N-byte `result`,
// plus the duplicate copy in `turn_end.toolResults`. Models bash/shell tool
// output bloat. Default 0 keeps existing tests behavior-compatible.
const toolresultBytes = Number.parseInt(args["toolresult-bytes"] ?? "0", 10);

let accumulated = "";
let toolresultPayload = "";

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

emit({ type: "agent_start" });
emit({ type: "turn_start" });

for (let i = 0; i < turns; i++) {
  const chunk = `chunk-${i}-${"x".repeat(increment - 16)}`;
  accumulated += chunk;
  emit({
    type: "message_update",
    assistantMessageEvent: {
      type: "thinking_delta",
      // The `delta` carries the full accumulated state — mimics pi-agent's
      // observed behavior where each line includes everything so far.
      delta: chunk,
      accumulated,
    },
  });
}

emit({
  type: "message_update",
  assistantMessageEvent: {
    type: "thinking_end",
    content: accumulated,
  },
});

if (toolresultBytes > 0) {
  toolresultPayload = "y".repeat(toolresultBytes);
  emit({
    type: "tool_execution_start",
    toolCallId: "tc_bloat_1",
    toolName: "Bash",
    args: { command: "echo big" },
  });
  emit({
    type: "tool_execution_end",
    toolCallId: "tc_bloat_1",
    toolName: "Bash",
    result: toolresultPayload,
    isError: false,
  });
}

const finalText = "Done thinking. Here is the answer.";
emit({
  type: "turn_end",
  message: {
    role: "assistant",
    content: [{ type: "text", text: finalText }],
    usage: {
      input: 100,
      output: 50,
      cacheRead: 0,
      cost: { total: 0.001 },
    },
  },
  toolResults: toolresultBytes > 0
    ? [{ toolCallId: "tc_bloat_1", content: toolresultPayload, isError: false }]
    : [],
});

emit({
  type: "agent_end",
  messages: [
    {
      role: "assistant",
      content: [{ type: "text", text: finalText }],
    },
  ],
});
