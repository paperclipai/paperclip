import { describe, expect, it, vi } from "vitest";
import { resolveCompletionContinuation } from "./completion-continuation.js";

const continuation = { kind: "monitor", summary: "Wait for the saved task monitor.", idempotencyKey: "task-monitor:task:deadline" };
const context = { run: { id: "run" }, activeTask: { executionRunId: "run" }, completionContinuation: continuation };
const yielded = { reportedWorkDisposition: "yielded", summary: "The review fix is published." };

describe("controller-owned completion continuation", () => {
  it.each([undefined, null])("fills an omitted wait from a current server read (%s)", async absent => {
    const read = vi.fn().mockResolvedValue(context);
    const report = { ...yielded, continuation: absent };
    expect(await resolveCompletionContinuation(report, "run", read)).toEqual({ ...yielded, continuation });
    expect(read).toHaveBeenCalledOnce();
    expect(report.continuation).toBe(absent);
  });

  it("accepts the remote proxy's JSON text response", async () => {
    expect(await resolveCompletionContinuation(yielded, "run", async () => ({ type: "inputText", text: JSON.stringify(context) })))
      .toEqual({ ...yielded, continuation });
  });

  it.each([
    null, { ...context, run: { id: "other" } }, { ...context, activeTask: { executionRunId: "other" } },
    { ...context, completionContinuation: null }, { ...context, completionContinuation: { kind: "response_wake" } },
    "unavailable", { success: false, contentItems: [] },
  ])("does not invent a passive wait from invalid or stale task state: %j", async response => {
    await expect(resolveCompletionContinuation(yielded, "run", async () => response)).rejects.toThrow("no eligible saved monitor");
  });

  it("does not replace an explicit report or read state for ordinary completion", async () => {
    const read = vi.fn();
    for (const report of [{ ...yielded, continuation: { kind: "invalid" } }, { reportedWorkDisposition: "done" }]) {
      expect(await resolveCompletionContinuation(report, "run", read)).toBe(report);
    }
    expect(read).not.toHaveBeenCalled();
  });
});
