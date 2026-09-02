// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TaskChatItem, TaskChatProviderActivityItem } from "./task-chat-model";
import {
  TaskChatTurnStatusIsland,
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

  it("renders a focusable plan capsule and opens the complete checklist", () => {
    const model = taskChatTurnStatusModel([
      plan([
        { id: "one", label: "Inspect", status: "completed" },
        { id: "two", label: "Build the island", status: "in_progress" },
        { id: "three", label: "Verify", status: "pending" },
      ]),
      workspace,
    ])!;
    act(() => root.render(<TaskChatTurnStatusIsland model={model} />));
    const island = container.querySelector('[data-testid="task-chat-turn-status-island"]') as HTMLButtonElement;
    expect(island.tagName).toBe("BUTTON");
    expect(island.textContent).toContain("Step 2 / 3");
    expect(island.textContent).toContain("2 files changed");
    expect(island.getAttribute("aria-label")).toContain("Build the island");

    act(() => island.focus());
    const checklist = document.body.querySelector('[aria-label="Within-turn checklist"]');
    expect(checklist?.textContent).toContain("Inspect");
    expect(checklist?.textContent).toContain("Build the island");
    expect(checklist?.textContent).toContain("Verify");
    expect(checklist?.querySelector('[aria-current="step"]')?.textContent).toContain("Build the island");
  });

  it("renders diff-only status without an empty interactive popover", () => {
    const model = taskChatTurnStatusModel([workspace])!;
    act(() => root.render(<TaskChatTurnStatusIsland model={model} />));
    const island = container.querySelector('[data-testid="task-chat-turn-status-island"]') as HTMLElement;
    expect(island.tagName).toBe("DIV");
    expect(island.getAttribute("role")).toBe("status");
    expect(island.textContent).toContain("+12");
    expect(document.body.querySelector('[aria-label="Within-turn checklist"]')).toBeNull();
  });

  it("toggles the checklist for touch/click input and closes it with Escape", () => {
    const model = taskChatTurnStatusModel([plan([
      { id: "one", label: "Inspect", status: "completed" },
      { id: "two", label: "Build", status: "in_progress" },
    ])])!;
    act(() => root.render(<TaskChatTurnStatusIsland model={model} />));
    const island = container.querySelector<HTMLButtonElement>('[data-testid="task-chat-turn-status-island"]')!;

    act(() => island.click());
    expect(document.body.querySelector('[aria-label="Within-turn checklist"]')).not.toBeNull();
    act(() => island.click());
    expect(document.body.querySelector('[aria-label="Within-turn checklist"]')).toBeNull();

    act(() => island.click());
    act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(document.body.querySelector('[aria-label="Within-turn checklist"]')).toBeNull();
  });

  it("hides empty snapshots", () => {
    expect(taskChatTurnStatusModel([])).toBeNull();
    expect(taskChatTurnStatusModel([plan([]), { ...workspace, files: [], totals: { files: 0, additions: 0, deletions: 0 } }])).toBeNull();
  });
});
