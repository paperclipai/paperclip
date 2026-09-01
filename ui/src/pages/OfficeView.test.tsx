// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OfficeView } from "./OfficeView";

const navigateMock = vi.fn();
const listMock = vi.fn();

vi.mock("@/lib/router", () => ({
  useNavigate: () => navigateMock,
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

vi.mock("../context/SidebarContext", () => ({
  useSidebar: () => ({ isMobile: false }),
}));

vi.mock("../api/agents", () => ({
  agentsApi: { list: () => listMock() },
}));

vi.mock("../api/heartbeats", () => ({
  heartbeatsApi: { liveRunsForCompany: () => Promise.resolve([]) },
}));

vi.mock("@/api/instanceSettings", () => ({
  instanceSettingsApi: { getExperimental: () => Promise.resolve({}) },
}));

vi.mock("../components/AgentIconPicker", () => ({
  AgentIcon: () => <span data-testid="agent-icon" />,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function agent(id: string, role: string, reportsTo: string | null, status = "active") {
  return {
    id,
    companyId: "company-1",
    name: id,
    urlKey: id,
    role,
    title: null,
    icon: null,
    status,
    reportsTo,
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
  };
}

const agents = [
  agent("ceo", "ceo", null),
  agent("eng-lead", "engineer", "ceo"),
  agent("eng-2", "engineer", "eng-lead"),
  agent("eng-3", "engineer", "eng-lead"),
  agent("qa1", "qa", "ceo"),
  agent("res1", "researcher", "ceo"),
];

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

describe("OfficeView", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let queryClient: QueryClient;

  beforeEach(() => {
    window.localStorage?.clear?.();
    container = document.createElement("div");
    document.body.appendChild(container);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    listMock.mockResolvedValue(agents);
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root.unmount();
      });
    }
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  async function renderOffice() {
    root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <OfficeView />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();
  }

  it("renders a desk per agent (Deep default on desktop) and department rooms", async () => {
    await renderOffice();
    const desks = container.querySelectorAll("[data-viewport-card]");
    expect(desks.length).toBe(agents.length); // deep = all 6
    // Rooms: Executive, Engineering, Quality, Research (rendered as <text> labels).
    const roomLabels = Array.from(container.querySelectorAll("text"))
      .map((t) => t.textContent)
      .join(" ");
    expect(roomLabels).toContain("Engineering");
    expect(roomLabels).toContain("Executive");
  });

  it("Lite (Key agents) toggle collapses to the curated subset", async () => {
    await renderOffice();
    const liteBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "Key agents",
    ) as HTMLButtonElement;
    expect(liteBtn).toBeTruthy();

    await act(async () => {
      liteBtn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await flushReact();

    const desks = container.querySelectorAll("[data-viewport-card]");
    // Curated = root (ceo) + one rep per dept (Engineering, Quality, Research) = 4.
    expect(desks.length).toBe(4);
    expect(desks.length).toBeLessThan(agents.length);
  });

  it("navigates to the agent on desk click", async () => {
    await renderOffice();
    const desk = container.querySelector("[data-viewport-card]") as HTMLDivElement;
    await act(async () => {
      desk.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    expect(navigateMock).toHaveBeenCalledTimes(1);
  });
});
