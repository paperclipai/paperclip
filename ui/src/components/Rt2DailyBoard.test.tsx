// @vitest-environment jsdom

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
    disabled,
    "aria-label": ariaLabel,
  }: {
    children: ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    "aria-label"?: string;
  }) => (
    <button type="button" onClick={onClick} disabled={disabled} aria-label={ariaLabel}>
      {children}
    </button>
  ),
}));

import { Rt2DailyBoard } from "./Rt2DailyBoard";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("Rt2DailyBoard", () => {
  it("renders the approved three-lane board and saves card lane changes", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const onSaveCard = vi.fn();

    act(() => {
      root.render(
        <Rt2DailyBoard
          board={{
            companyId: "company-1",
            projectId: "project-1",
            userId: "user-1",
            reportDate: "2026-04-17",
            cards: [
              {
                taskIssueId: "task-1",
                todoIssueId: "todo-1",
                taskTitle: "주간 보고",
                todoTitle: "주간 보고서 작성",
                assigneeUserId: "user-1",
                reportDate: "2026-04-17",
                lane: "today",
                bucketLabel: "",
                progressPercent: 30,
                note: "오전 착수",
                status: "in_progress",
                updatedAt: new Date("2026-04-17T09:00:00Z"),
              },
            ],
          }}
          pendingTodoIssueId={null}
          onSaveCard={onSaveCard}
        />,
      );
    });

    expect(container.textContent).toContain("오늘 할 일");
    expect(container.textContent).toContain("보조창 1");
    expect(container.textContent).toContain("보조창 2");
    expect(container.textContent).toContain("주간 보고서 작성");

    const laneSelect = container.querySelector('select[aria-label="todo-1-lane"]');
    const saveButton = container.querySelector('button[aria-label="todo-1-save"]');

    expect(laneSelect).toBeDefined();
    expect(saveButton).toBeDefined();

    act(() => {
      if (laneSelect instanceof HTMLSelectElement) {
        laneSelect.value = "support_1";
        laneSelect.dispatchEvent(new Event("change", { bubbles: true }));
      }
      saveButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onSaveCard).toHaveBeenCalledWith(
      "todo-1",
      expect.objectContaining({
        projectId: "project-1",
        reportDate: "2026-04-17",
        lane: "support_1",
      }),
    );

    act(() => root.unmount());
  });
});
