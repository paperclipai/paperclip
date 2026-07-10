// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import type { RoutineDetail, RoutineRunSummary } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunsSection } from "./operate-sections";
import { RoutineDetailContext, type RoutineDetailContextValue } from "./context";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../RoutineHistoryTab", () => ({
  RoutineHistoryTab: () => null,
}));

vi.mock("../MarkdownEditor", () => ({
  MarkdownEditor: () => null,
}));

function act(callback: () => void) {
  flushSync(callback);
}

function makeRoutine(): RoutineDetail {
  return {
    id: "routine-1",
    companyId: "company-1",
    projectId: null,
    goalId: null,
    parentIssueId: null,
    title: "Daily digest",
    description: null,
    assigneeAgentId: null,
    priority: "medium",
    status: "active",
    concurrencyPolicy: "coalesce_if_active",
    catchUpPolicy: "skip_missed",
    variables: [],
    latestRevisionId: null,
    latestRevisionNumber: 1,
    createdByAgentId: null,
    createdByUserId: "user-1",
    responsibleUserId: null,
    updatedByAgentId: null,
    updatedByUserId: "user-1",
    lastTriggeredAt: null,
    lastEnqueuedAt: null,
    createdAt: new Date("2026-07-01T12:00:00.000Z"),
    updatedAt: new Date("2026-07-01T12:00:00.000Z"),
    project: null,
    assignee: null,
    parentIssue: null,
    triggers: [],
    recentRuns: [],
    activeIssue: null,
  };
}

function makeRun(id: string, triggeredAt: string, label: string): RoutineRunSummary {
  return {
    id,
    companyId: "company-1",
    routineId: "routine-1",
    triggerId: `trigger-${id}`,
    source: "api",
    status: "succeeded",
    triggeredAt: new Date(triggeredAt),
    idempotencyKey: null,
    triggerPayload: null,
    dispatchFingerprint: null,
    routineRevisionId: null,
    linkedIssueId: null,
    coalescedIntoRunId: null,
    failureReason: null,
    completedAt: new Date(triggeredAt),
    createdAt: new Date(triggeredAt),
    updatedAt: new Date(triggeredAt),
    linkedIssue: null,
    trigger: {
      id: `trigger-${id}`,
      kind: "api",
      label,
    },
  };
}

function Harness({ runs }: { runs: RoutineRunSummary[] }) {
  const value = {
    routine: makeRoutine(),
    routineRuns: runs,
    hasLiveRun: false,
    activeIssueId: undefined,
    onOpenRunDialog: vi.fn(),
  } as unknown as RoutineDetailContextValue;

  return (
    <RoutineDetailContext.Provider value={value}>
      <RunsSection />
    </RoutineDetailContext.Provider>
  );
}

describe("RunsSection", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-09T12:00:00.000Z"));
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    vi.useRealTimers();
    container.remove();
    document.body.innerHTML = "";
  });

  it("adds the inbox-style earlier divider when routine runs cross the recent window", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <Harness
          runs={[
            makeRun("newer", "2026-07-09T10:00:00.000Z", "Newer execution"),
            makeRun("older", "2026-07-08T10:00:00.000Z", "Older execution"),
          ]}
        />,
      );
    });

    const text = container.textContent ?? "";
    expect(text).toContain("Earlier");
    expect(text.indexOf("Newer execution")).toBeLessThan(text.indexOf("Earlier"));
    expect(text.indexOf("Earlier")).toBeLessThan(text.indexOf("Older execution"));

    act(() => root.unmount());
  });

  it("does not show the earlier divider when all visible runs are recent", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <Harness
          runs={[
            makeRun("newer", "2026-07-09T10:00:00.000Z", "Newer execution"),
            makeRun("recent", "2026-07-08T13:00:00.000Z", "Recent execution"),
          ]}
        />,
      );
    });

    expect(container.textContent).not.toContain("Earlier");

    act(() => root.unmount());
  });
});
