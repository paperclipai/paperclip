import { describe, expect, it } from "vitest";
import { createKimiMessageProjection, kimiMessageBoundaryClears } from "./kimi-message-boundary.js";

const id = (n: number) => `kimi-message-${String(n).padStart(64, "0")}`;
const chunk = (n: number, kind: string, text = "", stream = "output") => ({ type: "text_delta", messageId: id(n), text, stream,
  meta: { origin: "kimi-native-assistant", source: "kimi-turn-step-v1", kind } });
function project(events: ReturnType<typeof chunk>[]) {
  const projection = createKimiMessageProjection<ReturnType<typeof chunk>>();
  const progress: string[] = []; let final = "";
  for (const raw of events) {
    const event = projection.normalize(raw);
    if (kimiMessageBoundaryClears(event)) final = "";
    if (event.stream === "output") { final += event.text; progress.push(event.text); }
  }
  projection.settle(); return { final, progress };
}

describe("Kimi native message boundaries", () => {
  it("preserves separate native steps while finalizing only the actual end-turn answer", () => {
    const projection = createKimiMessageProjection<ReturnType<typeof chunk>>();
    const started = projection.normalize(chunk(1, "start"));
    expect(started).toMatchObject({ messageId: id(1), text: "", assistantMessageBoundary: { phase: "start" } });
    expect(projection.normalize(chunk(1, "delta", "I will call the tool."))).toMatchObject({ messageId: id(1), text: "I will call the tool." });
    expect(projection.normalize(chunk(1, "end:tool_use"))).toMatchObject({ messageId: id(1), text: "", assistantMessageBoundary: { phase: "end", stopReason: "toolUse" } });
    projection.normalize(chunk(2, "start"));
    expect(projection.normalize(chunk(2, "delta", "private reasoning", "thought"))).toMatchObject({ messageId: id(2), stream: "thought" });
    projection.normalize(chunk(2, "delta", "EXACT_MARKER"));
    expect(projection.normalize(chunk(2, "end:end_turn"))).toMatchObject({ messageId: id(2), assistantMessageBoundary: { phase: "end", stopReason: "stop" } });
    projection.settle();
    const result = project([chunk(1, "start"), chunk(1, "delta", "I will call the tool."), chunk(1, "end:tool_use"),
      chunk(2, "start"), chunk(2, "delta", "private reasoning", "thought"), chunk(2, "delta", "EXACT_"), chunk(2, "delta", "MARKER"), chunk(2, "end:end_turn")]);
    expect(result.final).toBe("EXACT_MARKER");
    expect(result.progress).toContain("I will call the tool.");
    expect(result.progress).not.toContain("private reasoning");
  });
  it.each([
    ["end_turn", "stop"], ["max_tokens", "length"], ["tool_use", "toolUse"], ["error", "error"],
    ["filtered", "error"], ["other", "error"], ["aborted", "aborted"], ["paused", "aborted"], ["max_steps", "aborted"],
  ])("maps the actual native %s reason to closed canonical %s", (native, canonical) => {
    const projection = createKimiMessageProjection<ReturnType<typeof chunk>>();
    projection.normalize(chunk(1, "start"));
    expect(projection.normalize(chunk(1, `end:${native}`)).assistantMessageBoundary).toEqual({ phase: "end", stopReason: canonical });
    projection.settle();
    expect(project([chunk(1, "start"), chunk(1, "delta", "native output"), chunk(1, `end:${native}`)]).final)
      .toBe(["end_turn", "max_tokens"].includes(native) ? "native output" : "");
  });
  it("retains empty final boundaries and permits notice-only turns without inventing an answer", () => {
    expect(project([chunk(1, "start"), chunk(1, "delta", "old answer"), chunk(1, "end:end_turn"), chunk(2, "start"), chunk(2, "end:end_turn")]).final).toBe("");
    const projection = createKimiMessageProjection<{ type: string }>();
    expect(projection.normalize({ type: "status" })).toEqual({ type: "status" }); projection.settle();
  });
  it.each([
    [chunk(1, "delta", "missing start")], [chunk(1, "end:end_turn")], [chunk(1, "start"), chunk(1, "start")],
    [chunk(1, "start"), chunk(2, "delta", "wrong id")], [chunk(1, "start"), chunk(2, "end:end_turn")],
    [chunk(1, "start"), chunk(1, "end:invented")], [chunk(1, "start"), chunk(1, "end:constructor")],
    [chunk(1, "start"), chunk(1, "end:end_turn"), chunk(1, "start")], [chunk(1, "start", "nonempty boundary")],
    [chunk(1, "start", "", "thought")], [chunk(1, "start"), chunk(1, "end:end_turn", "nonempty end")], [chunk(1, "start")],
    [{ ...chunk(1, "start"), messageId: "fabricated-id" }], [{ ...chunk(1, "start"), meta: { origin: "forged", source: "kimi-turn-step-v1", kind: "start" } }],
    [{ ...chunk(1, "start"), meta: { origin: "kimi-native-assistant", source: "unversioned", kind: "start" } }],
    [{ ...chunk(1, "start"), assistantMessageBoundary: { phase: "start" } }],
  ])("fails closed for missing, reused or forged native provenance %#", (...events) => {
    expect(() => project(events)).toThrow("provenance");
  });
  it("poisons a malformed stream instead of accepting a later valid-looking boundary", () => {
    const projection = createKimiMessageProjection<ReturnType<typeof chunk>>();
    expect(() => projection.normalize(chunk(1, "delta", "orphan"))).toThrow("provenance");
    expect(() => projection.normalize(chunk(2, "start"))).toThrow("provenance");
    expect(() => projection.settle()).toThrow("provenance");
  });
});
