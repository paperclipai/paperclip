// @vitest-environment jsdom

import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Agent, Goal } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GoalProperties } from "./GoalProperties";

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

const mockAgentsApi = vi.hoisted(() => ({
  list: vi.fn(),
}));
const mockGoalsApi = vi.hoisted(() => ({
  list: vi.fn(),
}));

vi.mock("../api/agents", () => ({
  agentsApi: mockAgentsApi,
}));

vi.mock("../api/goals", () => ({
  goalsApi: mockGoalsApi,
}));

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: { children: ReactNode; to: string }) => (
    <a href={to} {...props}>{children}</a>
  ),
}));

vi.mock("@/components/ui/separator", () => ({
  Separator: () => <hr />,
}));

// Bypass Radix popover open/close mechanics: always render trigger + content.
vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("./AgentIconPicker", () => ({
  AgentIcon: () => null,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

async function waitForAssertion(assertion: () => void, attempts = 20) {
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await flush();
    }
  }

  throw lastError;
}

function makeGoal(overrides: Partial<Goal> = {}): Goal {
  return {
    id: "goal-1",
    companyId: "company-1",
    title: "Test Goal",
    description: "Goal description",
    level: "task",
    status: "planned",
    parentId: null,
    ownerAgentId: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agent-1",
    companyId: "company-1",
    name: "Alpha Agent",
    urlKey: "alpha",
    role: "engineer",
    title: null,
    icon: null,
    status: "active",
    reportsTo: null,
    capabilities: null,
    adapterType: "codex_local",
    adapterConfig: {},
    runtimeConfig: {},
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    pauseReason: null,
    pausedAt: null,
    permissions: { canCreateAgents: false },
    lastHeartbeatAt: null,
    metadata: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

function findButtonByText(root: HTMLElement, text: string): HTMLButtonElement | undefined {
  return Array.from(root.querySelectorAll("button")).find((b) => b.textContent?.trim() === text);
}

describe("GoalProperties interactions", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot> | null;
  let queryClient: QueryClient;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = null;
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    mockAgentsApi.list.mockResolvedValue([
      makeAgent({ id: "agent-1", name: "Alpha Agent" }),
      makeAgent({ id: "agent-2", name: "Beta Agent" }),
    ]);
    mockGoalsApi.list.mockResolvedValue([]);
  });

  afterEach(async () => {
    const currentRoot = root;
    if (currentRoot) {
      await act(async () => {
        currentRoot.unmount();
      });
    }
    queryClient.clear();
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  function render(props: Partial<Parameters<typeof GoalProperties>[0]> & { goal: Goal }) {
    root = createRoot(container);
    root.render(
      <QueryClientProvider client={queryClient}>
        <GoalProperties {...props} />
      </QueryClientProvider>,
    );
  }

  describe("delete confirmation flow", () => {
    it("requires a confirmation step before calling onDelete", async () => {
      const onDelete = vi.fn();
      render({ goal: makeGoal(), onUpdate: () => {}, onDelete });
      await flush();

      expect(container.textContent).not.toContain("This action cannot be undone");
      expect(onDelete).not.toHaveBeenCalled();

      const deleteTrigger = findButtonByText(container, "Delete Goal");
      expect(deleteTrigger).toBeTruthy();
      await act(async () => {
        deleteTrigger?.click();
      });
      await flush();

      expect(container.textContent).toContain("This action cannot be undone");
      expect(onDelete).not.toHaveBeenCalled();

      const confirmButton = findButtonByText(container, "Confirm Delete");
      await act(async () => {
        confirmButton?.click();
      });
      await flush();

      expect(onDelete).toHaveBeenCalledTimes(1);
    });

    it("cancels out of the confirmation step without calling onDelete", async () => {
      const onDelete = vi.fn();
      render({ goal: makeGoal(), onUpdate: () => {}, onDelete });
      await flush();

      await act(async () => {
        findButtonByText(container, "Delete Goal")?.click();
      });
      await flush();
      expect(container.textContent).toContain("This action cannot be undone");

      await act(async () => {
        findButtonByText(container, "Cancel")?.click();
      });
      await flush();

      expect(container.textContent).not.toContain("This action cannot be undone");
      expect(onDelete).not.toHaveBeenCalled();
    });

    it("disables confirm/cancel buttons and shows pending state while deleting", async () => {
      const onDelete = vi.fn();
      render({ goal: makeGoal(), onUpdate: () => {}, onDelete, deletePending: true });
      await flush();

      await act(async () => {
        findButtonByText(container, "Delete Goal")?.click();
      });
      await flush();

      const deletingButton = findButtonByText(container, "Deleting...");
      expect(deletingButton).toBeTruthy();
      expect(deletingButton?.disabled).toBe(true);
    });

    it("surfaces a delete error message inside the confirmation panel", async () => {
      const onDelete = vi.fn();
      render({
        goal: makeGoal(),
        onUpdate: () => {},
        onDelete,
        deleteError: "Cannot delete a goal with linked issues",
      });
      await flush();

      await act(async () => {
        findButtonByText(container, "Delete Goal")?.click();
      });
      await flush();

      expect(container.textContent).toContain("Cannot delete a goal with linked issues");
      const alert = container.querySelector('[role="alert"]');
      expect(alert?.textContent).toContain("Cannot delete a goal with linked issues");
    });

    it("does not render the delete action when onDelete is not provided", async () => {
      render({ goal: makeGoal(), onUpdate: () => {} });
      await flush();

      expect(findButtonByText(container, "Delete Goal")).toBeUndefined();
    });
  });

  describe("owner reassignment", () => {
    it("calls onUpdate with the selected agent id when an owner is chosen", async () => {
      const onUpdate = vi.fn();
      render({ goal: makeGoal({ ownerAgentId: null }), onUpdate });
      await flush();

      let betaOption: HTMLButtonElement | undefined;
      await waitForAssertion(() => {
        betaOption = findButtonByText(container, "Beta Agent");
        expect(betaOption).toBeTruthy();
      });

      await act(async () => {
        betaOption?.click();
      });
      await flush();

      expect(onUpdate).toHaveBeenCalledWith({ ownerAgentId: "agent-2" });
    });

    it("calls onUpdate with null when the owner is cleared", async () => {
      const onUpdate = vi.fn();
      render({ goal: makeGoal({ ownerAgentId: "agent-1" }), onUpdate });
      await flush();

      // Wait for the agents list to resolve so the trigger reflects the
      // current owner ("Alpha Agent") rather than the "None" loading
      // fallback — otherwise both the trigger and the clear option would
      // read "None" and the wrong button could be targeted.
      await waitForAssertion(() => {
        expect(container.textContent).toContain("Alpha Agent");
      });

      const noneOption = findButtonByText(container, "None");
      expect(noneOption).toBeTruthy();

      await act(async () => {
        noneOption?.click();
      });
      await flush();

      expect(onUpdate).toHaveBeenCalledWith({ ownerAgentId: null });
    });

    it("renders the owner as a read-only link when onUpdate is not provided", async () => {
      render({ goal: makeGoal({ ownerAgentId: "agent-1" }) });
      await flush();

      await waitForAssertion(() => {
        expect(container.querySelector("a[href]")).toBeTruthy();
        expect(container.textContent).toContain("Alpha Agent");
      });
    });
  });
});
