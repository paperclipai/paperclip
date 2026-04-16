// @vitest-environment jsdom

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { Rt2TaskPanel } from "./Rt2TaskPanel";

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
  }: {
    children: ReactNode;
    onClick?: () => void;
  }) => <button type="button" onClick={onClick}>{children}</button>,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("Rt2TaskPanel", () => {
  it("shows demo-flow state and wires start, assignment, plus capacity-reduction actions", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const onJoin = vi.fn();
    const onAssignParticipant = vi.fn();
    const onChangeCapacity = vi.fn();
    const onEndParticipant = vi.fn();
    const onCreateTodo = vi.fn();
    const onStartTodo = vi.fn();

    act(() => {
      root.render(
        <Rt2TaskPanel
          detail={{
            issueId: "issue-1",
            projectId: "project-1",
            goalId: null,
            title: "Launch collab task",
            description: null,
            status: "todo",
            taskMode: "collab",
            capacity: 2,
            activeParticipantCount: 2,
            deliverableCount: 1,
            todoCount: 1,
            todoInProgressCount: 1,
            participants: [
              {
                id: "participant-1",
                taskIssueId: "issue-1",
                userId: "user-1",
                state: "active",
                endedReason: null,
                joinedAt: new Date("2026-04-16T00:00:00Z"),
                endedAt: null,
              },
              {
                id: "participant-2",
                taskIssueId: "issue-1",
                userId: "user-2",
                state: "active",
                endedReason: null,
                joinedAt: new Date("2026-04-16T00:01:00Z"),
                endedAt: null,
              },
              {
                id: "participant-3",
                taskIssueId: "issue-1",
                userId: "user-3",
                state: "ended",
                endedReason: "capacity_reduced",
                joinedAt: new Date("2026-04-16T00:02:00Z"),
                endedAt: new Date("2026-04-16T00:03:00Z"),
              },
            ],
            deliverables: [{
              workProductId: "wp-1",
              issueId: "issue-1",
              title: "Event brief",
              type: "document",
              state: "defined",
              summary: null,
              isRequired: true,
            }],
            todos: [{
              issueId: "todo-1",
              parentTaskIssueId: "issue-1",
              title: "Confirm venue",
              status: "todo",
              assigneeUserId: "user-1",
              deliverableCount: 1,
              submittedDeliverableCount: 0,
            }],
          }}
          onJoin={onJoin}
          assignableUsers={[
            {
              userId: "user-4",
              membershipRole: "member",
            },
          ]}
          onAssignParticipant={onAssignParticipant}
          onChangeCapacity={onChangeCapacity}
          onEndParticipant={onEndParticipant}
          onCreateTodo={onCreateTodo}
          onStartTodo={onStartTodo}
        />,
      );
    });

    expect(container.textContent).toContain("2 / 2 participants");
    expect(container.textContent).toContain("Confirm venue");
    expect(container.textContent).toContain("Event brief");
    expect(container.textContent).toContain("capacity_reduced");
    expect(container.textContent).toContain("0 / 1 deliverables");
    expect(container.textContent).toContain("Assign participant");

    const buttons = Array.from(container.querySelectorAll("button"));
    const joinButton = buttons.find((button) => button.textContent === "Join");
    const assignButton = buttons.find((button) => button.textContent === "Assign");
    const createTodoButton = buttons.find((button) => button.textContent === "New To-Do");
    const startButton = buttons.find((button) => button.textContent === "Start");
    const reduceCapacityButton = buttons.find((button) => button.textContent === "-1");
    const firstEndButton = buttons.find((button) => button.textContent === "End");
    const assignSelect = container.querySelector("select");

    expect(joinButton).toBeDefined();
    expect(assignButton).toBeDefined();
    expect(assignSelect).toBeDefined();
    expect(createTodoButton).toBeDefined();
    expect(startButton).toBeDefined();
    expect(reduceCapacityButton).toBeDefined();
    expect(firstEndButton).toBeDefined();

    act(() => {
      if (assignSelect instanceof HTMLSelectElement) {
        assignSelect.value = "user-4";
        assignSelect.dispatchEvent(new Event("change", { bubbles: true }));
      }
      joinButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      assignButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      createTodoButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      startButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      reduceCapacityButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      firstEndButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onJoin).toHaveBeenCalledTimes(1);
    expect(onAssignParticipant).toHaveBeenCalledWith("user-4");
    expect(onCreateTodo).toHaveBeenCalledTimes(1);
    expect(onStartTodo).toHaveBeenCalledWith("todo-1");
    expect(onChangeCapacity).toHaveBeenCalledWith(1, ["user-2"]);
    expect(onEndParticipant).toHaveBeenCalledWith("user-1", "manager_removed");

    act(() => root.unmount());
  });
});
