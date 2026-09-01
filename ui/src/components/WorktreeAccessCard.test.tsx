// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorktreeAccessCard } from "./WorktreeAccessCard";
import type { WorktreeAccessState } from "../lib/worktree-access-state";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function act(callback: () => void) {
  flushSync(callback);
}

function accessState(overrides: Partial<WorktreeAccessState> = {}): WorktreeAccessState {
  return {
    state: "ready",
    title: "Ready",
    description: "Opening the worktree signs you in to the cloned board without a password.",
    action: { kind: "open", label: "Open worktree" },
    handoffAvailable: true,
    ...overrides,
  };
}

describe("WorktreeAccessCard", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  function renderCard(props: Partial<Parameters<typeof WorktreeAccessCard>[0]> = {}) {
    const handlers = {
      onOpen: vi.fn(),
      onStart: vi.fn(),
      onRepair: vi.fn(),
      onViewLogs: vi.fn(),
    };
    const root = createRoot(container);
    act(() => {
      root.render(<WorktreeAccessCard access={accessState()} {...handlers} {...props} />);
    });
    const button = container.querySelector("button");
    return { ...handlers, root, button };
  }

  function findButton(label: string) {
    return Array.from(container.querySelectorAll("button")).find(
      (candidate) => candidate.textContent?.trim() === label,
    );
  }

  it("renders the ready state and opens without asking for a password", () => {
    const { onOpen, root } = renderCard();
    const card = container.querySelector("[data-testid='workspace-access-card']");
    expect(card?.getAttribute("data-state")).toBe("ready");
    expect(container.textContent).toContain("Ready");
    expect(container.textContent).toContain("single-use login handoff");

    const button = findButton("Open worktree");
    expect(button).toBeDefined();
    act(() => button!.click());
    expect(onOpen).toHaveBeenCalledTimes(1);

    act(() => root.unmount());
  });

  it("keeps a superseded repair failure visible without hiding the open action", () => {
    const { onOpen, onViewLogs, root } = renderCard({
      access: accessState({
        secondaryNotice: {
          title: "Repair failed",
          description: "The repair stopped during managed_restart. The pre-repair backup was kept.",
          action: { kind: "view_logs", label: "View repair log" },
        },
      }),
    });

    const openButton = findButton("Open worktree");
    const logButton = findButton("View repair log");
    expect(openButton).toBeDefined();
    expect(logButton).toBeDefined();
    expect(container.querySelector("[data-testid='workspace-access-secondary-notice']")?.textContent)
      .toContain("pre-repair backup was kept");

    act(() => openButton!.click());
    act(() => logButton!.click());
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onViewLogs).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
  });

  it("labels the credential fallback accurately when no handoff is available", () => {
    const { root } = renderCard({
      access: accessState({
        handoffAvailable: false,
        description: "Opening the board will ask for the credentials captured in this snapshot.",
      }),
    });
    expect(container.textContent).toContain("snapshot-local credentials captured");
    expect(container.textContent).not.toContain("single-use login handoff");
    act(() => root.unmount());
  });

  it("gives provisioning, degraded, and failed states their own safe action", () => {
    const cases = [
      {
        access: accessState({
          state: "provisioning" as const,
          title: "Provisioning database",
          action: { kind: "start" as const, label: "Start worktree" },
        }),
        label: "Start worktree",
        handlerKey: "onStart" as const,
      },
      {
        access: accessState({
          state: "degraded" as const,
          title: "Worktree is degraded",
          action: { kind: "repair" as const, label: "Repair worktree" },
        }),
        label: "Repair worktree",
        handlerKey: "onRepair" as const,
      },
      {
        access: accessState({
          state: "failed" as const,
          title: "Repair failed",
          action: { kind: "view_logs" as const, label: "View repair log" },
        }),
        label: "View repair log",
        handlerKey: "onViewLogs" as const,
      },
    ];

    for (const testCase of cases) {
      const rendered = renderCard({ access: testCase.access });
      expect(container.textContent).toContain(testCase.access.title);
      const button = findButton(testCase.label);
      expect(button).toBeDefined();
      expect(button!.disabled).toBe(false);
      act(() => button!.click());
      expect(rendered[testCase.handlerKey]).toHaveBeenCalledTimes(1);
      act(() => rendered.root.unmount());
      container.innerHTML = "";
    }
  });

  it("offers nothing clickable while a repair is already running", () => {
    const { root } = renderCard({
      access: accessState({
        state: "repairing",
        title: "Repairing worktree database",
        action: { kind: "wait", label: "Repair in progress" },
      }),
    });
    expect(findButton("Repair in progress")?.disabled).toBe(true);
    expect(
      container.querySelector("[data-testid='workspace-access-badge']")?.textContent,
    ).toContain("Repairing");
    act(() => root.unmount());
  });

  it("always names the state and the cause instead of a bare failure", () => {
    const { root } = renderCard({
      access: accessState({
        state: "failed",
        title: "Database provisioning failed",
        description: "The clone failed during restore. Repairing replaces only the isolated database.",
        action: { kind: "repair", label: "Repair worktree" },
      }),
      errorMessage: "Failed to open the worktree.",
    });
    expect(container.textContent).toContain("Database provisioning failed");
    expect(container.textContent).toContain("failed during restore");
    expect(
      container.querySelector("[data-testid='workspace-access-error']")?.textContent,
    ).toContain("Failed to open the worktree.");
    act(() => root.unmount());
  });

  it("disables the action while the caller reports it busy", () => {
    const { root } = renderCard({ isBusy: true });
    expect(findButton("Open worktree")?.disabled).toBe(true);
    act(() => root.unmount());
  });
});
