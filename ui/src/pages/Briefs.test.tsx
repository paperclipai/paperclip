// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BuiltInAgentState, BuiltInAgentStatus } from "@/api/builtInAgents";
import { ApiError } from "@/api/client";
import { Briefs } from "./Briefs";

const companyState = vi.hoisted(() => ({
  selectedCompanyId: "company-1" as string | null,
  companies: [{ id: "company-1", name: "Paperclip", issuePrefix: "PAP" }] as Array<{
    id: string;
    name: string;
    issuePrefix: string;
  }>,
}));

const breadcrumbState = vi.hoisted(() => ({
  setBreadcrumbs: vi.fn(),
}));

const briefsApiMock = vi.hoisted(() => ({
  overview: vi.fn(),
}));

const builtInAgentsApiMock = vi.hoisted(() => ({
  list: vi.fn(),
  provision: vi.fn(),
  reset: vi.fn(),
}));

const resumeMock = vi.hoisted(() => vi.fn());

const instanceSettingsApiMock = vi.hoisted(() => ({
  getExperimental: vi.fn(),
}));

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => companyState,
}));

vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => breadcrumbState,
}));

vi.mock("@/api/briefs", () => ({
  briefsApi: briefsApiMock,
}));

vi.mock("@/api/builtInAgents", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/builtInAgents")>();
  return {
    ...actual,
    builtInAgentsApi: builtInAgentsApiMock,
  };
});

vi.mock("@/api/agents", () => ({
  agentsApi: { resume: resumeMock },
}));

vi.mock("@/api/instanceSettings", () => ({
  instanceSettingsApi: instanceSettingsApiMock,
}));

vi.mock("@/components/ConfigureBuiltInAgentModal", () => ({
  ConfigureBuiltInAgentModal: ({ open }: { open: boolean }) =>
    open ? <div data-testid="configure-modal" /> : null,
}));

vi.mock("react-router-dom", () => ({
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
}));

function makeBuiltInState(status: BuiltInAgentStatus): BuiltInAgentState {
  const provisioned = status !== "not_provisioned";
  return {
    definition: {
      key: "briefs",
      displayName: "Briefs Agent",
      featureKeys: ["briefs"],
      shortPurpose: "Prepares briefs.",
      defaultInstructions: "Prepare briefs.",
      defaultRole: "general",
      allowedAdapterTypes: ["codex_local"],
      defaultBudgetMonthlyCents: 0,
    },
    status,
    agentId: provisioned ? "agent-1" : null,
    agent: provisioned
      ? ({
          id: "agent-1",
          name: "Briefs Agent",
          status: status === "paused" ? "paused" : status === "pending_approval" ? "pending_approval" : "idle",
          pausedAt: status === "paused" ? "2026-07-07T22:45:00.000Z" : null,
        } as BuiltInAgentState["agent"])
      : null,
    pauseReason: status === "paused" ? "maintenance" : null,
  };
}

function makeOverview(status: "ready" | "paused" = "ready") {
  return {
    featureKey: "briefs" as const,
    status,
    generatedAt: "2026-07-07T22:45:00.000Z",
    agent: {
      id: "agent-1",
      name: "Briefs Agent",
      status: status === "paused" ? "paused" : "idle",
      adapterType: "codex_local",
    },
    warning:
      status === "paused"
        ? {
            code: "built_in_agent_paused" as const,
            key: "briefs",
            agentId: "agent-1",
            message: "Briefs is paused.",
            pauseReason: "maintenance",
          }
        : null,
    summaryItems: [
      { label: "Agent", value: "Briefs Agent", detail: status === "paused" ? "paused" : "idle" },
      { label: "Adapter", value: "codex_local" },
      { label: "Last checked", value: "2026-07-07T22:45:00.000Z" },
    ],
  };
}

async function flushReact() {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
  flushSync(() => {});
}

describe("Briefs page", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  async function renderBriefs() {
    root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    flushSync(() => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <Briefs />
        </QueryClientProvider>,
      );
    });
    await flushReact();
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    companyState.selectedCompanyId = "company-1";
    companyState.companies = [{ id: "company-1", name: "Paperclip", issuePrefix: "PAP" }];
    briefsApiMock.overview.mockReset();
    builtInAgentsApiMock.list.mockReset();
    resumeMock.mockReset();
    instanceSettingsApiMock.getExperimental.mockReset();
    breadcrumbState.setBreadcrumbs.mockReset();
    instanceSettingsApiMock.getExperimental.mockResolvedValue({ enableBuiltInAgents: true });
    builtInAgentsApiMock.list.mockResolvedValue([makeBuiltInState("ready")]);
    briefsApiMock.overview.mockResolvedValue(makeOverview());
  });

  afterEach(() => {
    flushSync(() => {
      root?.unmount();
    });
    root = null;
    container.remove();
  });

  it("renders live Briefs content when the built-in agent is ready", async () => {
    await renderBriefs();

    expect(briefsApiMock.overview).toHaveBeenCalledWith("company-1");
    expect(container.textContent).toContain("Briefs Agent");
    expect(container.textContent).toContain("No briefs yet");
    expect(breadcrumbState.setBreadcrumbs).toHaveBeenCalledWith([{ label: "Briefs" }]);
  });

  it.each(["not_provisioned", "needs_setup"] as const)(
    "renders setup and does not load the overview for %s",
    async (status) => {
      builtInAgentsApiMock.list.mockResolvedValue([makeBuiltInState(status)]);

      await renderBriefs();

      expect(container.textContent).toContain("Set up the Briefs Agent");
      expect(briefsApiMock.overview).not.toHaveBeenCalled();
    },
  );

  it("renders the pending approval state without loading the overview", async () => {
    builtInAgentsApiMock.list.mockResolvedValue([makeBuiltInState("pending_approval")]);

    await renderBriefs();

    expect(container.textContent).toContain("pending approval");
    expect(briefsApiMock.overview).not.toHaveBeenCalled();
  });

  it("keeps live content readable and offers resume when paused", async () => {
    builtInAgentsApiMock.list.mockResolvedValue([makeBuiltInState("paused")]);
    briefsApiMock.overview.mockResolvedValue(makeOverview("paused"));

    await renderBriefs();

    expect(container.textContent).toContain("Briefs is paused.");
    expect(container.textContent).toContain("Resume agent");
    expect(container.textContent).toContain("No briefs yet");
  });

  it("shows setup copy if readiness changes while the overview loads", async () => {
    briefsApiMock.overview.mockRejectedValue(
      new ApiError("Built-in agent is not configured: briefs", 412, {
        code: "built_in_agent_not_configured",
        details: { key: "briefs", status: "needs_setup" },
      }),
    );

    await renderBriefs();

    expect(container.textContent).toContain("Set up the Briefs Agent");
    expect(container.textContent).not.toContain("Built-in agent is not configured");
  });

  it("asks for a company before loading the Briefs surface", async () => {
    companyState.selectedCompanyId = null;

    await renderBriefs();

    expect(container.textContent).toContain("Select a company to view briefs.");
    expect(builtInAgentsApiMock.list).not.toHaveBeenCalled();
    expect(briefsApiMock.overview).not.toHaveBeenCalled();
  });
});
