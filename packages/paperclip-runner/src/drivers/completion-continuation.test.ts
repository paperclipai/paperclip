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

  it("continues staged workspace preparation from the current server-owned task", async () => {
    const preparation = { kind: "same_agent", summary: "Continue with the prepared repository.", idempotencyKey: "repository:task:receipt:run" };
    expect(await resolveCompletionContinuation(yielded, "run", async () => ({ ...context, completionContinuation: preparation })))
      .toEqual({ ...yielded, continuation: preparation });
  });

  it("rechecks a sidecar-resolved workspace continuation against current server authority", async () => {
    const preparation = { kind: "same_agent", summary: "Continue with the prepared repository.", idempotencyKey: "repository:task:receipt:run" };
    const report = { ...yielded, continuation: preparation };
    const read = vi.fn().mockResolvedValue({ ...context, completionContinuation: preparation });
    const resolved = await resolveCompletionContinuation(report, "run", read);
    expect(resolved).toEqual(report);
    expect(read).toHaveBeenCalledExactlyOnceWith();
    for (const response of [null, { ...context, completionContinuation: { ...preparation, idempotencyKey: "foreign" } },
      { ...context, completionContinuation: { ...preparation, summary: "changed" } },
      { ...context, completionContinuation: preparation, run: { id: "foreign" } }]) {
      await expect(resolveCompletionContinuation(report, "run", async () => response)).rejects.toThrow();
    }
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
