// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "@paperclipai/shared";
import { AgentConfigForm } from "./AgentConfigForm";
import { TooltipProvider } from "./ui/tooltip";

const mockAgentsApi = vi.hoisted(() => ({
  adapterModels: vi.fn(),
  adapterModelProfiles: vi.fn(),
  detectModel: vi.fn(),
  getAdapterReadiness: vi.fn(),
  probeAdapterReadiness: vi.fn(),
  testEnvironment: vi.fn(),
}));
const mockSecretsApi = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
}));
const mockEnvironmentsApi = vi.hoisted(() => ({
  list: vi.fn(),
}));
const mockInstanceSettingsApi = vi.hoisted(() => ({
  getExperimental: vi.fn(),
}));
const mockAssetsApi = vi.hoisted(() => ({
  uploadImage: vi.fn(),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
    selectedCompany: { id: "company-1", name: "Northstar Labs" },
  }),
}));

vi.mock("../api/agents", () => ({
  agentsApi: mockAgentsApi,
}));

vi.mock("../api/secrets", () => ({
  secretsApi: mockSecretsApi,
}));

vi.mock("../api/environments", () => ({
  environmentsApi: mockEnvironmentsApi,
}));

vi.mock("../api/instanceSettings", () => ({
  instanceSettingsApi: mockInstanceSettingsApi,
}));

vi.mock("../api/assets", () => ({
  assetsApi: mockAssetsApi,
}));

vi.mock("./MarkdownEditor", () => ({
  MarkdownEditor: ({ value }: { value?: string }) => <textarea value={value ?? ""} readOnly />,
}));

vi.mock("./PathInstructionsModal", () => ({
  ChoosePathButton: () => null,
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  mockAgentsApi.adapterModels.mockResolvedValue([]);
  mockAgentsApi.adapterModelProfiles.mockResolvedValue([]);
  mockAgentsApi.detectModel.mockResolvedValue(null);
  mockAgentsApi.getAdapterReadiness.mockResolvedValue({
    id: "11111111-1111-4111-8111-111111111111",
    companyId: "company-1",
    agentId: "agent-1",
    adapterType: "codex_local",
    status: "ready",
    basicReady: true,
    operationalReady: true,
    fixtureReady: false,
    reasonCodes: [],
    cliVersion: null,
    authMode: null,
    model: "gpt-5.3-codex",
    modelProfile: null,
    workspaceStatus: "ok",
    quotaWindows: null,
    helloRunStatus: "not_executed",
    helloRunMetadata: null,
    heartbeatRunId: null,
    fallbackRecommendation: null,
    strictMode: false,
    checkedByUserId: "22222222-2222-4222-8222-222222222222",
    checkedAt: "2026-05-23T10:00:00.000Z",
    createdAt: "2026-05-23T10:00:00.000Z",
  });
  mockSecretsApi.list.mockResolvedValue([]);
  mockEnvironmentsApi.list.mockResolvedValue([]);
  mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableEnvironments: false });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

async function flushReact() {
  await act(async () => {
    for (let i = 0; i < 3; i += 1) {
      await Promise.resolve();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    }
  });
}

function render(ui: ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          {ui}
        </TooltipProvider>
      </QueryClientProvider>,
    );
  });
}

function createAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agent-1",
    companyId: "company-1",
    name: "Engineering Lead",
    role: "engineer",
    status: "active",
    reportsTo: null,
    capabilities: null,
    adapterType: "codex_local",
    adapterConfig: { model: "gpt-5.3-codex" },
    runtimeConfig: {},
    defaultEnvironmentId: null,
    canCreateAgents: false,
    icon: null,
    iconColor: null,
    createdAt: new Date("2026-05-23T09:00:00.000Z"),
    updatedAt: new Date("2026-05-23T09:00:00.000Z"),
    ...overrides,
  } as Agent;
}

describe("AgentConfigForm", () => {
  it("shows persisted adapter readiness separately from the environment test", async () => {
    render(
      <AgentConfigForm
        mode="edit"
        agent={createAgent()}
        onSave={vi.fn()}
        hideInstructionsFile
      />,
    );

    await flushReact();

    expect(mockAgentsApi.getAdapterReadiness).toHaveBeenCalledWith("company-1", "agent-1");
    expect(container.textContent).toContain("Persisted readiness");
    expect(container.textContent).toContain("Ready");
    expect(container.textContent).toContain("Basic ready");
  });
});
