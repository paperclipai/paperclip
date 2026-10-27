import { describe, expect, it } from "vitest";
import type { PrpEvent } from "../../vendor/paperclip-runner/index.js";
import { createNativeDeliverableTextObservation } from "./native-deliverable-text.js";

function event(eventType: string, payload: Record<string, unknown>, itemId?: string) {
  return { eventType, payload, ...(itemId ? { itemId } : {}) } as PrpEvent;
}

describe("native deliverable text", () => {
  it.each(["agentMessage", "assistant_message", "reasoning"])("accepts streamed and completed %s text", (kind) => {
    const observe = createNativeDeliverableTextObservation();
    const expected = kind === "reasoning" ? "reasoning" : "agentMessage";
    expect(observe(event("item.delta", { kind, text: "text" }, "message"))).toBe(expected);
    expect(observe(event("item.completed", { kind, text: "text" }))).toBe(expected);
  });

  it("matches nested and inherited transcript item identities without counting starts", () => {
    const observe = createNativeDeliverableTextObservation();
    expect(observe(event("item.started", { item: { id: "message", type: "agentMessage", text: "hidden" } }))).toBeNull();
    expect(observe(event("item.delta", { item: { id: "message", text: "visible" } }))).toBe("agentMessage");
    expect(observe(event("item.started", { kind: "reasoning" }, "thought"))).toBeNull();
    expect(observe(event("item.delta", { text: "thinking" }, "thought"))).toBe("reasoning");
  });

  it("accepts text released by redaction at terminal boundaries", () => {
    const observe = createNativeDeliverableTextObservation();
    expect(observe(event("item.delta", { kind: "reasoning", text: "" }, "thought"))).toBeNull();
    expect(observe(event("turn.completed", { outputTails: [
      { itemId: "thought", payload: { text: "settled thought" } },
    ] }))).toBe("reasoning");
  });

  it("accepts an accepted result summary without any streamed text", () => {
    const observe = createNativeDeliverableTextObservation();
    const result = { schema: "paperclip.run_result.v1", summary: "Done" };
    expect(observe(event("run.result.proposed", result))).toBeNull();
    expect(observe(event("run.result.accepted", { result }))).toBe("agentMessage");
  });

  it.each([
    event("item.delta", { kind: "agentMessage", delta: "not projected" }, "message"),
    event("item.delta", { kind: "agentMessage", content: "not projected" }, "message"),
    event("item.delta", { kind: "agentMessage", text: "missing identity" }),
    event("item.delta", { kind: "agentMessage", text: " " }, "message"),
    event("item.completed", { kind: "reasoning", text: 42 }),
    event("item.completed", { kind: "usage", text: "tokens" }),
    event("item.completed", { kind: "toolCall", text: "arguments" }),
    event("tool.execution.started", { executionId: "tool", text: "tool" }),
    event("turn.started", { kind: "agentMessage", text: "metadata" }),
    event("run.result.accepted", { result: { schema: "other", summary: "wrong schema" } }),
    event("run.result.accepted", { result: { schema: "paperclip.run_result.v1", summary: " " } }),
    event("turn.completed", { outputTails: [{ payload: { kind: "agentMessage", text: "no identity" } }] }),
  ])("ignores text that the task transcript cannot show: %j", (candidate) => {
    expect(createNativeDeliverableTextObservation()(candidate)).toBeNull();
  });
});
