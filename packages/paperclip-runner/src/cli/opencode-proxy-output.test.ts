import { afterEach, expect, it, vi } from "vitest";
import { createOpenCodeProxyOutput } from "./opencode-proxy-output.js";

afterEach(() => vi.useRealTimers());

function delta(text: string, itemId = "answer", turnId = "turn") {
  return { method: "item/agentMessage/delta", params: {
    threadId: "thread", turnId, itemId, kind: "agentMessage", text, delta: text,
    item: { id: itemId, type: "agentMessage", text },
  } };
}

it("retains every streamed byte and flushes before a tool request or terminal", () => {
  vi.useFakeTimers();
  const write = vi.fn();
  const output = createOpenCodeProxyOutput(write);
  for (const text of ["A ", "流", "ed answer."]) output.send(delta(text));
  expect(write).not.toHaveBeenCalled();
  const tool = { id: "tool-1", method: "item/tool/call", params: { tool: "paperclip_finish" } };
  output.send(tool);
  expect(write.mock.calls.map(([value]) => value)).toEqual([delta("A 流ed answer."), tool]);
  output.send(delta("Final."));
  const terminal = { method: "turn/completed", params: { turnId: "turn" } };
  output.send(terminal);
  expect(write.mock.calls.slice(2).map(([value]) => value)).toEqual([delta("Final."), terminal]);
  vi.runAllTimers();
  expect(write).toHaveBeenCalledTimes(4);
});

it("keeps item, turn, channel and reasoning boundaries in order", () => {
  vi.useFakeTimers();
  const write = vi.fn();
  const output = createOpenCodeProxyOutput(write);
  const frames = [delta("First"), delta("Second", "other"), delta("Next", "other", "next-turn"),
    { method: "item/delta", params: { kind: "reasoning", text: "Private reasoning" } },
    { ...delta("Progress"), params: { ...delta("Progress").params, channel: "progress" } },
    { ...delta("Final"), params: { ...delta("Final").params, channel: "final" } }];
  frames.forEach(frame => output.send(frame));
  output.flush();
  expect(write.mock.calls.map(([value]) => value)).toEqual(frames);
});

it("bounds streaming latency, UTF-8 buffer size and shutdown retention", () => {
  vi.useFakeTimers();
  const write = vi.fn();
  const output = createOpenCodeProxyOutput(write);
  output.send(delta("Visible"));
  vi.advanceTimersByTime(50);
  expect(write).toHaveBeenLastCalledWith(delta("Visible"));
  const chunk = "流".repeat(900);
  output.send(delta(chunk));
  output.send(delta(chunk));
  expect(write).toHaveBeenCalledTimes(2);
  output.flush();
  expect(write.mock.calls.slice(1).map(([value]) => value.params.delta).join("")).toBe(chunk + chunk);
  expect(write).toHaveBeenCalledTimes(3);
  vi.runAllTimers();
  expect(write).toHaveBeenCalledTimes(3);
});

it("flushes preceding text before an oversized original delta without retaining a timer", () => {
  vi.useFakeTimers();
  const write = vi.fn();
  const output = createOpenCodeProxyOutput(write);
  const small = delta("First.");
  const large = delta("x".repeat(4001));
  output.send(small);
  output.send(large);
  expect(write.mock.calls.map(([value]) => value)).toEqual([small, large]);
  vi.runAllTimers();
  output.flush();
  expect(write).toHaveBeenCalledTimes(2);
});
