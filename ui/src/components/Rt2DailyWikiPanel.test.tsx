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
  }: {
    children: ReactNode;
    onClick?: () => void;
    disabled?: boolean;
  }) => (
    <button type="button" onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
}));

import { Rt2DailyWikiPanel } from "./Rt2DailyWikiPanel";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("Rt2DailyWikiPanel", () => {
  it("renders short summary, history, and the canonical query action", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const onAsk = vi.fn();

    act(() => {
      root.render(
        <Rt2DailyWikiPanel
          page={{
            pageKey: "rt2.daily-report:project-1:user-1:2026-04-17",
            companyId: "company-1",
            projectId: "project-1",
            userId: "user-1",
            reportDate: "2026-04-17",
            shortSummary: [
              "짧은 요약: 진행중 1건",
              "짧은 요약: 내일 할 일 1건",
              "짧은 요약: 근거는 아래 히스토리",
            ],
            markdown: "# 2026-04-17 Daily Wiki",
            history: [
              {
                actionId: "log-1",
                occurredAt: new Date("2026-04-17T10:00:00Z"),
                activityType: "todo_moved",
                summary: "오늘 할 일 -> 진행중",
                todoIssueId: "todo-1",
                lane: "support_1",
                bucketLabel: "진행중",
                progressPercent: 70,
                evidenceTag: "EXTRACTED",
              },
            ],
          }}
          answer={null}
          queryPending={false}
          onAsk={onAsk}
        />,
      );
    });

    expect(container.textContent).toContain("짧은 요약: 진행중 1건");
    expect(container.textContent).toContain("오늘 할 일 -> 진행중");

    const askButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "오늘 뭐 했지?",
    );

    expect(askButton).toBeDefined();

    act(() => {
      askButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onAsk).toHaveBeenCalledWith("오늘 뭐 했지?");

    act(() => root.unmount());
  });
});
