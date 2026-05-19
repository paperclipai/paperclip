import { describe, expect, it } from "vitest";
import type { ActivityEvent } from "@paperclipai/shared";

import {
  collapseEventsToRuns,
  summarizeRunTimeline,
} from "./runs-timeline";

function makeEvent(overrides: Partial<ActivityEvent> & { id: string }): ActivityEvent {
  return {
    id: overrides.id,
    companyId: "company-1",
    actorType: overrides.actorType ?? "agent",
    actorId: overrides.actorId ?? "agent-1",
    action: overrides.action ?? "run.started",
    entityType: overrides.entityType ?? "run",
    entityId: overrides.entityId ?? "run-1",
    agentId: overrides.agentId ?? "agent-1",
    runId: overrides.runId ?? null,
    details: overrides.details ?? null,
    createdAt: overrides.createdAt ?? new Date("2026-05-19T12:00:00Z"),
  };
}

describe("collapseEventsToRuns", () => {
  it("groups events by runId and keeps the latest action per run", () => {
    const rows = collapseEventsToRuns([
      makeEvent({
        id: "1",
        runId: "run-a",
        action: "run.tool_call",
        createdAt: new Date("2026-05-19T12:05:00Z"),
      }),
      makeEvent({
        id: "2",
        runId: "run-a",
        action: "run.completed",
        createdAt: new Date("2026-05-19T12:10:00Z"),
      }),
      makeEvent({
        id: "3",
        runId: "run-b",
        action: "run.started",
        createdAt: new Date("2026-05-19T11:00:00Z"),
      }),
    ]);
    expect(rows).toHaveLength(2);
    const runA = rows.find((row) => row.runId === "run-a")!;
    expect(runA.latestAction).toBe("run.completed");
    expect(runA.eventCount).toBe(2);
    // run-a sorts before run-b because its lastActivityAt is newer.
    expect(rows[0].runId).toBe("run-a");
    expect(rows[1].runId).toBe("run-b");
  });

  it("skips events with no runId", () => {
    const rows = collapseEventsToRuns([
      makeEvent({ id: "x", runId: null, action: "issue.commented" }),
    ]);
    expect(rows).toHaveLength(0);
  });

  it("backfills issue identifier and title from older breadcrumbs", () => {
    const rows = collapseEventsToRuns([
      // Latest event lacks the issue context.
      makeEvent({
        id: "latest",
        runId: "run-x",
        action: "run.completed",
        createdAt: new Date("2026-05-19T13:00:00Z"),
        entityType: "run",
        entityId: "run-x",
        details: null,
      }),
      // Older breadcrumb knew the issue context.
      makeEvent({
        id: "older",
        runId: "run-x",
        action: "run.started",
        createdAt: new Date("2026-05-19T12:00:00Z"),
        entityType: "issue",
        entityId: "issue-42",
        details: { identifier: "LET-42", title: "Mission title" },
      }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].issueIdentifier).toBe("LET-42");
    expect(rows[0].issueTitle).toBe("Mission title");
    expect(rows[0].issueId).toBe("issue-42");
    // Latest action still wins.
    expect(rows[0].latestAction).toBe("run.completed");
  });

  it("parses ISO-string createdAt values (handles serialized API payloads)", () => {
    const rows = collapseEventsToRuns([
      makeEvent({
        id: "1",
        runId: "run-iso",
        createdAt: "2026-05-19T12:00:00Z" as unknown as Date,
      }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].lastActivityAt).toBeInstanceOf(Date);
    expect(rows[0].lastActivityAt.toISOString()).toBe("2026-05-19T12:00:00.000Z");
  });
});

describe("summarizeRunTimeline", () => {
  it("counts runs, events, distinct agents, distinct issues, and last event ts", () => {
    const summary = summarizeRunTimeline([
      makeEvent({
        id: "1",
        runId: "run-a",
        agentId: "agent-1",
        entityType: "issue",
        entityId: "issue-1",
        createdAt: new Date("2026-05-19T10:00:00Z"),
      }),
      makeEvent({
        id: "2",
        runId: "run-a",
        agentId: "agent-1",
        entityType: "issue",
        entityId: "issue-1",
        createdAt: new Date("2026-05-19T10:05:00Z"),
      }),
      makeEvent({
        id: "3",
        runId: "run-b",
        agentId: "agent-2",
        entityType: "issue",
        entityId: "issue-2",
        createdAt: new Date("2026-05-19T11:00:00Z"),
      }),
      makeEvent({ id: "4", runId: null, agentId: "agent-3", entityType: "issue", entityId: "issue-3" }),
    ]);
    expect(summary.totalRuns).toBe(2);
    expect(summary.totalEvents).toBe(3);
    expect(summary.distinctAgents).toBe(2);
    expect(summary.distinctIssues).toBe(2);
    expect(summary.lastEventAt?.toISOString()).toBe("2026-05-19T11:00:00.000Z");
  });

  it("returns lastEventAt=null when no run-scoped events exist", () => {
    const summary = summarizeRunTimeline([]);
    expect(summary.totalRuns).toBe(0);
    expect(summary.lastEventAt).toBeNull();
  });
});
