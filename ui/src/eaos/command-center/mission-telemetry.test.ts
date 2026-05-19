import { describe, expect, it } from "vitest";
import type { Agent, Issue } from "@paperclipai/shared";

import { MISSION_TELEMETRY_TEST_HELPERS } from "./mission-telemetry";

const { countMissions, summarizeAgents, activityMs } = MISSION_TELEMETRY_TEST_HELPERS;

// LET-484 unit pins for the mission-telemetry helpers. The Command Center
// integration test in `CommandCenterLanding.test.tsx` exercises the rendered
// surface but routes through react-query mocking; these direct unit tests
// lock the pure bucketing/sorting math cheaply so future changes (e.g. a new
// status, a new agent state) surface in a focused failure rather than a
// scattered integration regression.

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  const base: Issue = {
    id: "issue-1",
    companyId: "company-1",
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title: "Untitled mission",
    description: null,
    status: "in_progress",
    workMode: "standard",
    priority: "medium",
    assigneeAgentId: null,
    assigneeUserId: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    createdByAgentId: null,
    createdByUserId: null,
    issueNumber: null,
    identifier: null,
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    executionWorkspaceId: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    lastActivityAt: null,
    createdAt: new Date("2026-05-19T12:00:00Z"),
    updatedAt: new Date("2026-05-19T12:00:00Z"),
  } as Issue;
  return { ...base, ...overrides } as Issue;
}

describe("countMissions", () => {
  it("buckets every mission status into a dedicated counter and tracks total", () => {
    const counts = countMissions([
      makeIssue({ id: "1", status: "in_progress" }),
      makeIssue({ id: "2", status: "in_progress" }),
      makeIssue({ id: "3", status: "in_review" }),
      makeIssue({ id: "4", status: "blocked" }),
      makeIssue({ id: "5", status: "todo" }),
      makeIssue({ id: "6", status: "backlog" }),
      makeIssue({ id: "7", status: "done" }),
      makeIssue({ id: "8", status: "cancelled" }),
    ]);
    expect(counts).toEqual({
      active: 2,
      inReview: 1,
      blocked: 1,
      queued: 2,
      done: 1,
      cancelled: 1,
      total: 8,
    });
  });

  it("returns all zeros (and total=0) for an empty mission list", () => {
    expect(countMissions([])).toEqual({
      active: 0,
      inReview: 0,
      blocked: 0,
      queued: 0,
      done: 0,
      cancelled: 0,
      total: 0,
    });
  });
});

describe("summarizeAgents", () => {
  it("counts active and executing agents per LET-167 status vocabulary", () => {
    const summary = summarizeAgents([
      { id: "1", status: "active" } as Agent,
      { id: "2", status: "running" } as Agent,
      { id: "3", status: "running" } as Agent,
      { id: "4", status: "idle" } as Agent,
      { id: "5", status: "paused" } as Agent,
      { id: "6", status: "error" } as Agent,
    ]);
    expect(summary).toEqual({ total: 6, active: 4, executing: 2 });
  });

  it("returns zeros for an empty agent roster", () => {
    expect(summarizeAgents([])).toEqual({ total: 0, active: 0, executing: 0 });
  });
});

describe("activityMs", () => {
  it("prefers lastActivityAt when present", () => {
    const issue = makeIssue({
      lastActivityAt: new Date("2026-05-19T15:00:00Z"),
      updatedAt: new Date("2026-05-19T10:00:00Z"),
      createdAt: new Date("2026-05-19T00:00:00Z"),
    });
    expect(activityMs(issue)).toBe(new Date("2026-05-19T15:00:00Z").getTime());
  });

  it("falls back to updatedAt when lastActivityAt is missing", () => {
    const issue = makeIssue({
      lastActivityAt: null,
      updatedAt: new Date("2026-05-19T10:00:00Z"),
      createdAt: new Date("2026-05-19T00:00:00Z"),
    });
    expect(activityMs(issue)).toBe(new Date("2026-05-19T10:00:00Z").getTime());
  });

  it("falls back to createdAt when lastActivityAt and updatedAt are both missing", () => {
    const issue = makeIssue({
      lastActivityAt: null,
      updatedAt: null as unknown as Date,
      createdAt: new Date("2026-05-19T00:00:00Z"),
    });
    expect(activityMs(issue)).toBe(new Date("2026-05-19T00:00:00Z").getTime());
  });

  it("returns 0 for an issue with no activity, update, or creation timestamp", () => {
    const issue = makeIssue({
      lastActivityAt: null,
      updatedAt: null as unknown as Date,
      createdAt: null as unknown as Date,
    });
    expect(activityMs(issue)).toBe(0);
  });

  it("parses ISO-string timestamps (handles serialized API payloads)", () => {
    const issue = makeIssue({
      lastActivityAt: "2026-05-19T15:00:00Z" as unknown as Date,
      updatedAt: null as unknown as Date,
      createdAt: null as unknown as Date,
    });
    expect(activityMs(issue)).toBe(new Date("2026-05-19T15:00:00Z").getTime());
  });

  it("returns 0 for an unparseable activity timestamp", () => {
    const issue = makeIssue({
      lastActivityAt: "not-a-date" as unknown as Date,
      updatedAt: null as unknown as Date,
      createdAt: null as unknown as Date,
    });
    expect(activityMs(issue)).toBe(0);
  });
});
