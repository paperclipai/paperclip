// @vitest-environment jsdom

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { Rt2TaskList } from "./Rt2TaskList";

vi.mock("@/lib/router", () => ({
  Link: ({
    children,
    to,
    className,
  }: {
    children: ReactNode;
    to: string;
    className?: string;
  }) => <a href={to} className={className}>{children}</a>,
}));

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

describe("Rt2TaskList", () => {
  it("renders demo-flow task cards and opens the task composer", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const onCreateTask = vi.fn();

    act(() => {
      root.render(
        <Rt2TaskList
          companyId="company-1"
          projectId="project-1"
          tasks={[{
            issueId: "issue-1",
            projectId: "project-1",
            goalId: null,
            title: "Prepare launch checklist",
            description: null,
            status: "in_progress",
            taskMode: "collab",
            capacity: 3,
            activeParticipantCount: 2,
            deliverableCount: 1,
            todoCount: 2,
            todoInProgressCount: 1,
          }]}
          onCreateTask={onCreateTask}
        />,
      );
    });

    expect(container.textContent).toContain("Prepare launch checklist");
    expect(container.textContent).toContain("2 / 3 participants");
    expect(container.textContent).toContain("2 todos");
    expect(container.textContent).toContain("1 deliverables");
    expect(container.textContent).toContain("in progress");

    const createButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("New Task"));
    expect(createButton).toBeDefined();

    act(() => {
      createButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onCreateTask).toHaveBeenCalledTimes(1);

    act(() => root.unmount());
  });
});
