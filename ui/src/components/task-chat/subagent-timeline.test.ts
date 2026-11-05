import { describe, expect, it } from "vitest";
import type { HeartbeatRunEvent } from "@paperclipai/shared";
import { nativeRunEventsToTranscript } from "../transcript/native-run-events";
import type { TranscriptEntry } from "@/adapters";
import { buildTurnTimelineRows, paperclipRunnerTimelineItems, transcriptToTaskChatItems } from "./transcript-adapter";
import type { TaskChatSubagentGroupItem } from "./task-chat-model";

const RUN_ID = "10000000-0000-4000-8000-000000000001";

function event(seq: number, eventType: string, payload: Record<string, unknown>): HeartbeatRunEvent {
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
        emittedAt: `2026-11-05T18:00:${String(seq).padStart(2, "0")}.000Z`,
        payload,
      },
    },
    createdAt: new Date("2026-11-05T18:00:00.000Z"),
  };
}

function delegation(seq: number, id: string, status: string, child: Record<string, unknown>) {
  return event(seq, status === "running" ? (seq < 3 ? "delegation.started" : "delegation.updated") : "delegation.completed", {
    schema: "paperclip.delegation.v1",
    delegationId: id,
    action: "spawn",
    status,
    children: [{ childId: id, model: null, status, activitySummary: null, prompt: null, result: null, ...child }],
  });
}

function tool(seq: number, id: string, done: boolean, parentItemId?: string) {
  return event(seq, done ? "tool.execution.completed" : "tool.execution.started", {
    schema: "paperclip.tool.execution.v1",
    executionId: id,
    transport: "builtin",
    operation: "read",
    name: "Read",
    target: "server/src/webhook.ts",
    status: done ? "completed" : "running",
    output: done ? "ok" : null,
    outputBytes: 0,
    outputTruncated: false,
    outputDigest: null,
    ...(parentItemId ? { parentItemId } : {}),
  });
}

function rows(events: HeartbeatRunEvent[], running: boolean) {
  const items = transcriptToTaskChatItems(nativeRunEventsToTranscript(events), { runId: RUN_ID, running });
  return buildTurnTimelineRows(paperclipRunnerTimelineItems(items), running);
}

describe("subagent timeline rows", () => {
  const spawn = [
    delegation(1, "toolu_a", "running", { role: "Explore", summary: "Trace the retry path", prompt: "Find every retry." }),
    delegation(2, "toolu_b", "running", { role: "general-purpose", summary: "Check provider docs" }),
    tool(3, "toolu_a_read", false, "toolu_a"),
    delegation(4, "toolu_a", "running", { role: "Explore", summary: "Trace the retry path", prompt: "Find every retry.", activitySummary: "Found scheduleRetry" }),
    tool(5, "toolu_a_read", true, "toolu_a"),
    tool(6, "toolu_b_fetch", false, "toolu_b"),
  ];

  it("groups parallel subagents into one tree and nests their tools", () => {
    const timeline = rows(spawn, true);
    const groups = timeline.filter((row): row is TaskChatSubagentGroupItem => row.kind === "subagent_group");
    expect(groups).toHaveLength(1);
    const [a, b] = groups[0]!.subagents;
    expect(a).toMatchObject({
      agentType: "Explore",
      description: "Trace the retry path",
      prompt: "Find every retry.",
      status: "running",
      progressSummary: "Found scheduleRetry",
    });
    expect(a!.activity.map((item) => item.kind === "tool" && item.status)).toEqual(["completed"]);
    expect(b!.activity).toHaveLength(1);
    // Child tools never leak into the parent's activity phases.
    expect(timeline.filter((row) => row.kind === "activity_phase")).toHaveLength(0);
  });

  it("hides the spawning call's own tool row", () => {
    const timeline = rows([...spawn, tool(7, "toolu_a", false)], true);
    expect(timeline.filter((row) => row.kind === "activity_phase")).toHaveLength(0);
  });

  it("settles results and marks a child cut off by the run as stopped", () => {
    const timeline = rows([
      ...spawn,
      delegation(7, "toolu_a", "completed", { role: "Explore", summary: "Trace the retry path", result: "Retries drop the event id." }),
      tool(8, "toolu_top", true),
    ], false);
    const group = timeline.find((row): row is TaskChatSubagentGroupItem => row.kind === "subagent_group")!;
    expect(group.subagents.map((subagent) => subagent.status)).toEqual(["completed", "cancelled"]);
    expect(group.subagents[0]!.result).toBe("Retries drop the event id.");
    expect(group.subagents[1]!.activity.every((item) => item.kind !== "tool" || item.status !== "in_progress")).toBe(true);
    // A top-level tool after the tree starts a normal phase.
    expect(timeline.at(-1)?.kind).toBe("activity_phase");
  });

  it("nests live provider-activity tool rows and hides the spawning call", () => {
    const ts = "2026-11-05T18:00:00.000Z";
    const activity = (eventType: string, payload: Record<string, unknown>): TranscriptEntry => ({
      kind: "provider_activity", ts, family: eventType.startsWith("delegation.") ? "delegation" : "tool_execution",
      eventType, status: "running", title: "", summary: "", payload,
    });
    const entries: TranscriptEntry[] = [
      activity("tool.execution.started", { schema: "paperclip.tool.execution.v1", executionId: "toolu_a", name: "Task", status: "running" }),
      activity("delegation.started", { schema: "paperclip.delegation.v1", delegationId: "toolu_a", action: "spawn", status: "running",
        children: [{ childId: "toolu_a", role: "Explore", summary: "Find tests", status: "running" }] }),
      activity("tool.execution.started", { schema: "paperclip.tool.execution.v1", executionId: "toolu_b", name: "Task", status: "running" }),
      activity("delegation.started", { schema: "paperclip.delegation.v1", delegationId: "toolu_b", action: "spawn", status: "running",
        children: [{ childId: "toolu_b", role: "Explore", summary: "Find docs", status: "running" }] }),
      activity("tool.execution.started", { schema: "paperclip.tool.execution.v1", executionId: "toolu_a1", name: "Read", status: "running", parentItemId: "toolu_a" }),
    ];
    const items = transcriptToTaskChatItems(entries, { runId: RUN_ID, running: true });
    const timeline = buildTurnTimelineRows(paperclipRunnerTimelineItems(items), true);
    expect(timeline.map((row) => row.kind)).toEqual(["subagent_group"]);
    const group = timeline[0] as TaskChatSubagentGroupItem;
    expect(group.subagents.map((subagent) => subagent.activity.length)).toEqual([1, 0]);
  });
});
