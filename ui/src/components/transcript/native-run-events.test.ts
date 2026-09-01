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

function itemEvent(
  seq: number,
  eventType: "item.started" | "item.delta" | "item.completed",
  itemId: string,
  payload: Record<string, unknown>,
): HeartbeatRunEvent {
  const value = event(seq, eventType, payload);
  (value.payload!.prpEvent as Record<string, unknown>).itemId = itemId;
  return value;
}

function runResult(summary: string): Record<string, unknown> {
  return {
    schema: "paperclip.run_result.v1",
    reportedWorkDisposition: "done",
    summary,
    completionClaim: {
      contractRevision: "test-v1",
      objectiveSatisfied: true,
      criteria: [],
      remainingWork: [],
    },
    evidence: [],
    verification: [],
    attentionRequests: [],
    artifacts: [],
  };
}

describe("nativeRunEventsToTranscript", () => {
  it("projects provider-neutral messages, tools, usage, and the final reply", () => {
    const transcript = nativeRunEventsToTranscript([
      event(6, "run.result.proposed", runResult("Done safely.")),
      event(1, "item.delta", { itemId: "message-1", kind: "agentMessage", text: "Done " }),
      event(2, "item.delta", { itemId: "message-1", kind: "agentMessage", text: "safely." }),
      event(3, "item.completed", { itemId: "message-1", kind: "agentMessage", text: "Done safely." }),
      event(4, "tool.execution.started", {
        schema: "paperclip.tool.execution.v1",
        executionId: "exec-1",
        transport: "process",
        operation: "execute",
        name: "pnpm test",
        status: "running",
        output: null,
        outputBytes: 0,
        outputTruncated: false,
        outputDigest: null,
      }),
      event(5, "tool.execution.completed", {
        schema: "paperclip.tool.execution.v1",
        executionId: "exec-1",
        transport: "process",
        operation: "execute",
        name: "pnpm test",
        status: "completed",
        output: "all green",
        outputBytes: 9,
        outputTruncated: false,
        outputDigest: null,
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

  it("streams canonical kind-less deltas using item identity from item.started", () => {
    expect(nativeRunEventsToTranscript([
      itemEvent(1, "item.started", "message-1", {
        kind: "assistant_message",
        channel: "progress",
        text: "",
      }),
      itemEvent(2, "item.delta", "message-1", { text: "Still " }),
      itemEvent(3, "item.delta", "message-1", { text: "working" }),
    ])).toEqual([
      expect.objectContaining({
        kind: "assistant",
        text: "Still ",
        delta: true,
        channel: "progress",
      }),
      expect.objectContaining({
        kind: "assistant",
        text: "working",
        delta: true,
        channel: "progress",
      }),
    ]);
  });

  it("reads the canonical PRP v1 assistant_message kind as a channel-less final reply", () => {
    expect(nativeRunEventsToTranscript([
      event(1, "item.completed", {
        kind: "assistant_message",
        text: "Canonical persisted reply.",
      }),
      event(2, "run.result.proposed", runResult(
        "Structured fallback must not replace the reply.",
      )),
    ])).toEqual([
      expect.objectContaining({
        kind: "assistant",
        text: "Canonical persisted reply.",
        channel: "unknown",
      }),
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
      event(1, "run.result.proposed", runResult("Recovered final reply.")),
    ])).toEqual([
      expect.objectContaining({
        kind: "assistant",
        text: "Recovered final reply.",
        channel: "final",
      }),
    ]);
  });

  it("prefers an explicit final item completed after the result proposal", () => {
    expect(nativeRunEventsToTranscript([
      event(1, "run.result.proposed", runResult("Structured fallback.")),
      itemEvent(2, "item.completed", "message-final", {
        kind: "assistant_message",
        channel: "final",
        text: "The complete final reply.",
      }),
    ])).toEqual([
      expect.objectContaining({
        kind: "assistant",
        text: "The complete final reply.",
        channel: "final",
      }),
    ]);
  });

  it("does not append a fallback after a channel-less final delta", () => {
    expect(nativeRunEventsToTranscript([
      itemEvent(1, "item.started", "message-final", {
        kind: "assistant_message",
        text: "",
      }),
      itemEvent(2, "item.delta", "message-final", {
        text: "Streamed final reply.",
      }),
      event(3, "run.result.proposed", runResult("Structured fallback.")),
    ])).toEqual([
      expect.objectContaining({
        kind: "assistant",
        text: "Streamed final reply.",
        delta: true,
        channel: "unknown",
      }),
    ]);
  });

  it("keeps progress separate from the final runner response", () => {
    expect(nativeRunEventsToTranscript([
      event(1, "item.completed", {
        itemId: "progress-1",
        kind: "agentMessage",
        channel: "progress",
        text: "Checking the implementation.",
      }),
      event(2, "run.result.accepted", {
        result: runResult("The implementation is ready."),
      }),
    ])).toEqual([
      expect.objectContaining({
        kind: "assistant",
        text: "Checking the implementation.",
        channel: "progress",
      }),
      expect.objectContaining({
        kind: "assistant",
        text: "The implementation is ready.",
        channel: "final",
      }),
    ]);
  });

  it("projects provider-neutral activity without exposing provider envelopes", () => {
    expect(nativeRunEventsToTranscript([
      event(1, "research.started", {
        schema: "paperclip.research.v1",
        researchId: "research-1",
        query: "current behavior",
        status: "running",
      }),
      event(2, "research.completed", {
        schema: "paperclip.research.v1",
        researchId: "research-1",
        query: "current behavior",
        status: "completed",
      }),
    ])).toEqual([
      expect.objectContaining({
        kind: "tool_call",
        name: "research",
        toolUseId: "research:research-1",
      }),
      expect.objectContaining({
        kind: "tool_result",
        toolUseId: "research:research-1",
        content: "current behavior",
      }),
    ]);
  });

  it.each(["running", "pending", "in_progress"])(
    "keeps an explicitly %s activity open even when its event suffix looks terminal",
    (status) => {
      expect(nativeRunEventsToTranscript([
        event(1, "artifact.generated", {
          schema: "paperclip.artifact.generated.v1",
          artifactId: "artifact-1",
          status,
          reference: "artifacts/preview.png",
        }),
      ])).toEqual([
        expect.objectContaining({
          kind: "tool_call",
          toolUseId: "artifact:artifact-1",
        }),
      ]);
    },
  );

  it("fails closed for unsupported versions, prefix lookalikes, and mismatched payload schemas", () => {
    const unsupportedVersion = event(1, "model.verification.updated", {
      schema: "paperclip.model.verification.v1",
      verificationId: "verification-1",
      status: "completed",
      summary: "must not render",
    });
    (unsupportedVersion.payload!.prpEvent as Record<string, unknown>).schemaVersion = 2;

    expect(nativeRunEventsToTranscript([
      unsupportedVersion,
      event(2, "model.provider_message.recorded", {
        schema: "paperclip.model.provider_message.v1",
        routeId: "route-1",
        message: "provider envelope must not render",
      }),
      event(3, "model.verification.updated", {
        schema: "paperclip.provider.native.v1",
        verificationId: "verification-2",
        status: "completed",
        summary: "wrong payload schema must not render",
      }),
    ])).toEqual([]);
  });

  it("fails closed for mismatched tool execution and run result schemas", () => {
    expect(nativeRunEventsToTranscript([
      event(1, "tool.execution.started", {
        schema: "paperclip.provider.native.v1",
        executionId: "exec-1",
        transport: "process",
        operation: "execute",
        status: "running",
      }),
      event(2, "run.result.proposed", {
        schema: "paperclip.provider.native.v1",
        summary: "malformed proposal must not render",
      }),
      event(3, "run.result.accepted", {
        result: {
          schema: "paperclip.provider.native.v1",
          summary: "malformed accepted result must not render",
        },
      }),
      event(4, "run.result.accepted", {
        schema: "paperclip.run_result.v1",
        summary: "accepted wrappers must not masquerade as results",
      }),
    ])).toEqual([]);
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
      event(3, "extension.unknown", { explanation: "not a transcript row" }),
    ])).toEqual([]);
  });
});
