// @vitest-environment jsdom

import { act } from "react";
import type { ComponentProps, ReactNode } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GoalProperties } from "./GoalProperties";

const companyState = vi.hoisted(() => ({
  selectedCompanyId: "company-1",
}));

const mockAgentsApi = vi.hoisted(() => ({
  list: vi.fn(),
}));

const mockGoalsApi = vi.hoisted(() => ({
  list: vi.fn(),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => companyState,
}));

vi.mock("../api/agents", () => ({
  agentsApi: mockAgentsApi,
}));

vi.mock("../api/goals", () => ({
  goalsApi: mockGoalsApi,
}));

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: ComponentProps<"a"> & { to: string }) => <a href={to} {...props}>{children}</a>,
}));

vi.mock("@/components/ui/separator", () => ({
  Separator: () => <div />,
}));

vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, onClick, type = "button", ...props }: ComponentProps<"button">) => (
    <button type={type} onClick={onClick} {...props}>{children}</button>
  ),
}));

vi.mock("./StatusBadge", () => ({
  StatusBadge: ({ status }: { status: string }) => <span>{status}</span>,
}));

vi.mock("./AgentIconPicker", () => ({
  AgentIcon: () => null,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function renderComponent(container: HTMLDivElement, goal: Record<string, unknown>) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  const root = createRoot(container);
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <GoalProperties goal={goal as never} onUpdate={vi.fn()} />
      </QueryClientProvider>,
    );
  });
  return root;
}

describe("GoalProperties", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockAgentsApi.list.mockReset();
    mockGoalsApi.list.mockReset();
    mockAgentsApi.list.mockResolvedValue([
      { id: "agent-1", name: "CEO", icon: "crown", status: "idle" },
      { id: "agent-2", name: "CTO", icon: "wrench", status: "idle" },
    ]);
    mockGoalsApi.list.mockResolvedValue([]);
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    container.remove();
    root = null;
  });

  it("shows the resolved owner name when the goal already has an owner", async () => {
    root = renderComponent(container, {
      id: "goal-1",
      title: "Goal",
      status: "active",
      level: "task",
      ownerAgentId: "agent-1",
      parentId: null,
      createdAt: "2026-04-29T10:00:00.000Z",
      updatedAt: "2026-04-29T10:00:00.000Z",
    });

    await flush();
    await flush();

    expect(container.textContent).toContain("CEO");
  });

  it("shows the empty owner state when the goal has no owner", async () => {
    root = renderComponent(container, {
      id: "goal-1",
      title: "Goal",
      status: "active",
      level: "task",
      ownerAgentId: null,
      parentId: null,
      createdAt: "2026-04-29T10:00:00.000Z",
      updatedAt: "2026-04-29T10:00:00.000Z",
    });

    await flush();
    await flush();

    expect(container.textContent).toContain("No owner");
  });
});
