// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TaskChatItem, TaskChatProviderActivityItem } from "./task-chat-model";
import {
  TaskChatTurnStatusIsland,
  taskChatTurnPlanRows,
  taskChatTurnPlanSegment,
  taskChatTurnStatusModel,
} from "./TaskChatTurnStatusIsland";

function plan(steps: TaskChatProviderActivityItem["steps"], transcriptIndex = 1): TaskChatProviderActivityItem {
  return {
    id: "plan",
    kind: "protocol",
    surface: "provider_activity",
    family: "plan",
    eventType: "plan.updated",
    status: "running",
    title: "Plan",
    details: [],
    steps,
    links: [],
    children: [],
    transcriptIndex,
  };
}

const workspace: TaskChatItem = {
  id: "workspace",
  kind: "protocol",
  surface: "workspace_change",
  changeSetId: "turn-1:workspace",
  revision: 2,
  source: "harness_reported",
  complete: false,
  files: [
    { path: "one.ts", operation: "modify", previousPath: null, additions: 4, deletions: 2, binary: false, diff: null },
    { path: "two.ts", operation: "create", previousPath: null, additions: 8, deletions: 0, binary: false, diff: null },
  ],
  totals: { files: 2, additions: 12, deletions: 2 },
  patchArtifactRef: null,
};

describe("TaskChatTurnStatusIsland", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
  });

  it("selects in-progress, blocked, pending, then final completed steps", () => {
    const inProgress = taskChatTurnStatusModel([plan([
      { id: "one", label: "Done", status: "completed" },
      { id: "two", label: "Active", status: "in_progress" },
      { id: "three", label: "Later", status: "pending" },
    ])]);
    expect(inProgress?.segments[0]).toMatchObject({ kind: "plan", currentStepIndex: 1, complete: false });

    const blocked = taskChatTurnStatusModel([plan([
      { id: "one", label: "Blocked", status: "blocked" },
      { id: "two", label: "Later", status: "pending" },
    ])]);
    expect(blocked?.segments[0]).toMatchObject({ kind: "plan", currentStepIndex: 0 });

    const completed = taskChatTurnStatusModel([plan([
      { id: "one", label: "Done", status: "completed" },
      { id: "two", label: "Also done", status: "completed" },
    ])]);
    expect(completed?.segments[0]).toMatchObject({ kind: "plan", currentStepIndex: 1, complete: true });
  });

  it("uses the latest plan snapshot and combines it with diff totals", () => {
    const model = taskChatTurnStatusModel([
      plan([{ id: "old", label: "Old", status: "in_progress" }], 1),
      workspace,
      plan([
        { id: "one", label: "Inspect", status: "completed" },
        { id: "two", label: "Build", status: "in_progress" },
      ], 3),
    ]);
    expect(model?.segments).toEqual([
      expect.objectContaining({ kind: "plan", currentStepIndex: 1 }),
      { kind: "workspace_diff", files: 2, additions: 12, deletions: 2 },
    ]);
  });

  function render(model: NonNullable<ReturnType<typeof taskChatTurnStatusModel>>, props: { defaultCollapsed?: boolean; compact?: boolean } = {}) {
    act(() => root.render(<TaskChatTurnStatusIsland model={model} {...props} />));
    return container.querySelector<HTMLElement>('[data-testid="task-chat-turn-status-island"]')!;
  }
  const checklist = () => container.querySelector('[aria-label="Within-turn checklist"]');
  const header = () => container.querySelector<HTMLElement>('[data-testid="task-chat-turn-plan-header"]')!;

  it("shows the checklist inline with the current step highlighted", () => {
    const island = render(taskChatTurnStatusModel([
      plan([
        { id: "one", label: "Inspect", status: "completed" },
        { id: "two", label: "Build the island", status: "in_progress" },
        { id: "three", label: "Verify", status: "pending" },
      ]),
      workspace,
    ])!);
    expect(island.getAttribute("data-plan-state")).toBe("active");
    expect(container.querySelector('[data-testid="task-chat-turn-plan-headline"]')?.textContent).toBe("Build the island");
    expect(container.querySelector('[data-testid="task-chat-turn-plan-progress"]')?.textContent).toContain("1/3");
    expect(island.textContent).toContain("+12");
    expect(checklist()?.textContent).toContain("Inspect");
    expect(checklist()?.textContent).toContain("Verify");
    expect(checklist()?.querySelector('[aria-current="step"]')?.textContent).toContain("Build the island");
    expect(header().getAttribute("aria-expanded")).toBe("true");
  });

  it("collapses and reopens from the header", () => {
    render(taskChatTurnStatusModel([plan([
      { id: "one", label: "Inspect", status: "completed" },
      { id: "two", label: "Build", status: "in_progress" },
    ])])!);
    act(() => header().click());
    expect(checklist()).toBeNull();
    expect(header().getAttribute("aria-expanded")).toBe("false");
    act(() => header().click());
    expect(checklist()).not.toBeNull();
  });

  it("auto-collapses a completed plan but lets the viewer reopen it", () => {
    render(taskChatTurnStatusModel([plan([
      { id: "one", label: "Inspect", status: "completed" },
      { id: "two", label: "Build", status: "completed" },
    ])])!);
    expect(container.querySelector('[data-testid="task-chat-turn-plan-headline"]')?.textContent).toBe("All 2 steps done");
    expect(checklist()).toBeNull();
    act(() => header().click());
    expect(checklist()?.querySelector('[aria-current="step"]')).toBeNull();
  });

  it("headlines blocked and not-yet-started plans", () => {
    render(taskChatTurnStatusModel([plan([
      { id: "one", label: "Inspect", status: "completed" },
      { id: "two", label: "Run tests", status: "blocked" },
    ])])!);
    expect(container.querySelector('[data-testid="task-chat-turn-plan-headline"]')?.textContent).toBe("Blocked: Run tests");
    expect(container.querySelector('[data-plan-state]')?.getAttribute("data-plan-state")).toBe("blocked");

    render(taskChatTurnStatusModel([plan([
      { id: "a", label: "Inspect", status: "pending" },
      { id: "b", label: "Build", status: "pending" },
    ], 2)])!);
    expect(container.querySelector('[data-testid="task-chat-turn-plan-headline"]')?.textContent).toBe("Up next: Inspect");
  });

  it("renders header-only for single steps, compact mode, and collapsed-by-default", () => {
    const twoSteps = taskChatTurnStatusModel([plan([
      { id: "one", label: "Inspect", status: "in_progress" },
      { id: "two", label: "Build", status: "pending" },
    ])])!;
    render(taskChatTurnStatusModel([plan([{ id: "one", label: "Answer", status: "in_progress" }])])!);
    expect(checklist()).toBeNull();
    expect(header().tagName).toBe("DIV");

    act(() => root.unmount());
    root = createRoot(container);
    render(twoSteps, { compact: true });
    expect(checklist()).toBeNull();
    expect(header().tagName).toBe("DIV");

    act(() => root.unmount());
    root = createRoot(container);
    render(twoSteps, { defaultCollapsed: true });
    expect(checklist()).toBeNull();
    expect(header().getAttribute("aria-expanded")).toBe("false");
  });

  it("windows long plans around the current step and expands on demand", () => {
    const labels = Array.from({ length: 12 }, (_, index) => `Step ${index + 1}`);
    const steps = labels.map((label, index) => ({
      id: `s${index}`,
      label,
      status: index < 6 ? "completed" as const : index === 6 ? "in_progress" as const : "pending" as const,
    }));
    const segment = taskChatTurnPlanSegment(steps);
    const rows = taskChatTurnPlanRows(segment, false);
    expect(rows[0]).toEqual({ kind: "earlier", count: 5, allCompleted: true });
    expect(rows.filter((row) => row.kind === "step")).toHaveLength(5);
    expect(rows.at(-1)).toEqual({ kind: "more", count: 2 });
    expect(taskChatTurnPlanRows(segment, true)).toHaveLength(12);
    expect(taskChatTurnPlanRows(taskChatTurnPlanSegment(steps.slice(0, 7)), false)).toHaveLength(7);

    render(taskChatTurnStatusModel([plan(steps)])!);
    expect(checklist()?.querySelectorAll("[data-step-status]")).toHaveLength(5);
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="task-chat-turn-plan-more"]')!.click());
    expect(checklist()?.querySelectorAll("[data-step-status]")).toHaveLength(12);
  });

  it("renders diff-only status as a pill without a checklist", () => {
    const island = render(taskChatTurnStatusModel([workspace])!);
    expect(island.tagName).toBe("DIV");
    expect(island.getAttribute("role")).toBe("status");
    expect(island.textContent).toContain("2 files changed");
    expect(island.textContent).toContain("+12");
    expect(checklist()).toBeNull();
  });

  it("hides empty snapshots", () => {
    expect(taskChatTurnStatusModel([])).toBeNull();
    expect(taskChatTurnStatusModel([plan([]), { ...workspace, files: [], totals: { files: 0, additions: 0, deletions: 0 } }])).toBeNull();
  });
});
