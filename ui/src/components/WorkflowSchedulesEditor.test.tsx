// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowSchedule } from "@paperclipai/shared";
import { WorkflowSchedulesEditor } from "./WorkflowSchedulesEditor";

const onCreateMock = vi.fn();
const onUpdateMock = vi.fn();
const onDeleteMock = vi.fn();

const schedule: WorkflowSchedule = {
  id: "schedule-1",
  companyId: "company-1",
  workflowId: "workflow-1",
  title: "Daily brief",
  status: "active",
  cronExpression: "0 9 * * *",
  timezone: "UTC",
  templateMarkdown: "Send the brief.",
  lastFiredAt: null,
  nextRunAt: new Date("2026-06-10T09:00:00.000Z"),
  createdByUserId: "board-user",
  updatedByUserId: "board-user",
  createdAt: new Date("2026-06-10T08:00:00.000Z"),
  updatedAt: new Date("2026-06-10T08:00:00.000Z"),
};

describe("WorkflowSchedulesEditor", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    onCreateMock.mockReset();
    onUpdateMock.mockReset();
    onDeleteMock.mockReset();
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    document.body.innerHTML = "";
  });

  it("keeps the edit draft visible when an update fails", async () => {
    onUpdateMock.mockRejectedValueOnce(new Error("boom"));

    await act(async () => {
      root.render(
        <WorkflowSchedulesEditor
          schedules={[schedule]}
          onCreate={onCreateMock}
          onUpdate={onUpdateMock}
          onDelete={onDeleteMock}
        />,
      );
    });

    const editButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Edit"),
    );

    expect(editButton).toBeTruthy();

    await act(async () => {
      editButton!.click();
    });

    const titleInput = Array.from(container.querySelectorAll("input")).find(
      (input) => (input as HTMLInputElement).value === schedule.title,
    ) as HTMLInputElement | undefined;
    expect(titleInput).toBeTruthy();

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(titleInput!, "Updated brief");
      titleInput!.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const saveButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Save"),
    );

    expect(saveButton).toBeTruthy();

    await act(async () => {
      saveButton!.click();
      await Promise.resolve();
    });

    expect(onUpdateMock).toHaveBeenCalledWith("schedule-1", expect.objectContaining({
      title: "Updated brief",
      cronExpression: "0 9 * * *",
      templateMarkdown: "Send the brief.",
      status: "active",
    }));
    expect(container.textContent).toContain("Save");
    expect(
      Array.from(container.querySelectorAll("input")).some(
        (input) => (input as HTMLInputElement).value === "Updated brief",
      ),
    ).toBe(true);
  });

  it("does not reset the edit draft when schedules refetch", async () => {
    await act(async () => {
      root.render(
        <WorkflowSchedulesEditor
          schedules={[schedule]}
          onCreate={onCreateMock}
          onUpdate={onUpdateMock}
          onDelete={onDeleteMock}
        />,
      );
    });

    const editButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Edit"),
    );
    expect(editButton).toBeTruthy();

    await act(async () => {
      editButton!.click();
    });

    const titleInput = Array.from(container.querySelectorAll("input")).find(
      (input) => (input as HTMLInputElement).value === schedule.title,
    ) as HTMLInputElement | undefined;
    expect(titleInput).toBeTruthy();

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(titleInput!, "Updated brief");
      titleInput!.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const refreshedSchedule: WorkflowSchedule = {
      ...schedule,
      nextRunAt: new Date("2026-06-10T09:05:00.000Z"),
      updatedAt: new Date("2026-06-10T09:05:00.000Z"),
    };

    await act(async () => {
      root.render(
        <WorkflowSchedulesEditor
          schedules={[refreshedSchedule]}
          onCreate={onCreateMock}
          onUpdate={onUpdateMock}
          onDelete={onDeleteMock}
        />,
      );
    });

    expect(
      Array.from(container.querySelectorAll("input")).some(
        (input) => (input as HTMLInputElement).value === "Updated brief",
      ),
    ).toBe(true);
  });
});
