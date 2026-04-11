import { describe, expect, it } from "vitest";
import type { InstanceSchedulerHeartbeatAgent, RoutineListItem } from "@paperclipai/shared";
import {
  buildActiveRoutineAssigneeIndex,
  buildHeartbeatAuditRows,
  HEARTBEAT_AUDIT_SHORT_INTERVAL_SEC,
} from "./heartbeat-audit";

function createAgent(overrides: Partial<InstanceSchedulerHeartbeatAgent> = {}): InstanceSchedulerHeartbeatAgent {
  return {
    id: "agent-1",
    companyId: "company-1",
    companyName: "Company",
    companyIssuePrefix: "co",
    agentName: "Agent",
    agentUrlKey: "agent",
    role: "general",
    title: null,
    status: "idle",
    adapterType: "codex_local",
    intervalSec: HEARTBEAT_AUDIT_SHORT_INTERVAL_SEC,
    heartbeatEnabled: true,
    schedulerActive: true,
    lastHeartbeatAt: null,
    ...overrides,
  };
}

function createRoutine(overrides: Partial<RoutineListItem> = {}): RoutineListItem {
  return {
    id: "routine-1",
    companyId: "company-1",
    projectId: "project-1",
    goalId: null,
    parentIssueId: null,
    title: "Routine",
    description: null,
    assigneeAgentId: "agent-1",
    priority: "medium",
    status: "active",
    concurrencyPolicy: "allow",
    catchUpPolicy: "skip_missed",
    variables: [],
    createdByAgentId: null,
    createdByUserId: "user-1",
    updatedByAgentId: null,
    updatedByUserId: "user-1",
    lastTriggeredAt: null,
    lastEnqueuedAt: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    triggers: [],
    lastRun: null,
    activeIssue: null,
    ...overrides,
  };
}

describe("buildActiveRoutineAssigneeIndex", () => {
  it("indexes only active routine assignees by company", () => {
    const index = buildActiveRoutineAssigneeIndex({
      "company-1": [
        createRoutine({ assigneeAgentId: "agent-a", status: "active" }),
        createRoutine({ id: "routine-2", assigneeAgentId: "agent-b", status: "paused" }),
      ],
      "company-2": [createRoutine({ id: "routine-3", companyId: "company-2", assigneeAgentId: "agent-c" })],
    });

    expect(index.get("company-1")).toEqual(new Set(["agent-a"]));
    expect(index.get("company-2")).toEqual(new Set(["agent-c"]));
  });
});

describe("buildHeartbeatAuditRows", () => {
  it("flags short intervals and missing routine coverage for active timer heartbeats", () => {
    const rows = buildHeartbeatAuditRows(
      [createAgent({ intervalSec: 300 })],
      new Map(),
      HEARTBEAT_AUDIT_SHORT_INTERVAL_SEC,
    );

    expect(rows[0]).toMatchObject({
      shortInterval: true,
      hasActiveRoutine: false,
      missingRoutineCoverage: true,
      flagged: true,
    });
  });

  it("does not flag missing routine coverage when an active routine is assigned", () => {
    const rows = buildHeartbeatAuditRows(
      [createAgent({ id: "agent-with-routine" })],
      new Map([["company-1", new Set(["agent-with-routine"])]]),
      HEARTBEAT_AUDIT_SHORT_INTERVAL_SEC,
    );

    expect(rows[0]).toMatchObject({
      shortInterval: false,
      hasActiveRoutine: true,
      missingRoutineCoverage: false,
      flagged: false,
    });
  });

  it("does not flag disabled timer heartbeats", () => {
    const rows = buildHeartbeatAuditRows(
      [createAgent({ heartbeatEnabled: false, intervalSec: 120 })],
      new Map(),
      HEARTBEAT_AUDIT_SHORT_INTERVAL_SEC,
    );

    expect(rows[0]).toMatchObject({
      shortInterval: false,
      missingRoutineCoverage: false,
      flagged: false,
    });
  });
});
