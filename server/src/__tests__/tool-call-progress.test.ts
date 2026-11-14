import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TOOL_CALL_PROGRESS_MESSAGE_MAX_LENGTH } from "@paperclipai/shared";
import {
  createToolCallProgressReporter,
  TOOL_CALL_PROGRESS_PUBLISH_INTERVAL_MS,
  TOOL_CALL_PROGRESS_SAVE_INTERVAL_MS,
} from "../services/tool-call-progress.js";
import { assignedToolName } from "../services/native-runtime/assigned-mcp-tools.js";

function reporter() {
  const published: Array<{ companyId: string; type: string; payload: Record<string, unknown> }> = [];
  const saved: unknown[] = [];
  const instance = createToolCallProgressReporter({
    companyId: "company-a",
    runId: "run-a",
    issueId: "issue-a",
    agentId: "agent-a",
    invocationId: "invocation-a",
    toolName: "kv_demo__slow_with_progress",
    startedAt: new Date("2026-11-13T10:00:00Z"),
    publish: (event) => { published.push(event); },
    save: async (progress) => { saved.push(progress); },
  });
  return { instance, published, saved };
}

describe("tool call progress reporter", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-13T10:00:01Z")); });
  afterEach(() => { vi.useRealTimers(); });

  it("publishes at most one update per interval and always the latest", () => {
    const { instance, published } = reporter();
    for (let step = 1; step <= 50; step++) instance.report({ progress: step, total: 50, message: `Step ${step}` });
    // The first update goes out at once; the rest wait for the interval.
    expect(published.map((event) => event.payload.progress)).toEqual([1]);
    vi.advanceTimersByTime(TOOL_CALL_PROGRESS_PUBLISH_INTERVAL_MS);
    expect(published.map((event) => event.payload.progress)).toEqual([1, 50]);
    vi.advanceTimersByTime(TOOL_CALL_PROGRESS_PUBLISH_INTERVAL_MS * 4);
    expect(published).toHaveLength(2);
    // A steady stream for one second publishes about four times, never per update.
    for (let tick = 0; tick < 100; tick++) {
      instance.report({ progress: 51 + tick, total: 200 });
      vi.advanceTimersByTime(10);
    }
    expect(published.length - 2).toBeLessThanOrEqual(1_000 / TOOL_CALL_PROGRESS_PUBLISH_INTERVAL_MS + 1);
  });

  it("saves on the invocation less often than it publishes", async () => {
    const { instance, saved } = reporter();
    for (let tick = 0; tick < 200; tick++) {
      instance.report({ progress: tick, total: 200 });
      await vi.advanceTimersByTimeAsync(10);
    }
    expect(saved.length).toBeLessThanOrEqual(2_000 / TOOL_CALL_PROGRESS_SAVE_INTERVAL_MS + 1);
    expect(saved.length).toBeGreaterThanOrEqual(2);
  });

  it("ties every event to its company, run and tool call", () => {
    const { instance, published } = reporter();
    instance.report({ progress: 1, total: 4, message: "Reading" });
    expect(published[0]).toEqual({
      companyId: "company-a",
      type: "heartbeat.run.tool_progress",
      payload: {
        invocationId: "invocation-a",
        runId: "run-a",
        issueId: "issue-a",
        agentId: "agent-a",
        toolName: "kv_demo__slow_with_progress",
        nativeToolName: assignedToolName("kv_demo__slow_with_progress"),
        startedAt: "2026-11-13T10:00:00.000Z",
        updatedAt: "2026-11-13T10:00:01.000Z",
        progress: 1,
        total: 4,
        message: "Reading",
        done: false,
      },
    });
  });

  it("treats provider text as untrusted: plain, single-line and bounded", () => {
    const { instance, published } = reporter();
    instance.report({ progress: 1, message: `<b>bold</b>\n\u0007line‮${"x".repeat(1_000)}` });
    const message = published[0]!.payload.message as string;
    expect(message.startsWith("<b>bold</b> line ")).toBe(true);
    expect(message).not.toMatch(/[\n\u0007‮]/);
    expect(message.length).toBe(TOOL_CALL_PROGRESS_MESSAGE_MAX_LENGTH);
  });

  it("drops unusable and out-of-order updates", () => {
    const { instance, published } = reporter();
    instance.report({ progress: "1", total: 2 });
    instance.report({ progress: Number.NaN });
    instance.report({ progress: -1 });
    expect(published).toEqual([]);
    instance.report({ progress: 5, total: 2 });
    expect(published[0]!.payload).toMatchObject({ progress: 5, total: null });
    vi.advanceTimersByTime(TOOL_CALL_PROGRESS_PUBLISH_INTERVAL_MS);
    instance.report({ progress: 3, total: 10 });
    vi.advanceTimersByTime(TOOL_CALL_PROGRESS_PUBLISH_INTERVAL_MS);
    expect(published).toHaveLength(1);
  });

  it("on finish stops pending work and tells viewers to drop the progress", () => {
    const { instance, published, saved } = reporter();
    instance.report({ progress: 1, total: 3 });
    instance.report({ progress: 2, total: 3 });
    instance.finish();
    vi.advanceTimersByTime(TOOL_CALL_PROGRESS_SAVE_INTERVAL_MS * 3);
    expect(published.map((event) => [event.payload.progress, event.payload.done])).toEqual([[1, false], [2, true]]);
    expect(saved).toHaveLength(1);
    instance.report({ progress: 3, total: 3 });
    expect(published).toHaveLength(2);
  });

  it("a call that never reported progress finishes silently", () => {
    const { instance, published } = reporter();
    instance.finish();
    expect(published).toEqual([]);
  });

  it("never throws into the call when publishing or saving fails", async () => {
    const instance = createToolCallProgressReporter({
      companyId: "c", runId: "r", issueId: null, agentId: null, invocationId: "i", toolName: "t",
      publish: () => { throw new Error("socket gone"); },
      save: async () => { throw new Error("db gone"); },
    });
    expect(() => instance.report({ progress: 1 })).not.toThrow();
    expect(() => instance.finish()).not.toThrow();
    await vi.runAllTimersAsync();
  });

  it("keeps one save in flight, only the newest update waits, and finish drops it", async () => {
    let release!: () => void;
    const saves: number[] = [];
    const instance = createToolCallProgressReporter({
      companyId: "c", runId: "r", issueId: null, agentId: null, invocationId: "i", toolName: "t",
      publish: () => undefined,
      save: (progress) => { saves.push(progress.progress); return new Promise<void>((resolve) => { release = resolve; }); },
    });
    instance.report({ progress: 1 });
    // The database is slow: three more save intervals pass while the first write runs.
    for (let step = 2; step <= 4; step++) {
      vi.advanceTimersByTime(TOOL_CALL_PROGRESS_SAVE_INTERVAL_MS);
      instance.report({ progress: step });
    }
    vi.advanceTimersByTime(TOOL_CALL_PROGRESS_SAVE_INTERVAL_MS);
    expect(saves).toEqual([1]);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(saves).toEqual([1, 4]);
    instance.report({ progress: 5 });
    vi.advanceTimersByTime(TOOL_CALL_PROGRESS_SAVE_INTERVAL_MS);
    instance.finish();
    release();
    await vi.advanceTimersByTimeAsync(TOOL_CALL_PROGRESS_SAVE_INTERVAL_MS * 3);
    expect(saves).toEqual([1, 4]);
  });

  it("names the tool the way native runners name it, so their rows can find the call", () => {
    const instance = createToolCallProgressReporter({
      companyId: "c", runId: "r", issueId: null, agentId: null, invocationId: "i",
      toolName: "mcp.kv-demo-1a2b3c4d:slow-with-progress",
      publish: (event) => { names.push(event.payload.nativeToolName); },
    });
    const names: unknown[] = [];
    instance.report({ progress: 1 });
    expect(names).toEqual(["app_mcp_kv_demo_1a2b3c4d_slow_with_progress_889fb9a8d98e"]);
  });

  it("gives each call its own progress token", () => {
    expect(reporter().instance.token).not.toBe(reporter().instance.token);
  });
});
