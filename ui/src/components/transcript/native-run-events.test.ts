import { describe, expect, it } from "vitest";
import type { HeartbeatRunEvent } from "@paperclipai/shared";
import { nativeRunEventsToTranscript } from "./native-run-events";

const RUN_ID = "10000000-0000-4000-8000-000000000001";

function event(
  seq: number,
  eventType: string,
  payload: Record<string, unknown>,
  overrides: Partial<HeartbeatRunEvent> = {},
): HeartbeatRunEvent {
  return {
    id: seq,
    companyId: "10000000-0000-4000-8000-000000000002",
    runId: RUN_ID,
    agentId: "10000000-0000-4000-8000-000000000003",
    seq,
    eventType,
    stream: "system",
    level: "info",
    color: null,
    message: null,
    payload: {
      prpEvent: {
        schema: "paperclip.prp.event.v1",
        sourceEventId: `event-${seq}`,
        sourceSeq: seq,
        sourceInstanceId: "runner-1",
        sourceKind: "runner",
        runId: RUN_ID,
        normalizedSessionId: "session-1",
        eventType,
        schemaVersion: 1,
        priority: 1,
        emittedAt: `2026-08-25T18:00:${String(seq).padStart(2, "0")}.000Z`,
        payload,
      },
    },
    createdAt: new Date("2026-08-25T18:00:00.000Z"),
    ...overrides,
  };
}

describe("nativeRunEventsToTranscript", () => {
  it("projects provider-neutral messages, tools, usage, and the final reply", () => {
    const transcript = nativeRunEventsToTranscript([
      event(6, "run.result.proposed", { summary: "Done safely." }),
      event(1, "item.delta", { itemId: "message-1", kind: "agentMessage", text: "Done " }),
      event(2, "item.delta", { itemId: "message-1", kind: "agentMessage", text: "safely." }),
      event(3, "item.completed", { itemId: "message-1", kind: "agentMessage", text: "Done safely." }),
      event(4, "tool.execution.started", {
        executionId: "exec-1",
        transport: "process",
        operation: "execute",
        name: "pnpm test",
        status: "running",
      }),
      event(5, "tool.execution.completed", {
        executionId: "exec-1",
        transport: "process",
        operation: "execute",
        name: "pnpm test",
        status: "completed",
        output: "all green",
      }),
      event(7, "usage.reported", {
        runDeltaAvailable: true,
        runDelta: {
          inputTokens: 12,
          outputTokens: 3,
          cacheReadTokens: 2,
          providerCostUsd: 0.01,
        },
      }),
    ]);

    expect(transcript).toEqual([
      expect.objectContaining({ kind: "assistant", text: "Done safely." }),
      expect.objectContaining({
        kind: "tool_call",
        name: "Bash",
        toolUseId: "exec-1",
        input: { command: "pnpm test" },
      }),
      expect.objectContaining({
        kind: "tool_result",
        toolUseId: "exec-1",
        content: "all green",
        isError: false,
      }),
      expect.objectContaining({
        kind: "result",
        subtype: "paperclip_runner_usage",
        inputTokens: 12,
        outputTokens: 3,
        cachedTokens: 2,
        costUsd: 0.01,
      }),
    ]);
  });

  it("streams deltas until a loss-resistant completed item is available", () => {
    expect(nativeRunEventsToTranscript([
      event(1, "item.delta", { itemId: "message-1", kind: "agentMessage", text: "Still " }),
      event(2, "item.delta", { itemId: "message-1", kind: "agentMessage", text: "working" }),
    ])).toEqual([
      expect.objectContaining({ kind: "assistant", text: "Still ", delta: true }),
      expect.objectContaining({ kind: "assistant", text: "working", delta: true }),
    ]);
  });

  it("sums run deltas without leaking session-cumulative usage", () => {
    const transcript = nativeRunEventsToTranscript([
      event(1, "usage.reported", {
        runDeltaAvailable: true,
        runDelta: {
          inputTokens: 12,
          outputTokens: 3,
          cacheReadTokens: 2,
          providerCostUsd: 0.01,
        },
        cumulative: {
          inputTokens: 112,
          outputTokens: 53,
          cacheReadTokens: 22,
          providerCostUsd: 1.01,
        },
      }),
      event(2, "usage.reported", {
        runDeltaAvailable: true,
        runDelta: {
          inputTokens: 4,
          outputTokens: 2,
          cacheReadTokens: 1,
          providerCostUsd: 0.005,
        },
        cumulative: {
          inputTokens: 116,
          outputTokens: 55,
          cacheReadTokens: 23,
          providerCostUsd: 1.015,
        },
      }),
    ]);

    expect(transcript).toEqual([
      expect.objectContaining({
        kind: "result",
        subtype: "paperclip_runner_usage",
        inputTokens: 16,
        outputTokens: 5,
        cachedTokens: 3,
        costUsd: 0.015,
      }),
    ]);
  });

  it("sums delta-only usage reports into one run summary", () => {
    const transcript = nativeRunEventsToTranscript([
      event(1, "usage.reported", {
        runDeltaAvailable: true,
        runDelta: { inputTokens: 2, outputTokens: 1, providerCostUsd: 0.01 },
      }),
      event(2, "usage.reported", {
        runDeltaAvailable: true,
        runDelta: { inputTokens: 3, outputTokens: 4, providerCostUsd: 0.02 },
      }),
    ]);

    expect(transcript).toEqual([
      expect.objectContaining({
        kind: "result",
        inputTokens: 5,
        outputTokens: 5,
        costUsd: 0.03,
      }),
    ]);
  });

  it("uses the latest explicitly session-scoped total when run deltas are unavailable", () => {
    const transcript = nativeRunEventsToTranscript([
      event(1, "usage.reported", {
        runDeltaAvailable: false,
        runDelta: { inputTokens: 0, outputTokens: 0, providerCostUsd: 0 },
        cumulative: { inputTokens: 12, outputTokens: 3, providerCostUsd: 0.01 },
      }),
      event(2, "usage.reported", {
        runDeltaAvailable: false,
        runDelta: { inputTokens: 0, outputTokens: 0, providerCostUsd: 0 },
        cumulative: { inputTokens: 20, outputTokens: 5, providerCostUsd: 0.02 },
      }),
    ]);

    expect(transcript).toEqual([
      expect.objectContaining({
        kind: "result",
        subtype: "paperclip_runner_session_usage",
        inputTokens: 20,
        outputTokens: 5,
        costUsd: 0.02,
        text: expect.stringContaining("session-cumulative"),
      }),
    ]);
  });

  it("fails closed for legacy usage reports without run-delta provenance", () => {
    const transcript = nativeRunEventsToTranscript([
      event(1, "usage.reported", {
        runDelta: { inputTokens: 12, outputTokens: 3, providerCostUsd: 0.01 },
        cumulative: { inputTokens: 112, outputTokens: 53, providerCostUsd: 1.01 },
      }),
      event(2, "usage.reported", {
        runDelta: { inputTokens: 116, outputTokens: 55, providerCostUsd: 1.015 },
      }),
    ]);

    expect(transcript).toEqual([
      expect.objectContaining({
        kind: "result",
        subtype: "paperclip_runner_session_usage",
        inputTokens: 112,
        outputTokens: 53,
        costUsd: 1.01,
      }),
    ]);
  });

  it("uses the structured run summary when no agent message was emitted", () => {
    expect(nativeRunEventsToTranscript([
      event(1, "run.result.proposed", { summary: "Recovered final reply." }),
    ])).toEqual([
      expect.objectContaining({ kind: "assistant", text: "Recovered final reply." }),
    ]);
  });

  it("fails closed for malformed, mismatched, and unknown event envelopes", () => {
    const mismatched = event(1, "item.delta", {
      itemId: "message-1",
      kind: "agentMessage",
      text: "must not render",
    });
    (mismatched.payload!.prpEvent as Record<string, unknown>).runId = "other-run";
    const malformed = event(2, "item.delta", {});
    malformed.payload = { providerNativeSecret: "must not render" };

    expect(nativeRunEventsToTranscript([
      mismatched,
      malformed,
      event(3, "plan.updated", { explanation: "not a transcript row" }),
    ])).toEqual([]);
  });
});
