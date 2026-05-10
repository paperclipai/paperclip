import { describe, expect, it } from "vitest";
import { PI_DELTA } from "./parse.js";
import { createBufferedOnLog, type LogStream } from "./buffered-on-log.js";

interface Captured {
  stream: LogStream;
  chunk: string;
}

function captureSink() {
  const captured: Captured[] = [];
  const onLog = async (stream: LogStream, chunk: string) => {
    captured.push({ stream, chunk });
  };
  return { captured, onLog };
}

const deltaLine = (type: string, delta: string) =>
  JSON.stringify({
    type: "message_update",
    assistantMessageEvent: { type, delta },
  });

describe("createBufferedOnLog", () => {
  it("forwards complete non-delta stdout lines and drops delta lines", async () => {
    const { captured, onLog } = captureSink();
    const { handle } = createBufferedOnLog(onLog);

    await handle("stdout", JSON.stringify({ type: "agent_start" }) + "\n");
    await handle("stdout", deltaLine(PI_DELTA.thinking, "thinking ...") + "\n");
    await handle("stdout", deltaLine(PI_DELTA.text, "hi") + "\n");
    await handle("stdout", deltaLine(PI_DELTA.toolcall, "{}") + "\n");
    await handle(
      "stdout",
      JSON.stringify({ type: "turn_end", message: { role: "assistant", content: "done" } }) + "\n",
    );
    await handle("stdout", JSON.stringify({ type: "agent_end", messages: [] }) + "\n");

    const stdout = captured.filter((c) => c.stream === "stdout").map((c) => c.chunk);
    expect(stdout).toHaveLength(3);
    expect(stdout[0]).toContain('"agent_start"');
    expect(stdout[1]).toContain('"turn_end"');
    expect(stdout[2]).toContain('"agent_end"');
    expect(stdout.join("")).not.toContain("thinking_delta");
    expect(stdout.join("")).not.toContain("text_delta");
    expect(stdout.join("")).not.toContain("toolcall_delta");
  });

  it("preserves event order across drops", async () => {
    const { captured, onLog } = captureSink();
    const { handle } = createBufferedOnLog(onLog);

    const events = [
      JSON.stringify({ type: "agent_start" }),
      deltaLine(PI_DELTA.thinking, "a"),
      JSON.stringify({ type: "tool_execution_start", toolCallId: "t1", toolName: "read" }),
      deltaLine(PI_DELTA.text, "b"),
      JSON.stringify({ type: "tool_execution_end", toolCallId: "t1", result: "ok" }),
      JSON.stringify({ type: "agent_end", messages: [] }),
    ].join("\n");
    await handle("stdout", events + "\n");

    const stdout = captured.filter((c) => c.stream === "stdout").map((c) => c.chunk);
    expect(stdout.map((c) => JSON.parse(c).type)).toEqual([
      "agent_start",
      "tool_execution_start",
      "tool_execution_end",
      "agent_end",
    ]);
  });

  it("reassembles chunk splits inside a thinking_delta line and still drops it", async () => {
    const { captured, onLog } = captureSink();
    const { handle } = createBufferedOnLog(onLog);

    const big = deltaLine(PI_DELTA.thinking, "a".repeat(1000));
    // Split the line in three arbitrary places (no internal newline).
    const cuts = [Math.floor(big.length / 3), Math.floor((2 * big.length) / 3)];
    const parts = [big.slice(0, cuts[0]), big.slice(cuts[0], cuts[1]), big.slice(cuts[1])];

    await handle("stdout", parts[0]);
    await handle("stdout", parts[1]);
    await handle("stdout", parts[2] + "\n");
    await handle("stdout", JSON.stringify({ type: "agent_end", messages: [] }) + "\n");

    const stdout = captured.filter((c) => c.stream === "stdout");
    expect(stdout).toHaveLength(1);
    expect(stdout[0].chunk).toContain('"agent_end"');
  });

  it("forwards stderr immediately and unchanged regardless of content", async () => {
    const { captured, onLog } = captureSink();
    const { handle } = createBufferedOnLog(onLog);

    const noise = '[paperclip] mentions "thinking_delta" but is not pi NDJSON\n';
    await handle("stderr", noise);
    await handle("stderr", "another line without trailing newline");

    const stderr = captured.filter((c) => c.stream === "stderr");
    expect(stderr).toEqual([
      { stream: "stderr", chunk: noise },
      { stream: "stderr", chunk: "another line without trailing newline" },
    ]);
  });

  it("flush() emits the trailing partial stdout line as-is", async () => {
    const { captured, onLog } = captureSink();
    const { handle, flush } = createBufferedOnLog(onLog);

    await handle("stdout", '{"type":"agent_start"}\n{"type":"agent_end"');
    // No trailing newline; agent_end is buffered.
    expect(captured).toHaveLength(1);
    expect(captured[0].chunk).toContain('"agent_start"');

    await flush();
    expect(captured).toHaveLength(2);
    expect(captured[1].chunk).toBe('{"type":"agent_end"');
  });

  it("flush() is a no-op when buffer is empty", async () => {
    const { captured, onLog } = captureSink();
    const { handle, flush } = createBufferedOnLog(onLog);

    await handle("stdout", '{"type":"agent_end"}\n');
    expect(captured).toHaveLength(1);

    await flush();
    expect(captured).toHaveLength(1);
  });

  it("forwards malformed JSON lines (passthrough on parse failure)", async () => {
    const { captured, onLog } = captureSink();
    const { handle } = createBufferedOnLog(onLog);

    // Line that mentions _delta but isn't valid JSON — must pass through.
    await handle("stdout", '{"type":"message_update","oops":"thinking_delta"_broken\n');

    const stdout = captured.filter((c) => c.stream === "stdout");
    expect(stdout).toHaveLength(1);
    expect(stdout[0].chunk).toContain("thinking_delta");
  });
});
