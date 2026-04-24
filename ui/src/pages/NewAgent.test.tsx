// @vitest-environment jsdom

import type React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NewAgent } from "./NewAgent";

const navigateMock = vi.hoisted(() => vi.fn());
const setBreadcrumbsMock = vi.hoisted(() => vi.fn());
const pushToastMock = vi.hoisted(() => vi.fn());
const hireMock = vi.hoisted(() => vi.fn());
const listAgentsMock = vi.hoisted(() => vi.fn());
const adapterModelsMock = vi.hoisted(() => vi.fn());
const companySkillsListMock = vi.hoisted(() => vi.fn());

const companyState = vi.hoisted(() => ({
  selectedCompanyId: "company-1",
  selectedCompany: {
    id: "company-1",
    name: "Paperclip",
    requireBoardApprovalForNewAgents: false,
  },
}));

vi.mock("@/lib/router", () => ({
  useNavigate: () => navigateMock,
  useSearchParams: () => [new URLSearchParams(), vi.fn()],
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => companyState,
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: setBreadcrumbsMock }),
}));

vi.mock("../context/ToastContext", () => ({
  useToastActions: () => ({ pushToast: pushToastMock }),
}));

vi.mock("../api/agents", () => ({
  agentsApi: {
    list: (companyId: string) => listAgentsMock(companyId),
    adapterModels: (companyId: string, adapterType: string) => adapterModelsMock(companyId, adapterType),
    hire: (companyId: string, data: Record<string, unknown>) => hireMock(companyId, data),
  },
}));

vi.mock("../api/companySkills", () => ({
  companySkillsApi: {
    list: (companyId: string) => companySkillsListMock(companyId),
  },
}));

vi.mock("../adapters/use-disabled-adapters", () => ({
  useDisabledAdaptersSync: () => undefined,
}));

vi.mock("../adapters/metadata", () => ({
  isValidAdapterType: () => true,
}));

vi.mock("../adapters", () => ({
  getUIAdapter: () => ({
    buildAdapterConfig: () => ({}),
  }),
  listUIAdapters: () => [],
}));

vi.mock("../components/ReportsToPicker", () => ({
  ReportsToPicker: () => <div data-testid="reports-to-picker" />,
}));

vi.mock("../components/AgentConfigForm", () => ({
  AgentConfigForm: () => <div data-testid="agent-config-form" />,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, onClick, type = "button", disabled, ...props }: React.ComponentProps<"button">) => (
    <button type={type} onClick={onClick} disabled={disabled} {...props}>{children}</button>
  ),
}));

vi.mock("@/components/ui/checkbox", () => ({
  Checkbox: ({ id, checked, onCheckedChange }: { id?: string; checked?: boolean; onCheckedChange?: (checked: boolean) => void }) => (
    <input
      id={id}
      type="checkbox"
      checked={checked}
      onChange={(event) => onCheckedChange?.(event.target.checked)}
    />
  ),
}));

vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("lucide-react", () => ({
  Shield: () => null,
  Sparkles: () => null,
  Bot: () => null,
  Brain: () => null,
  Cpu: () => null,
  Workflow: () => null,
  Code2: () => null,
  Code: () => null,
  Wrench: () => null,
  Globe: () => null,
  Boxes: () => null,
  Gem: () => null,
  MousePointer2: () => null,
  Terminal: () => null,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe("NewAgent", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    navigateMock.mockReset();
    setBreadcrumbsMock.mockReset();
    pushToastMock.mockReset();
    hireMock.mockReset();
    listAgentsMock.mockReset();
    adapterModelsMock.mockReset();
    companySkillsListMock.mockReset();
    companyState.selectedCompanyId = "company-1";
    companyState.selectedCompany = {
      id: "company-1",
      name: "Paperclip",
      requireBoardApprovalForNewAgents: false,
    };
    listAgentsMock.mockResolvedValue([]);
    adapterModelsMock.mockResolvedValue([]);
    companySkillsListMock.mockResolvedValue([]);
    hireMock.mockResolvedValue({
      agent: {
        id: "agent-1",
        urlKey: "agent-1",
      },
      approval: null,
    });
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  async function renderPage() {
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <NewAgent />
        </QueryClientProvider>,
      );
    });

    await flush();
    return root;
  }

  it("shows approval copy and submit CTA when board approval is required", async () => {
    companyState.selectedCompany = {
      id: "company-1",
      name: "Paperclip",
      requireBoardApprovalForNewAgents: true,
    };

    const root = await renderPage();

    expect(container.textContent).toContain("Submit for approval");
    expect(container.textContent).toContain("will remain pending until approved");

    await act(async () => {
      root.unmount();
    });
  });

  it("navigates to approval detail and toasts when hire response includes an approval", async () => {
    companyState.selectedCompany = {
      id: "company-1",
      name: "Paperclip",
      requireBoardApprovalForNewAgents: true,
    };
    hireMock.mockResolvedValueOnce({
      agent: {
        id: "agent-1",
        urlKey: "agent-1",
        name: "CEO",
      },
      approval: {
        id: "approval-42",
      },
    });

    const root = await renderPage();

    const buttons = Array.from(container.querySelectorAll("button"));
    const submitButton = buttons.find((button) => button.textContent?.includes("Submit for approval"));
    expect(submitButton).toBeTruthy();

    await act(async () => {
      submitButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(hireMock).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        name: "CEO",
        role: "ceo",
      }),
    );
    expect(pushToastMock).toHaveBeenCalledWith(
      expect.objectContaining({
        title: expect.stringContaining("submitted for approval"),
      }),
    );
    expect(navigateMock).toHaveBeenCalledWith("/approvals/approval-42");

    await act(async () => {
      root.unmount();
    });
  });
});
