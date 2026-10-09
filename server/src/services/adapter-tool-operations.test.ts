import { describe, expect, it, vi } from "vitest";
import {
  createAdapterToolOperationSink,
  observedToolCallFromRuntimeEvent,
} from "./adapter-tool-operations.js";
import type { workspaceOperationService } from "./workspace-operations.js";

function fakeWorkspaceOperations() {
  const recorded: Array<{ status: string; metadata: Record<string, unknown> | null; phase: string }> = [];
  const settled: Array<{ id: string; status: string }> = [];
  const service = {
    recordObservedOperation: vi.fn(async (input: {
      phase: string;
      observedStatus: string;
      metadata?: Record<string, unknown> | null;
    }) => {
      recorded.push({
        status: input.observedStatus,
        metadata: input.metadata ?? null,
        phase: input.phase,
      });
      return `op-${recorded.length}`;
    }),
    settleObservedOperation: vi.fn(async (input: { id: string; status: string }) => {
      settled.push({ id: input.id, status: input.status });
      return true;
    }),
  };
  return { service: service as unknown as ReturnType<typeof workspaceOperationService>, recorded, settled };
}

function sinkHarness() {
  const { service, recorded, settled } = fakeWorkspaceOperations();
  const sink = createAdapterToolOperationSink({
    workspaceOperations: service,
    companyId: "company-1",
    heartbeatRunId: "run-1",
    issueId: "issue-1",
    executionWorkspaceId: "workspace-1",
  });
  return { sink, recorded, settled };
}

describe("observedToolCallFromRuntimeEvent", () => {
  it("recognizes the .tool_call event family and maps statuses", () => {
    expect(
      observedToolCallFromRuntimeEvent({
        eventType: "acpx.tool_call",
        payload: { name: "Terminal", toolCallId: "call_1", status: "in_progress" },
      }),
    ).toEqual({ toolCallId: "call_1", name: "Terminal", status: "running" });

    expect(
      observedToolCallFromRuntimeEvent({
        eventType: "opencode.tool_call",
        payload: { name: "bash", toolCallId: "part_9", status: "completed" },
      }),
    ).toEqual({ toolCallId: "part_9", name: "bash", status: "succeeded" });

    expect(
      observedToolCallFromRuntimeEvent({
        eventType: "tool_call",
        payload: { toolName: "read_file" },
      }),
    ).toEqual({ toolCallId: null, name: "read_file", status: "running" });

    expect(
      observedToolCallFromRuntimeEvent({
        eventType: "acpx.tool_call",
        payload: { name: "edit", toolCallId: "call_2", status: "failed" },
      }),
    ).toEqual({ toolCallId: "call_2", name: "edit", status: "failed" });

    expect(
      observedToolCallFromRuntimeEvent({
        eventType: "acpx.tool_call",
        payload: { name: "edit", toolCallId: "call_3", status: "cancelled" },
      }),
    ).toEqual({ toolCallId: "call_3", name: "edit", status: "skipped" });
  });

  it("ignores non-tool events and tool results", () => {
    expect(observedToolCallFromRuntimeEvent({ eventType: "assistant", payload: { content: "hi" } })).toBeNull();
    expect(observedToolCallFromRuntimeEvent({ eventType: "acpx.tool_result", payload: { name: "x" } })).toBeNull();
    expect(observedToolCallFromRuntimeEvent({ eventType: "acpx.status", payload: { used: 1 } })).toBeNull();
    expect(observedToolCallFromRuntimeEvent({ eventType: "  ", payload: {} })).toBeNull();
    // A tool_call event with neither identity nor name is not a usable record.
    expect(observedToolCallFromRuntimeEvent({ eventType: "acpx.tool_call", payload: {} })).toBeNull();
  });
});

describe("createAdapterToolOperationSink", () => {
  it("opens one row per tool call and settles it on the terminal update", async () => {
    const { sink, recorded, settled } = sinkHarness();
    await sink({ eventType: "acpx.tool_call", payload: { name: "Terminal", toolCallId: "c1", status: "pending" } });
    await sink({ eventType: "acpx.tool_call", payload: { name: "Terminal", toolCallId: "c1", status: "in_progress" } });
    await sink({ eventType: "acpx.tool_call", payload: { name: "Terminal", toolCallId: "c1", status: "completed" } });

    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      phase: "provider_tool_execution",
      status: "running",
      metadata: { toolCallId: "c1", toolName: "Terminal" },
    });
    expect(settled).toEqual([{ id: "op-1", status: "succeeded" }]);

    // A late duplicate update after settle records nothing further.
    await sink({ eventType: "acpx.tool_call", payload: { name: "Terminal", toolCallId: "c1", status: "completed" } });
    expect(recorded).toHaveLength(1);
    expect(settled).toHaveLength(1);
  });

  it("records a running row for a call that never settles (mid-execution kill)", async () => {
    const { sink, recorded, settled } = sinkHarness();
    await sink({ eventType: "opencode.tool_call", payload: { name: "bash", toolCallId: "p1", status: "running" } });
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ status: "running" });
    expect(settled).toHaveLength(0);
  });

  it("records a directly terminal row when only the outcome was observed", async () => {
    const { sink, recorded } = sinkHarness();
    await sink({ eventType: "opencode.tool_call", payload: { name: "bash", toolCallId: "p2", status: "error" } });
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ status: "failed" });
  });

  it("records start-only, id-less calls as their own rows", async () => {
    const { sink, recorded } = sinkHarness();
    await sink({ eventType: "tool_call", payload: { toolName: "read_file" } });
    await sink({ eventType: "tool_call", payload: { toolName: "grep" } });
    expect(recorded).toHaveLength(2);
    expect(recorded.map((entry) => entry.status)).toEqual(["running", "running"]);
    expect(recorded.map((entry) => (entry.metadata as { toolName: string }).toolName)).toEqual(["read_file", "grep"]);
  });

  it("ignores non-tool events entirely", async () => {
    const { sink, recorded } = sinkHarness();
    await sink({ eventType: "assistant", payload: { content: "working" } });
    await sink({ eventType: "acpx.tool_result", payload: { name: "x" } });
    expect(recorded).toHaveLength(0);
  });
});
