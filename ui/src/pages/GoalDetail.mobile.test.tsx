// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GoalDetail } from "./GoalDetail";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const goalFixture = {
  id: "goal-1",
  companyId: "company-1",
  title: "Ship mobile parity",
  description: "Make goal properties accessible on mobile.",
  level: "company",
  status: "active",
  parentId: null,
  ownerAgentId: null,
  createdAt: new Date("2026-08-01T10:00:00Z"),
  updatedAt: new Date("2026-08-01T10:00:00Z"),
};

vi.mock("../api/goals", () => ({
  goalsApi: {
    get: vi.fn(async () => goalFixture),
    list: vi.fn(async () => [goalFixture]),
    update: vi.fn(async () => goalFixture),
  },
}));

vi.mock("../api/projects", () => ({
  projectsApi: {
    list: vi.fn(async () => []),
  },
}));

vi.mock("../api/assets", () => ({
  assetsApi: {
    uploadImage: vi.fn(),
  },
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
    setSelectedCompanyId: vi.fn(),
  }),
}));

vi.mock("../context/DialogContext", () => ({
  useDialogActions: () => ({
    openNewGoal: vi.fn(),
  }),
}));

vi.mock("../context/PanelContext", () => ({
  usePanel: () => ({
    openPanel: vi.fn(),
    closePanel: vi.fn(),
    panelVisible: false,
    setPanelVisible: vi.fn(),
  }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({
    setBreadcrumbs: vi.fn(),
  }),
}));

vi.mock("../components/GoalProperties", () => ({
  GoalProperties: ({ goal }: { goal: { title: string } }) => (
    <div data-testid="goal-properties-content">Goal properties for {goal.title}</div>
  ),
}));

vi.mock("../components/InlineEditor", () => ({
  InlineEditor: ({ value, as: Tag = "div", className }: { value: string; as?: "h2" | "p" | "div"; className?: string }) => (
    <Tag className={className}>{value}</Tag>
  ),
}));

vi.mock("@/lib/router", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return {
    ...actual,
    Link: ({ to, children, ...props }: { to: string; children: ReactNode } & React.ComponentProps<"a">) => (
      <a href={to} {...props}>{children}</a>
    ),
  };
});

describe("GoalDetail mobile properties sheet", () => {
  let container: HTMLDivElement;
  let root: Root;
  let client: QueryClient;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    client.clear();
    container.remove();
  });

  it("renders a mobile Properties trigger button and opens GoalProperties inside a mobile Sheet", async () => {
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <MemoryRouter initialEntries={["/goals/goal-1"]}>
            <Routes>
              <Route path="/goals/:goalId" element={<GoalDetail />} />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="Properties"]');
    expect(trigger).not.toBeNull();
    expect(trigger!.className).toContain("md:hidden");

    expect(document.querySelector('[data-testid="mobile-goal-properties-sheet"]')).toBeNull();

    await act(async () => {
      trigger!.click();
    });

    const sheet = document.querySelector('[data-testid="mobile-goal-properties-sheet"]');
    expect(sheet).not.toBeNull();
    expect(sheet!.textContent).toContain("Goal properties for Ship mobile parity");
  });
});
