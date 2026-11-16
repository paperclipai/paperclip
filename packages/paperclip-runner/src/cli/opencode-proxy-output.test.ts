import { afterEach, describe, expect, it, vi } from "vitest";
import { createBackpressuredFrameWriter, createOpenCodeProxyOutput } from "./opencode-proxy-output.js";

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

describe("backpressured frame writer", () => {
  function sink() {
    const lines: string[] = [];
    let drain: (() => void) | undefined;
    let accepting = false;
    return {
      lines,
      write(chunk: string) { lines.push(chunk); return accepting; },
      once(_event: "drain", listener: () => void) { drain = listener; },
      resume() { accepting = true; const listener = drain; drain = undefined; listener?.(); },
    };
  }

  it("holds frames past the stream's buffer and delivers them in order", () => {
    const stream = sink();
    const writer = createBackpressuredFrameWriter(stream);
    for (const n of [1, 2, 3]) writer.write({ n });
    expect(stream.lines).toEqual(['{"n":1}\n']);
    expect(writer.queuedFrames).toBe(2);
    stream.resume();
    expect(stream.lines).toEqual(['{"n":1}\n', '{"n":2}\n', '{"n":3}\n']);
  });

  it("drops an aborted queued frame once and keeps later frames flowing", () => {
    const stream = sink();
    const writer = createBackpressuredFrameWriter(stream);
    const call = new AbortController();
    const abandoned = vi.fn();
    writer.write({ n: 1 });
    writer.write({ n: 2, call: true }, { signal: call.signal, onAbandoned: abandoned });
    writer.write({ n: 3 });
    call.abort();
    call.abort();
    expect(abandoned).toHaveBeenCalledOnce();
    stream.resume();
    expect(stream.lines).toEqual(['{"n":1}\n', '{"n":3}\n']);
  });

  it("does not withdraw a frame already handed to the stream", () => {
    const stream = sink();
    const writer = createBackpressuredFrameWriter(stream);
    const call = new AbortController();
    const abandoned = vi.fn();
    writer.write({ n: 1 }, { signal: call.signal, onAbandoned: abandoned });
    call.abort();
    expect(abandoned).not.toHaveBeenCalled();
    expect(stream.lines).toEqual(['{"n":1}\n']);
  });

  it("refuses an already-aborted frame and drains live frames on shutdown", () => {
    const stream = sink();
    const writer = createBackpressuredFrameWriter(stream);
    const abandoned = vi.fn();
    writer.write({ n: 1 });
    writer.write({ n: 2 }, { signal: AbortSignal.abort(), onAbandoned: abandoned });
    writer.write({ n: 3 });
    expect(abandoned).toHaveBeenCalledOnce();
    writer.drain();
    expect(stream.lines).toEqual(['{"n":1}\n', '{"n":3}\n']);
    expect(writer.queuedFrames).toBe(0);
  });
});
