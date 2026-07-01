// @vitest-environment jsdom

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgentDetail as AgentDetailRecord,
  AgentInstructionsBundle,
  AgentInstructionsFileDetail,
} from "@paperclipai/shared";
import { LocaleProvider } from "@/context/LocaleContext";
import { LOCALE_STORAGE_KEY } from "@/lib/i18n";

const mockAgentsApi = vi.hoisted(() => ({
  instructionsBundle: vi.fn(),
  instructionsFile: vi.fn(),
  localizeDefaultInstructionsBundle: vi.fn(),
  updateInstructionsBundle: vi.fn(),
  saveInstructionsFile: vi.fn(),
  deleteInstructionsFile: vi.fn(),
}));

vi.mock("../api/agents", () => ({
  agentsApi: mockAgentsApi,
}));

vi.mock("../api/assets", () => ({
  assetsApi: {
    uploadImage: vi.fn(),
  },
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
  }),
}));

vi.mock("../context/SidebarContext", () => ({
  useSidebar: () => ({
    isMobile: false,
  }),
}));

vi.mock("@/adapters/use-adapter-capabilities", () => ({
  useAdapterCapabilities: () => () => ({
    supportsInstructionsBundle: true,
  }),
}));

vi.mock("../components/MarkdownEditor", async () => {
  const React = await import("react");
  return {
    MarkdownEditor: ({
      value,
      onChange,
      placeholder,
    }: {
      value: string;
      onChange: (value: string) => void;
      placeholder?: string;
    }) =>
      React.createElement("textarea", {
        "aria-label": "markdown editor",
        value,
        placeholder,
        onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => onChange(event.currentTarget.value),
      }),
  };
});

import { PromptsTab } from "./AgentDetail";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function createAgent(overrides: Partial<AgentDetailRecord> = {}): AgentDetailRecord {
  return {
    id: "agent-1",
    companyId: "company-1",
    name: "CEO",
    role: "ceo",
    title: "CEO",
    icon: null,
    status: "active",
    reportsTo: null,
    capabilities: null,
    adapterType: "claude_local",
    adapterConfig: {},
    runtimeConfig: {},
    permissions: { canCreateAgents: false },
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    pauseReason: null,
    pausedAt: null,
    lastHeartbeatAt: null,
    metadata: null,
    urlKey: "ceo",
    chainOfCommand: [],
    access: {
      canAssignTasks: true,
      taskAssignSource: "ceo_role",
      membership: null,
      grants: [],
    },
    createdAt: new Date("2026-04-24T00:00:00.000Z"),
    updatedAt: new Date("2026-04-24T00:00:00.000Z"),
    ...overrides,
  };
}

function createBundle(mode: "managed" | "external" = "managed"): AgentInstructionsBundle {
  return {
    agentId: "agent-1",
    companyId: "company-1",
    mode,
    rootPath: mode === "managed" ? "/tmp/agent/instructions" : "/tmp/external-agent/instructions",
    managedRootPath: "/tmp/agent/instructions",
    entryFile: "AGENTS.md",
    resolvedEntryPath: "/tmp/agent/instructions/AGENTS.md",
    editable: true,
    warnings: [],
    legacyPromptTemplateActive: false,
    legacyBootstrapPromptTemplateActive: false,
    files: [
      {
        path: "AGENTS.md",
        size: 24,
        language: "markdown",
        markdown: true,
        isEntryFile: true,
        editable: true,
        deprecated: false,
        virtual: false,
      },
    ],
  };
}

function createFileDetail(): AgentInstructionsFileDetail {
  return {
    path: "AGENTS.md",
    size: 24,
    language: "markdown",
    markdown: true,
    isEntryFile: true,
    editable: true,
    deprecated: false,
    virtual: false,
    content: "# CEO\n\n默认指令",
  };
}

async function clickButtonByText(container: HTMLElement, text: string) {
  const button = [...container.querySelectorAll("button")]
    .find((candidate) => candidate.textContent?.includes(text));
  if (!button) throw new Error(`Button not found: ${text}`);
  await act(async () => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("PromptsTab localization", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    window.localStorage.clear();
    window.localStorage.setItem(LOCALE_STORAGE_KEY, "zh-CN");
    document.documentElement.lang = "";
    document.documentElement.removeAttribute("data-locale");
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    mockAgentsApi.instructionsBundle.mockReset();
    mockAgentsApi.instructionsFile.mockReset();
    mockAgentsApi.localizeDefaultInstructionsBundle.mockReset();
    mockAgentsApi.updateInstructionsBundle.mockReset();
    mockAgentsApi.saveInstructionsFile.mockReset();
    mockAgentsApi.deleteInstructionsFile.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    queryClient.clear();
    container.remove();
    window.localStorage.clear();
  });

  function render(ui: ReactNode) {
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <LocaleProvider>{ui}</LocaleProvider>
        </QueryClientProvider>,
      );
    });
  }

  it("calls the safe default bundle localization API in Chinese locale", async () => {
    const bundle = createBundle("managed");
    mockAgentsApi.instructionsBundle.mockResolvedValue(bundle);
    mockAgentsApi.instructionsFile.mockResolvedValue(createFileDetail());
    mockAgentsApi.localizeDefaultInstructionsBundle.mockResolvedValue({
      bundle,
      changed: false,
      instructionsLocale: "zh-CN",
      matchedLocale: "zh-CN",
    });

    render(
      <PromptsTab
        agent={createAgent()}
        companyId="company-1"
        onDirtyChange={vi.fn()}
        onSaveActionChange={vi.fn()}
        onCancelActionChange={vi.fn()}
        onSavingChange={vi.fn()}
      />,
    );

    await act(async () => {
      await vi.waitFor(() => {
        expect(mockAgentsApi.localizeDefaultInstructionsBundle).toHaveBeenCalledWith(
          "agent-1",
          { instructionsLocale: "zh-CN" },
          "company-1",
        );
      });
    });
  });

  it("calls the safe default bundle localization API for CMO instruction pages", async () => {
    const bundle = createBundle("managed");
    mockAgentsApi.instructionsBundle.mockResolvedValue(bundle);
    mockAgentsApi.instructionsFile.mockResolvedValue(createFileDetail());
    mockAgentsApi.localizeDefaultInstructionsBundle.mockResolvedValue({
      bundle,
      changed: true,
      instructionsLocale: "zh-CN",
      matchedLocale: "legacy-en:cmo-v1",
    });

    render(
      <PromptsTab
        agent={createAgent({
          name: "CMO",
          role: "cmo",
          title: "Chief Marketing Officer",
          urlKey: "cmo",
        })}
        companyId="company-1"
        onDirtyChange={vi.fn()}
        onSaveActionChange={vi.fn()}
        onCancelActionChange={vi.fn()}
        onSavingChange={vi.fn()}
      />,
    );

    await act(async () => {
      await vi.waitFor(() => {
        expect(mockAgentsApi.localizeDefaultInstructionsBundle).toHaveBeenCalledWith(
          "agent-1",
          { instructionsLocale: "zh-CN" },
          "company-1",
        );
      });
    });
  });

  it("renders instruction controls in Chinese", async () => {
    const bundle = createBundle("managed");
    mockAgentsApi.instructionsBundle.mockResolvedValue(bundle);
    mockAgentsApi.instructionsFile.mockResolvedValue(createFileDetail());
    mockAgentsApi.localizeDefaultInstructionsBundle.mockResolvedValue({
      bundle,
      changed: false,
      instructionsLocale: "zh-CN",
      matchedLocale: "zh-CN",
    });

    render(
      <PromptsTab
        agent={createAgent()}
        companyId="company-1"
        onDirtyChange={vi.fn()}
        onSaveActionChange={vi.fn()}
        onCancelActionChange={vi.fn()}
        onSavingChange={vi.fn()}
      />,
    );

    await act(async () => {
      await vi.waitFor(() => expect(container.textContent).toContain("高级"));
    });
    await clickButtonByText(container, "高级");

    expect(container.textContent).toContain("模式");
    expect(container.textContent).toContain("托管");
    expect(container.textContent).toContain("外部");
    expect(container.textContent).toContain("根路径");
    expect(container.textContent).toContain("入口文件");
    expect(container.textContent).toContain("文件");
  });
});
