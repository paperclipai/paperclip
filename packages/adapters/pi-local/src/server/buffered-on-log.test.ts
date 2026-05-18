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

  it("serializes concurrent handle calls — buffer cannot interleave between async chunks", async () => {
    // Drive a slow onLog: each call resolves on its own microtask. If handle
    // calls were not serialized, two concurrent invocations would mutate
    // stdoutBuffer between split() and pop(), producing garbled output.
    const captured: Captured[] = [];
    let pending = 0;
    let maxPending = 0;
    const onLog = async (stream: LogStream, chunk: string) => {
      pending += 1;
      maxPending = Math.max(maxPending, pending);
      // One microtask delay simulates the appendFile await in production.
      await Promise.resolve();
      captured.push({ stream, chunk });
      pending -= 1;
    };
    const { handle, flush } = createBufferedOnLog(onLog);

    // Fire-and-forget two overlapping calls (no await between them) and
    // ensure the buffer reassembles correctly.
    const eventA = JSON.stringify({ type: "agent_start" });
    const eventB = JSON.stringify({ type: "turn_start" });
    const eventC = JSON.stringify({ type: "agent_end", messages: [] });
    void handle("stdout", `${eventA}\n${eventB.slice(0, 8)}`);
    void handle("stdout", `${eventB.slice(8)}\n${eventC}\n`);
    await flush();

    expect(maxPending).toBe(1);
    expect(captured.map((c) => JSON.parse(c.chunk).type)).toEqual([
      "agent_start",
      "turn_start",
      "agent_end",
    ]);
  });

  it("flush() waits for any in-flight handle() before draining the trailing fragment", async () => {
    let order: string[] = [];
    const onLog = async (_stream: LogStream, chunk: string) => {
      // Force scheduling so handle's await is observable.
      await Promise.resolve();
      order.push(chunk.trim());
    };
    const { handle, flush } = createBufferedOnLog(onLog);

    void handle("stdout", '{"type":"agent_start"}\n');
    void handle("stdout", '{"type":"agent_end"');
    await flush();

    expect(order).toEqual(['{"type":"agent_start"}', '{"type":"agent_end"']);
  });

  it("truncates the partial-line buffer when a single fragment exceeds the cap", async () => {
    const { captured, onLog } = captureSink();
    const { handle } = createBufferedOnLog(onLog);

    // Push 65 MiB of pi-agent gibberish without any newline — above the
    // 64 MiB MAX_LINE_BYTES cap. The buffer must be dropped before it eats
    // RAM, and a stderr alarm must fire. (Realistic tool results below the
    // cap get bounded by the per-line rewriteToolResultLine instead.)
    const giant = "x".repeat(65 * 1024 * 1024);
    await handle("stdout", giant);
    // A subsequent newline-terminated line should be processable normally.
    await handle("stdout", '{"type":"agent_end","messages":[]}\n');

    const stderr = captured.filter((c) => c.stream === "stderr");
    expect(stderr).toHaveLength(1);
    expect(stderr[0].chunk).toMatch(/dropped \d+ bytes from pi stdout buffer/);
    const stdout = captured.filter((c) => c.stream === "stdout");
    expect(stdout).toHaveLength(1);
    expect(stdout[0].chunk).toContain('"agent_end"');
  });

  it("does not drop complete lines when one batched stdout chunk exceeds the cap", async () => {
    // Sandbox runners forward result.stdout in one onLog("stdout", ...) call.
    // Builds a single chunk of 105 normal-sized lines totaling >8MB and
    // verifies all lines are forwarded (no truncation alarm).
    const { captured, onLog } = captureSink();
    const { handle } = createBufferedOnLog(onLog);

    const padding = "x".repeat(80 * 1024); // ~80KB per line
    const linesArr = Array.from({ length: 105 }, (_, i) =>
      JSON.stringify({ type: i === 104 ? "agent_end" : "agent_start", padding }),
    );
    const chunk = linesArr.join("\n") + "\n";
    expect(chunk.length).toBeGreaterThan(8 * 1024 * 1024);
    await handle("stdout", chunk);

    const stdout = captured.filter((c) => c.stream === "stdout");
    expect(stdout).toHaveLength(105);
    expect(stdout[stdout.length - 1].chunk).toContain('"agent_end"');
    const stderr = captured.filter((c) => c.stream === "stderr");
    expect(stderr).toHaveLength(0);
  });
});
