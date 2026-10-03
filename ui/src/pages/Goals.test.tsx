// @vitest-environment jsdom

import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Goal } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Goals } from "./Goals";

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

vi.mock("../context/DialogContext", () => ({
  useDialogActions: () => ({ openNewGoal: vi.fn() }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: { children: ReactNode; to: string }) => (
    <a href={to} {...props}>{children}</a>
  ),
}));

const mockGoalsApi = vi.hoisted(() => ({
  list: vi.fn(),
  remove: vi.fn(),
}));

vi.mock("../api/goals", () => ({
  goalsApi: mockGoalsApi,
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

describe("Goals page delete flow", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot> | null;
  let queryClient: QueryClient;
  let confirmSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = null;
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    mockGoalsApi.list.mockResolvedValue([makeGoal()]);
    confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
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
    confirmSpy.mockRestore();
    vi.clearAllMocks();
  });

  function render() {
    root = createRoot(container);
    root.render(
      <QueryClientProvider client={queryClient}>
        <Goals />
      </QueryClientProvider>,
    );
  }

  it("asks for confirmation before deleting a goal from the list", async () => {
    mockGoalsApi.remove.mockResolvedValue(makeGoal());
    render();

    let deleteButton: HTMLButtonElement | null = null;
    await waitForAssertion(() => {
      deleteButton = container.querySelector('button[aria-label="Delete goal \\"Ship the thing\\""]');
      expect(deleteButton).toBeTruthy();
    });

    await act(async () => {
      deleteButton?.click();
    });
    await flush();

    expect(confirmSpy).toHaveBeenCalledWith('Delete goal "Ship the thing"?');
    expect(mockGoalsApi.remove).toHaveBeenCalledWith("goal-1");
  });

  it("does not delete when the confirmation is declined", async () => {
    confirmSpy.mockReturnValue(false);
    mockGoalsApi.remove.mockResolvedValue(makeGoal());
    render();

    let deleteButton: HTMLButtonElement | null = null;
    await waitForAssertion(() => {
      deleteButton = container.querySelector('button[aria-label="Delete goal \\"Ship the thing\\""]');
      expect(deleteButton).toBeTruthy();
    });

    await act(async () => {
      deleteButton?.click();
    });
    await flush();

    expect(mockGoalsApi.remove).not.toHaveBeenCalled();
  });

  it("surfaces an error message when deletion fails", async () => {
    mockGoalsApi.remove.mockRejectedValue(new Error("Cannot delete a goal with linked issues"));
    render();

    let deleteButton: HTMLButtonElement | null = null;
    await waitForAssertion(() => {
      deleteButton = container.querySelector('button[aria-label="Delete goal \\"Ship the thing\\""]');
      expect(deleteButton).toBeTruthy();
    });

    await act(async () => {
      deleteButton?.click();
    });
    await flush();

    await waitForAssertion(() => {
      expect(container.textContent).toContain("Cannot delete a goal with linked issues");
    });
  });
});
