// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TaskChatRunnerActivityGroup } from "./TaskChatRunnerActivityGroup";
import { TaskChatExpansionState } from "./expansion-state";
import type { TaskChatActivityPhaseItem, TaskChatAutoReview } from "./task-chat-model";

const review: TaskChatAutoReview = { decision: "allowed", riskLevel: "low", rationale: "Generated output." };

describe("auto-approved activity rows", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function expandOnlyRow(item: TaskChatActivityPhaseItem["items"][number]) {
    act(() => root.render(
      <TaskChatExpansionState.Provider value={new Map()}>
        <TaskChatRunnerActivityGroup
          defaultExpanded
          item={{ id: "phase", kind: "activity_phase", items: [item], active: false, summary: "" }}
        />
      </TaskChatExpansionState.Provider>,
    ));
    const row = container.querySelector<HTMLButtonElement>('[data-activity-item-id] button');
    act(() => row!.click());
  }

  it.each([
    ["a plain tool row", { id: "tool", kind: "tool", name: "shell", target: "rm -rf build", status: "completed", autoReview: review }],
    ["a provider tool execution row", {
      id: "provider-tool", kind: "protocol", surface: "provider_activity", family: "tool_execution",
      eventType: "tool.execution.completed", status: "completed", title: "Tool",
      details: [{ label: "Name", value: "rm -rf build" }], steps: [], links: [], children: [], autoReview: review,
    }],
  ] as const)("shows the review once when %s is expanded", (_label, item) => {
    expandOnlyRow(item as TaskChatActivityPhaseItem["items"][number]);
    expect(container.querySelectorAll('[data-testid="task-chat-auto-approved-badge"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-testid="task-chat-auto-review-detail"]')).toHaveLength(1);
  });
});
