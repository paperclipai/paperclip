import { describe, expect, it } from "vitest";
import { createNativeRunTrace } from "./native-run-trace.js";
import { createNativeToolTrace } from "./native-tool-trace.js";

function fixture() {
  let now = 1_000;
  const spans: Record<string, unknown>[] = [];
  const trace = createNativeRunTrace({ runId: "test", startedAtMs: 1_000, onEvent: async (event) => { spans.push(event.payload as Record<string, unknown>); } });
  trace.start("agent.turn");
  return { spans, timing: createNativeToolTrace(trace, () => now), at: (time: number) => { now = time; } };
}
const event = (kind: string, id: string, time: number, inputUpdated = false) => ({ eventType: `tool.execution.${kind}`, emittedAt: new Date(time).toISOString(), payload: { executionId: id, name: "mcp__paperclip__call_api", inputUpdated } });

describe("native tool timing", () => {
  it("measures streamed input and server execution in their distinct ID namespaces", async () => {
    const { spans, timing, at } = fixture();
    await timing.observe(event("started", "toolu_hire", 1_000));
    await timing.observe(event("started", "toolu_hire", 2_000));
    await timing.observe(event("progressed", "toolu_hire", 2_100, true));
    await timing.observe(event("progressed", "toolu_hire", 11_568, true));
    at(11_596);
    expect(await timing.execute({ callId: "3", tool: "call_api" }, async () => { at(11_631); return "created"; })).toBe("created");
    await timing.observe(event("completed", "toolu_hire", 12_003));
    await timing.observe(event("completed", "toolu_hire", 12_004));
    expect(spans).toEqual([
      expect.objectContaining({ span: "tool.execute", durationMs: 35, operation: "call_api", outcome: "ok" }),
      expect.objectContaining({ span: "tool.request.input_stream", durationMs: 10_568, parentSpan: "agent.turn" }),
    ]);
  });

  it("does not invent input-stream duration without input updates or a valid announcement", async () => {
    const { spans, timing } = fixture();
    await timing.observe({ ...event("started", "bad", 1_000), emittedAt: "invalid" });
    await timing.observe(event("started", "future", 5_000));
    await timing.observe(event("progressed", "future", 2_000, true));
    await timing.observe(event("started", "status-only", 1_000));
    await timing.observe(event("progressed", "status-only", 2_000));
    for (const id of ["missing", "bad", "future", "status-only"]) await timing.observe(event("completed", id, 3_000));
    expect(spans).toHaveLength(0);
  });

  it("preserves failures, does not export private data, and discards old turns", async () => {
    const { spans, timing, at } = fixture();
    await timing.observe(event("started", "secret-call-id", 1_000));
    await timing.observe(event("progressed", "secret-call-id", 1_001, true));
    await timing.observe({ eventType: "turn.completed", emittedAt: new Date(1_001).toISOString(), payload: {} });
    await timing.observe(event("completed", "secret-call-id", 1_002));
    at(2_000);
    const failure = new Error("private error");
    await expect(timing.execute({ callId: "secret-call-id", tool: "private tool" }, async () => { at(2_020); throw failure; })).rejects.toBe(failure);
    expect(spans).toEqual([expect.objectContaining({ span: "tool.execute", durationMs: 20, outcome: "failed", operation: "other" })]);
    expect(JSON.stringify(spans)).not.toMatch(/secret-call-id|private/);
  });

  it("keeps concurrent same-name provider tools separate without FIFO matching", async () => {
    const { spans, timing, at } = fixture();
    await timing.observe(event("started", "provider-a", 1_000));
    await timing.observe(event("started", "provider-b", 1_005));
    await timing.observe(event("progressed", "provider-b", 1_015, true));
    at(1_020);
    let complete!: () => void;
    const first = timing.execute({ callId: "mcp-a", tool: "call_api" }, () => new Promise<void>((resolve) => { complete = resolve; }));
    at(1_025);
    await timing.execute({ callId: "mcp-b", tool: "call_api" }, async () => { at(1_030); });
    await timing.observe(event("progressed", "provider-a", 1_031, true));
    await timing.observe(event("completed", "provider-b", 1_032));
    at(1_040);
    complete();
    await first;
    await timing.observe(event("completed", "provider-a", 1_045));
    expect(spans.filter((span) => span.span === "tool.execute").map((span) => span.durationMs)).toEqual([5, 20]);
    expect(spans.filter((span) => span.span === "tool.request.input_stream").map((span) => span.durationMs)).toEqual([10, 31]);
  });
});
