// @vitest-environment jsdom

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentConfigForm, type CreateConfigValues } from "./AgentConfigForm";
import { defaultCreateValues } from "./agent-config-defaults";
import { TooltipProvider } from "@/components/ui/tooltip";

const mockAgentsApi = vi.hoisted(() => ({
  adapterModels: vi.fn(),
  adapterModelProfiles: vi.fn(),
  detectModel: vi.fn(),
}));

const mockAdaptersApi = vi.hoisted(() => ({
  list: vi.fn(),
}));

const mockCredentialsApi = vi.hoisted(() => ({
  list: vi.fn(),
}));

const mockEnvironmentsApi = vi.hoisted(() => ({
  list: vi.fn(),
}));

const mockInstanceSettingsApi = vi.hoisted(() => ({
  getExperimental: vi.fn(),
}));

const mockSecretsApi = vi.hoisted(() => ({
  list: vi.fn(),
}));

vi.mock("../api/agents", () => ({
  agentsApi: mockAgentsApi,
}));

vi.mock("../api/adapters", () => ({
  adaptersApi: mockAdaptersApi,
}));

vi.mock("../api/credentials", () => ({
  credentialsApi: mockCredentialsApi,
}));

vi.mock("../api/environments", () => ({
  environmentsApi: mockEnvironmentsApi,
}));

vi.mock("../api/instanceSettings", () => ({
  instanceSettingsApi: mockInstanceSettingsApi,
}));

vi.mock("../api/secrets", () => ({
  secretsApi: mockSecretsApi,
}));

vi.mock("../api/assets", () => ({
  assetsApi: {
    uploadImage: vi.fn(),
  },
}));

vi.mock("./MarkdownEditor", () => ({
  MarkdownEditor: ({
    value,
    onChange,
    placeholder,
  }: {
    value: string;
    onChange: (value: string) => void;
    placeholder?: string;
  }) => (
    <textarea
      aria-label={placeholder ?? "Markdown editor"}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
  }),
}));

vi.mock("@/lib/router", () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
}));

vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

describe("AgentConfigForm", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockAgentsApi.adapterModels.mockImplementation(async (_companyId: string, adapterType: string) => {
      if (adapterType === "codex_local") {
        return [{ id: "gpt-5.3-codex", label: "GPT-5.3 Codex" }];
      }
      return [];
    });
    mockAgentsApi.adapterModelProfiles.mockResolvedValue([]);
    mockAgentsApi.detectModel.mockResolvedValue(null);
    mockAdaptersApi.list.mockResolvedValue([]);
    mockCredentialsApi.list.mockResolvedValue([]);
    mockEnvironmentsApi.list.mockResolvedValue([]);
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableEnvironments: false });
    mockSecretsApi.list.mockResolvedValue([]);
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("loads backup route model choices from the backup adapter", async () => {
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const values: CreateConfigValues = {
      ...defaultCreateValues,
      adapterType: "claude_local",
      backupRouteEnabled: true,
      backupRouteAdapterType: "codex_local",
    };

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <AgentConfigForm
              mode="create"
              values={values}
              onChange={vi.fn()}
              hidePromptTemplate
              showAdapterTestEnvironmentButton={false}
              showCreateRunPolicySection={false}
            />
          </TooltipProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();

    expect(mockAgentsApi.adapterModels).toHaveBeenCalledWith(
      "company-1",
      "claude_local",
      { environmentId: null },
    );
    expect(mockAgentsApi.adapterModels).toHaveBeenCalledWith(
      "company-1",
      "codex_local",
      { environmentId: null },
    );

    await act(async () => {
      root.unmount();
    });
  });
});
