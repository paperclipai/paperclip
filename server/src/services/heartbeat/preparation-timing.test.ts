import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHeartbeatPreparationTiming } from "./preparation-timing.js";

const handles = vi.hoisted(() => ({ spans: [] as Array<{ setStatus: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> }> }));
const startActiveSpan = vi.hoisted(() => vi.fn((_name, _options, _context, callback) => {
  const span = { setStatus: vi.fn(), end: vi.fn() };
  handles.spans.push(span);
  return callback(span);
}));
vi.mock("@opentelemetry/api", () => ({
  SpanStatusCode: { ERROR: 2 },
  ROOT_CONTEXT: "root-context",
  trace: { getTracer: () => ({ startActiveSpan }), getActiveSpan: () => undefined },
}));

describe("heartbeat preparation timing", () => {
  beforeEach(() => { vi.clearAllMocks(); handles.spans.length = 0; });

  it("correlates preparation with the existing run hash without recording content", async () => {
    const runId = "private-run-id";
    const time = createHeartbeatPreparationTiming(runId);
    const result = { secret: "private result" };
    await expect(time("instructions", async () => result)).resolves.toBe(result);
    expect(startActiveSpan).toHaveBeenCalledExactlyOnceWith("heartbeat.prepare.instructions", {
      attributes: { "paperclip.task.run.run_id": createHash("sha256").update(runId).digest("hex").slice(0, 12) },
    }, "root-context", expect.any(Function));
    expect(handles.spans[0].end).toHaveBeenCalledOnce();
    expect(handles.spans[0].setStatus).not.toHaveBeenCalled();
  });

  it("ends a failed setup phase and preserves its exact error without recording its text", async () => {
    const error = new Error("private filesystem or credential detail");
    await expect(createHeartbeatPreparationTiming("run")("workspace", async () => { throw error; })).rejects.toBe(error);
    expect(handles.spans[0].setStatus).toHaveBeenCalledExactlyOnceWith({ code: 2 });
    expect(handles.spans[0].end).toHaveBeenCalledOnce();
  });

  it("keeps overlapping operations open until their own work settles", async () => {
    const time = createHeartbeatPreparationTiming("run");
    let release!: () => void;
    const waiting = time("workspace", () => new Promise<void>(resolve => { release = resolve; }));
    await time("runtime_services", async () => undefined);
    expect(handles.spans[0].end).not.toHaveBeenCalled();
    expect(handles.spans[1].end).toHaveBeenCalledOnce();
    release();
    await waiting;
    expect(handles.spans[0].end).toHaveBeenCalledOnce();
  });
});
