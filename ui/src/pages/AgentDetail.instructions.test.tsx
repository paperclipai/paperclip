// @vitest-environment jsdom

import type { ComponentProps } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Agent, AgentInstructionsBundle, AgentInstructionsFileDetail, AgentInstructionsFileSummary } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PromptsTab } from "./AgentDetail";

const mockAgentsApi = vi.hoisted(() => ({
  instructionsBundle: vi.fn(),
  instructionsFile: vi.fn(),
  updateInstructionsBundle: vi.fn(),
  saveInstructionsFile: vi.fn(),
  deleteInstructionsFile: vi.fn(),
}));

const markdownEditorRenderMock = vi.hoisted(() => vi.fn());

vi.mock("../api/agents", () => ({
  agentsApi: mockAgentsApi,
}));

vi.mock("../api/assets", () => ({
  assetsApi: {
    uploadImage: vi.fn(async () => ({ contentPath: "/assets/uploaded-image.png" })),
  },
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

vi.mock("../context/SidebarContext", () => ({
  useSidebar: () => ({ isMobile: false }),
}));

vi.mock("@/adapters/use-adapter-capabilities", () => ({
  useAdapterCapabilities: () => () => ({
    supportsInstructionsBundle: true,
    supportsSkills: true,
    supportsLocalAgentJwt: true,
    requiresMaterializedRuntimeSkills: false,
    supportsModelProfiles: true,
  }),
}));

vi.mock("../components/MarkdownEditor", () => ({
  MarkdownEditor: ({
    value,
    onChange,
    placeholder,
    contentClassName,
    imageUploadHandler,
  }: {
    value: string;
    onChange: (value: string) => void;
    placeholder?: string;
    contentClassName?: string;
    imageUploadHandler?: (file: File) => Promise<string>;
  }) => {
    markdownEditorRenderMock({
      value,
      contentClassName,
      hasImageUploadHandler: Boolean(imageUploadHandler),
    });
    return (
      <textarea
        data-testid="markdown-editor"
        aria-label="Markdown editor"
        className={contentClassName}
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    );
  },
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

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

async function waitFor<T>(assertion: () => T): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < 20; i++) {
    try {
      return assertion();
    } catch (error) {
      lastError = error;
      await flushReact();
    }
  }
  throw lastError;
}

function setNativeValue(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = element instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  setter?.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

function buttonByText(container: HTMLElement, text: string) {
  const button = Array.from(container.querySelectorAll("button"))
    .find((candidate) => candidate.textContent?.trim() === text);
  if (!button) throw new Error(`Button not found: ${text}`);
  return button as HTMLButtonElement;
}

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agent-1",
    companyId: "company-1",
    name: "Codex Coder",
    urlKey: "codexcoder",
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

function makeSummary(
  path: string,
  entryFile: string,
  overrides: Partial<AgentInstructionsFileSummary> = {},
): AgentInstructionsFileSummary {
  const markdown = path.toLowerCase().endsWith(".md");
  return {
    path,
    size: 24,
    language: markdown ? "markdown" : "text",
    markdown,
    isEntryFile: path === entryFile,
    editable: true,
    deprecated: false,
    virtual: false,
    ...overrides,
  };
}

function makeDetail(
  summary: AgentInstructionsFileSummary,
  content = "# Agent instructions",
  overrides: Partial<AgentInstructionsFileDetail> = {},
): AgentInstructionsFileDetail {
  return {
    ...summary,
    content,
    ...overrides,
  };
}

function makeBundle(
  entryFile: string,
  files: AgentInstructionsFileSummary[],
  overrides: Partial<AgentInstructionsBundle> = {},
): AgentInstructionsBundle {
  return {
    agentId: "agent-1",
    companyId: "company-1",
    mode: "managed",
    rootPath: "/paperclip/agents/agent-1/instructions",
    managedRootPath: "/paperclip/agents/agent-1/instructions",
    entryFile,
    resolvedEntryPath: `/paperclip/agents/agent-1/instructions/${entryFile}`,
    editable: true,
    warnings: [],
    legacyPromptTemplateActive: false,
    legacyBootstrapPromptTemplateActive: false,
    files,
    ...overrides,
  };
}

describe("PromptsTab instruction editor", () => {
  let container: HTMLDivElement;
  let root: Root | null;
  let queryClient: QueryClient;
  let saveAction: (() => void) | null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = null;
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    saveAction = null;
    markdownEditorRenderMock.mockClear();
    Object.values(mockAgentsApi).forEach((mock) => mock.mockReset());
    mockAgentsApi.updateInstructionsBundle.mockResolvedValue({});
    mockAgentsApi.saveInstructionsFile.mockImplementation(async (_agentId, data) => ({
      path: data.path,
      size: data.content.length,
      language: "markdown",
      markdown: true,
      isEntryFile: true,
      editable: true,
      deprecated: false,
      virtual: false,
      content: data.content,
    }));
    mockAgentsApi.deleteInstructionsFile.mockResolvedValue({});
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root?.unmount();
      });
    }
    queryClient.clear();
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  async function renderPromptsTab(
    bundle: AgentInstructionsBundle,
    details: Record<string, AgentInstructionsFileDetail>,
    props: Partial<ComponentProps<typeof PromptsTab>> = {},
  ) {
    mockAgentsApi.instructionsBundle.mockResolvedValue(bundle);
    mockAgentsApi.instructionsFile.mockImplementation(async (_agentId: string, path: string) => {
      const detail = details[path];
      if (!detail) throw new Error(`Missing detail for ${path}`);
      return detail;
    });

    root = createRoot(container);
    await act(async () => {
      root?.render(
        <QueryClientProvider client={queryClient}>
          <PromptsTab
            agent={props.agent ?? makeAgent()}
            companyId={props.companyId ?? "company-1"}
            onDirtyChange={props.onDirtyChange ?? vi.fn()}
            onSaveActionChange={props.onSaveActionChange ?? ((next) => { saveAction = next; })}
            onCancelActionChange={props.onCancelActionChange ?? vi.fn()}
            onSavingChange={props.onSavingChange ?? vi.fn()}
          />
        </QueryClientProvider>,
      );
    });
    await flushReact();
  }

  it("uses server markdown metadata for extensionless files and saves MarkdownEditor drafts", async () => {
    const summary = makeSummary("AGENTS", "AGENTS", {
      language: "markdown",
      markdown: true,
    });
    await renderPromptsTab(
      makeBundle("AGENTS", [summary]),
      { AGENTS: makeDetail(summary, "# Current") },
    );

    const editor = await waitFor(() => {
      const candidate = container.querySelector<HTMLTextAreaElement>('[data-testid="markdown-editor"]');
      expect(candidate).not.toBeNull();
      return candidate!;
    });
    expect(markdownEditorRenderMock).toHaveBeenLastCalledWith(expect.objectContaining({
      contentClassName: expect.not.stringContaining("font-mono"),
      hasImageUploadHandler: true,
      value: "# Current",
    }));

    await act(async () => {
      setNativeValue(editor, "# Updated");
    });
    await waitFor(() => {
      expect(saveAction).toEqual(expect.any(Function));
    });

    saveAction?.();
    await waitFor(() => {
      expect(mockAgentsApi.saveInstructionsFile).toHaveBeenCalledWith(
        "agent-1",
        {
          path: "AGENTS",
          content: "# Updated",
          clearLegacyPromptTemplate: false,
        },
        "company-1",
      );
    });
  });

  it("uses the Markdown editor for pending new .md files before server metadata exists", async () => {
    const summary = makeSummary("settings.json", "settings.json", {
      language: "json",
      markdown: false,
    });
    await renderPromptsTab(
      makeBundle("settings.json", [summary]),
      { "settings.json": makeDetail(summary, "{\n  \"ok\": true\n}") },
    );

    await waitFor(() => {
      expect(container.querySelector<HTMLTextAreaElement>('textarea[placeholder="File contents"]')).not.toBeNull();
    });

    await act(async () => {
      buttonByText(container, "+").click();
    });
    await flushReact();
    const input = container.querySelector<HTMLInputElement>('input[placeholder="TOOLS.md"]');
    expect(input).not.toBeNull();

    await act(async () => {
      setNativeValue(input!, "notes.md");
      buttonByText(container, "Create").click();
    });

    await waitFor(() => {
      expect(container.querySelector('[data-testid="markdown-editor"]')).not.toBeNull();
    });
    expect(mockAgentsApi.instructionsFile).not.toHaveBeenCalledWith("agent-1", "notes.md", "company-1");
  });

  it("falls back to extension detection for existing .md files when metadata is missing", async () => {
    const summary = makeSummary("FALLBACK.md", "FALLBACK.md", {
      language: "text",
      markdown: undefined,
    });
    await renderPromptsTab(
      makeBundle("FALLBACK.md", [summary]),
      { "FALLBACK.md": makeDetail(summary, "# Fallback", { markdown: undefined }) },
    );

    await waitFor(() => {
      expect(container.querySelector("[data-testid=\"markdown-editor\"]")).not.toBeNull();
      expect(markdownEditorRenderMock).toHaveBeenLastCalledWith(expect.objectContaining({
        value: "# Fallback",
      }));
    });
  });

  it("keeps the raw textarea when server metadata marks an .md file as non-Markdown", async () => {
    const summary = makeSummary("NOTES.md", "NOTES.md", {
      language: "text",
      markdown: false,
    });
    await renderPromptsTab(
      makeBundle("NOTES.md", [summary]),
      { "NOTES.md": makeDetail(summary, "raw instructions") },
    );

    await waitFor(() => {
      expect(container.querySelector('[data-testid="markdown-editor"]')).toBeNull();
      expect(container.querySelector<HTMLTextAreaElement>('textarea[placeholder="File contents"]')?.value).toBe("raw instructions");
    });
  });
});
