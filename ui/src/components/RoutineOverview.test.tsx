// @vitest-environment jsdom

import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import type { RoutineDetail, RoutineRunSummary } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RoutineDetailContext, type RoutineDetailContextValue } from "./routine-sections/context";
import {
  RoutineOverview,
  routineRunIssue,
  summarizeRoutineSchedule,
} from "./RoutineOverview";

const issueRowRender = vi.hoisted(() => vi.fn());

vi.mock("@/components/IssueRow", () => ({
  IssueRow: (props: { issue: { title: string }; presentation?: string }) => {
    issueRowRender(props);
    return <div data-slot="task-row">{props.issue.title}</div>;
  },
}));

vi.mock("@/components/MarkdownBody", () => ({
  MarkdownBody: ({ children }: { children: string }) => <div data-testid="markdown">{children}</div>,
}));

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => (
    <a href={to} {...props}>{children}</a>
  ),
}));

const triggeredAt = new Date("2026-08-31T16:00:00.000Z");
const run: RoutineRunSummary = {
  id: "run-1",
  companyId: "company-1",
  routineId: "routine-1",
  triggerId: "trigger-1",
  source: "schedule",
  status: "succeeded",
  triggeredAt,
  idempotencyKey: null,
  triggerPayload: null,
  dispatchFingerprint: null,
  linkedIssueId: "issue-1",
  coalescedIntoRunId: null,
  failureReason: null,
  completedAt: triggeredAt,
  createdAt: triggeredAt,
  updatedAt: triggeredAt,
  trigger: { id: "trigger-1", kind: "schedule", label: "weekday" },
  linkedIssue: {
    id: "issue-1",
    identifier: "PAP-42",
    title: "Prepare the release digest",
    status: "done",
    priority: "high",
    updatedAt: triggeredAt,
  },
};

const routine = {
  id: "routine-1",
  companyId: "company-1",
  projectId: "project-1",
  folderId: null,
  goalId: null,
  parentIssueId: null,
  title: "Weekly release review",
  description: "Summarize **release readiness** for the operator.",
  assigneeAgentId: "agent-1",
  priority: "medium",
  status: "active",
  concurrencyPolicy: "coalesce_if_active",
  catchUpPolicy: "skip_missed",
  activityGatePolicy: "always",
  activityGateScope: "company",
  variables: [],
  env: { PRIVATE_TOKEN: { type: "secret_ref", secretId: "secret-1" } },
  latestRevisionId: "revision-1",
  latestRevisionNumber: 1,
  createdByAgentId: null,
  createdByUserId: null,
  responsibleUserId: null,
  updatedByAgentId: null,
  updatedByUserId: null,
  lastTriggeredAt: triggeredAt,
  lastEnqueuedAt: triggeredAt,
  createdAt: triggeredAt,
  updatedAt: triggeredAt,
  project: null,
  assignee: { id: "agent-1", name: "Release Manager", role: "manager", title: null, urlKey: "release-manager" },
  parentIssue: null,
  triggers: [{
    id: "trigger-1",
    companyId: "company-1",
    routineId: "routine-1",
    kind: "schedule",
    label: "weekday",
    enabled: true,
    cronExpression: "0 9 * * 1-5",
    timezone: "America/Los_Angeles",
    nextRunAt: new Date("2026-09-01T16:00:00.000Z"),
    lastFiredAt: triggeredAt,
    publicId: null,
    secretId: null,
    signingMode: null,
    replayWindowSec: null,
    lastRotatedAt: null,
    lastResult: "succeeded",
    createdByAgentId: null,
    createdByUserId: null,
    updatedByAgentId: null,
    updatedByUserId: null,
    createdAt: triggeredAt,
    updatedAt: triggeredAt,
  }],
  recentRuns: [run],
  activeIssue: null,
} as RoutineDetail;

function contextFixture(): RoutineDetailContextValue {
  return {
    routine,
    routineId: routine.id,
    companyId: routine.companyId,
    routineRuns: [run],
    currentAssignee: {
      id: "agent-1",
      name: "Release Manager",
      urlKey: "release-manager",
    },
    hasLiveRun: false,
  } as RoutineDetailContextValue;
}

describe("RoutineOverview", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    issueRowRender.mockClear();
    vi.spyOn(Date, "now").mockReturnValue(new Date("2026-08-31T17:00:00.000Z").getTime());
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it("summarizes enabled schedules and their next run", () => {
    expect(summarizeRoutineSchedule(routine.triggers)).toMatchObject({
      label: "1 active schedule",
      detail: "0 9 * * 1-5 · America/Los_Angeles",
      nextRunAt: new Date("2026-09-01T16:00:00.000Z"),
    });
    expect(summarizeRoutineSchedule([{ ...routine.triggers[0]!, enabled: false }])).toEqual({
      label: "No active schedule",
      detail: "Manual runs only",
      nextRunAt: null,
    });
  });

  it("adapts compact run tasks to the canonical task presentation", () => {
    const issue = routineRunIssue(run.linkedIssue!, run, "company-1", "project-1");
    expect(issue).toMatchObject({
      id: "issue-1",
      companyId: "company-1",
      projectId: "project-1",
      status: "done",
      priority: "high",
      originKind: "routine_execution",
      originId: "routine-1",
      originRunId: "run-1",
    });
  });

  it("shows operational facts, readable description, agent, and recent task rows without secrets", () => {
    flushSync(() => root.render(
      <RoutineDetailContext.Provider value={contextFixture()}>
        <RoutineOverview />
      </RoutineDetailContext.Provider>,
    ));

    expect(container.textContent).toContain("1 active schedule");
    expect(container.textContent).toContain("Next run");
    expect(container.textContent).toContain("Release Manager");
    expect(container.textContent).toContain("Summarize **release readiness** for the operator.");
    expect(container.textContent).toContain("Prepare the release digest");
    expect(container.textContent).not.toContain("PRIVATE_TOKEN");
    expect(container.textContent).not.toContain("secret-1");
    expect(issueRowRender).toHaveBeenCalledWith(expect.objectContaining({ presentation: "task" }));
    expect(container.querySelector('a[href="/activity/runs?entityType=routine&entityId=routine-1"]'))
      .not.toBeNull();
    expect(container.querySelector('a[href="/activity?entityType=routine&entityId=routine-1"]'))
      .not.toBeNull();
  });
});
