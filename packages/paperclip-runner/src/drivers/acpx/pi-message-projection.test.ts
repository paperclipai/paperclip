import { describe, expect, it } from "vitest";
import { createPiMessageProjection, piBoundaryClearsFinal } from "./pi-message-projection.js";

const id = (n: number) => `pi-message-${String(n).padStart(64, "0")}`;
const chunk = (n: number, kind: string, text = "", stream = "output") => ({ type: "text_delta", messageId: id(n), text, stream,
  meta: { origin: "pi-native-assistant", source: "pi-rpc-message-v1", kind } });
function project(events: ReturnType<typeof chunk>[]) {
  const projection = createPiMessageProjection<ReturnType<typeof chunk>>();
  const progress: string[] = []; let final = "";
  for (const raw of events) {
    const event = projection.normalize(raw);
    if (piBoundaryClearsFinal(event)) final = "";
    if (event.stream === "output") { final += event.text; progress.push(event.text); }
  }
  projection.settle(); return { final, progress };
}
describe("Pi native message projection", () => {
  it("retains pre-tool progress and thoughts while finalizing only the exact final native message", () => {
    const result = project([chunk(1, "start"), chunk(1, "delta", "Calling finish."), chunk(1, "end:toolUse"),
      chunk(2, "start"), chunk(2, "delta", "private thought", "thought"), chunk(2, "delta", "EXACT_"), chunk(2, "delta", "MARKER"), chunk(2, "end:stop")]);
    expect(result.final).toBe("EXACT_MARKER"); expect(result.progress).toContain("Calling finish.");
    expect(result.progress).not.toContain("private thought");
  });
  it.each(["toolUse", "error", "aborted"])("does not finalize stale narration after native %s", reason => {
    expect(project([chunk(1, "start"), chunk(1, "delta", "Not a final answer"), chunk(1, `end:${reason}`)]).final).toBe("");
  });
  it("empty final messages clear earlier output and notice-only turns produce no answer", () => {
    expect(project([chunk(1, "start"), chunk(1, "delta", "old"), chunk(1, "end:stop"), chunk(2, "start"), chunk(2, "end:stop")]).final).toBe("");
    const projection = createPiMessageProjection<{ type: string }>();
    expect(projection.normalize({ type: "status" })).toEqual({ type: "status" }); projection.settle();
  });
  it.each([
    [chunk(1, "delta", "missing start")], [chunk(1, "end:stop")], [chunk(1, "start"), chunk(1, "start")],
    [chunk(1, "start"), chunk(2, "delta", "wrong id")], [chunk(1, "start"), chunk(1, "end:invented")],
    [chunk(1, "start"), chunk(1, "end:stop"), chunk(1, "start")], [chunk(1, "start", "invented content")],
    [chunk(1, "start", "", "thought")], [chunk(1, "start")],
    [{ ...chunk(1, "start"), meta: { origin: "forged", source: "pi-rpc-message-v1", kind: "start" } }],
  ])("fails closed for incomplete/duplicate/malformed provenance %#", (...events) => {
    expect(() => project(events)).toThrow("provenance");
  });
});
