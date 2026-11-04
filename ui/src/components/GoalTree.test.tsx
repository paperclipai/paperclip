// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import type { ReactNode } from "react";
import type { Goal } from "@paperclipai/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GoalTree } from "./GoalTree";

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: { children: ReactNode; to: string }) => (
    <a href={to} {...props}>{children}</a>
  ),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function act(callback: () => void) {
  flushSync(callback);
}

function makeGoal(overrides: Partial<Goal> = {}): Goal {
  return {
    id: "goal-1",
    companyId: "company-1",
    title: "Ship the thing",
    description: null,
    level: "task",
    status: "planned",
    parentId: null,
    ownerAgentId: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

describe("GoalTree delete control", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot> | null;

  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
    }
    container.remove();
    root = null;
  });

  function render(props: Partial<Parameters<typeof GoalTree>[0]> = {}) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const goal = makeGoal();
    act(() => {
      root?.render(
        <GoalTree
          goals={[goal]}
          goalLink={(g) => `/goals/${g.id}`}
          onDelete={() => {}}
          {...props}
        />,
      );
    });
    return { goal };
  }

  it("does not nest the delete button inside the row link", () => {
    render();

    const deleteButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Delete goal \\"Ship the thing\\""]',
    );
    expect(deleteButton).toBeTruthy();

    // A button must never be a descendant of an anchor: nested interactive
    // elements are invalid HTML with undefined keyboard activation behavior.
    expect(deleteButton?.closest("a")).toBeNull();

    const rowLink = container.querySelector("a");
    expect(rowLink).toBeTruthy();
    expect(rowLink?.contains(deleteButton)).toBe(false);
  });

  it("reveals the delete button on keyboard focus, not only on hover", () => {
    render();

    const deleteButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Delete goal \\"Ship the thing\\""]',
    );
    expect(deleteButton).toBeTruthy();

    const classList = deleteButton?.className ?? "";
    expect(classList).toMatch(/group-hover:opacity-100/);
    expect(classList).toMatch(/group-focus-within:opacity-100/);
  });

  it("is independently clickable/focusable as a sibling control of the row link", () => {
    const onDelete = vi.fn();
    const { goal } = render({ onDelete });

    const deleteButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Delete goal \\"Ship the thing\\""]',
    );
    expect(deleteButton).toBeTruthy();

    act(() => {
      deleteButton?.focus();
    });
    expect(document.activeElement).toBe(deleteButton);

    act(() => {
      deleteButton?.click();
    });
    expect(onDelete).toHaveBeenCalledWith(goal);
  });

  it("does not render a delete button when onDelete is not provided", () => {
    render({ onDelete: undefined });
    expect(container.querySelector("button[aria-label^='Delete goal']")).toBeNull();
  });
});
