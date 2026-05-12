// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PluginSettings } from "./PluginSettings";

const mockPluginsApi = vi.hoisted(() => ({
  get: vi.fn(),
  health: vi.fn(),
  dashboard: vi.fn(),
  logs: vi.fn(),
  getConfig: vi.fn(),
  getRuntimeConfig: vi.fn(),
  clearRuntimeConfig: vi.fn(),
  listLocalFolders: vi.fn(),
  configureLocalFolder: vi.fn(),
}));

const mockAccessApi = vi.hoisted(() => ({
  getCurrentBoardAccess: vi.fn(),
}));

const mockSetBreadcrumbs = vi.hoisted(() => vi.fn());
const mockRouteParams = vi.hoisted(() => ({
  companyPrefix: "PAP",
  pluginId: "plugin-1",
}));

vi.mock("@/api/plugins", () => ({
  pluginsApi: mockPluginsApi,
}));

vi.mock("@/api/access", () => ({
  accessApi: mockAccessApi,
}));

vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({
    setBreadcrumbs: mockSetBreadcrumbs,
  }),
}));

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompany: { id: "company-1", name: "Paperclip", issuePrefix: "PAP" },
    selectedCompanyId: "company-1",
  }),
}));

vi.mock("@/lib/router", () => ({
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => <a href={to}>{children}</a>,
  Navigate: () => null,
  useParams: () => mockRouteParams,
}));

vi.mock("@/plugins/slots", () => ({
  PluginSlotMount: () => null,
  usePluginSlots: () => ({ slots: [] }),
}));

vi.mock("@/components/PageTabBar", () => ({
  PageTabBar: ({
    items,
    onValueChange,
  }: {
    items: Array<{ value: string; label: string }>;
    onValueChange: (value: string) => void;
  }) => (
    <div>
      {items.map((item) => (
        <button key={item.value} type="button" onClick={() => onValueChange(item.value)}>
          {item.label}
        </button>
      ))}
    </div>
  ),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

function basePlugin(overrides: Record<string, unknown> = {}) {
  return {
    id: "plugin-1",
    pluginKey: "paperclip.e2b-sandbox-provider",
    packageName: "@paperclipai/plugin-e2b",
    version: "0.1.0",
    status: "error",
    categories: ["automation"],
    manifestJson: {
      displayName: "E2B Sandbox Provider",
      version: "0.1.0",
      description: "E2B environments for Paperclip.",
      author: "Paperclip",
      capabilities: ["environment.drivers.register"],
      environmentDrivers: [
        {
          driverKey: "e2b",
          kind: "sandbox_provider",
          displayName: "E2B Cloud Sandbox",
        },
      ],
    },
    lastError: null,
    ...overrides,
  };
}

function wikiFolderDeclaration() {
  return {
    folderKey: "wiki-root",
    displayName: "Wiki root",
    description: "Company-scoped local folder that stores wiki files.",
    access: "readWrite" as const,
    requiredDirectories: ["raw", "wiki"],
    requiredFiles: ["WIKI.md", "index.md"],
  };
}

function folderStatus(overrides: Record<string, unknown> = {}) {
  return {
    folderKey: "wiki-root",
    configured: false,
    path: null,
    realPath: null,
    access: "readWrite",
    readable: false,
    writable: false,
    requiredDirectories: ["raw", "wiki"],
    requiredFiles: ["WIKI.md", "index.md"],
    missingDirectories: ["raw", "wiki"],
    missingFiles: ["WIKI.md", "index.md"],
    healthy: false,
    problems: [{ code: "not_configured", message: "No local folder path is configured." }],
    checkedAt: "2026-05-02T16:00:00.000Z",
    ...overrides,
  };
}

async function renderSettings(container: HTMLDivElement) {
  const root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <PluginSettings />
      </QueryClientProvider>,
    );
  });
  await flushReact();
  await flushReact();
  return { root, queryClient };
}

describe("PluginSettings", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    mockRouteParams.companyPrefix = "PAP";
    mockRouteParams.pluginId = "plugin-1";
    container = document.createElement("div");
    document.body.appendChild(container);

    mockPluginsApi.get.mockResolvedValue(basePlugin());
    mockPluginsApi.dashboard.mockResolvedValue(null);
    mockPluginsApi.health.mockResolvedValue({ pluginId: "plugin-1", status: "ready", healthy: true, checks: [] });
    mockPluginsApi.logs.mockResolvedValue([]);
    mockPluginsApi.getRuntimeConfig.mockResolvedValue({ values: {}, revision: "0" });
    mockPluginsApi.clearRuntimeConfig.mockResolvedValue(undefined);
    mockPluginsApi.listLocalFolders.mockResolvedValue({
      pluginId: "plugin-1",
      companyId: "company-1",
      declarations: [],
      folders: [],
    });
    mockAccessApi.getCurrentBoardAccess.mockResolvedValue({
      isInstanceAdmin: false,
      userId: "user-1",
      boardUserId: "board-user-1",
      localBoard: false,
    });
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("clears runtime config restart warnings when navigating between plugin ids", async () => {
    mockPluginsApi.get.mockImplementation(async (pluginId: string) => basePlugin({
      id: pluginId,
      packageName: `@paperclipai/${pluginId}`,
      manifestJson: {
        displayName: pluginId,
        version: "0.1.0",
        description: "Runtime config plugin.",
        author: "Paperclip",
        capabilities: [],
      },
    }));
    mockPluginsApi.getRuntimeConfig.mockResolvedValue({
      values: { mode: "paused" },
      revision: "7",
    });
    mockAccessApi.getCurrentBoardAccess.mockResolvedValue({
      isInstanceAdmin: true,
      userId: "user-1",
      boardUserId: "board-user-1",
      source: "session",
    });
    mockPluginsApi.clearRuntimeConfig.mockResolvedValue({
      cleared: true,
      restart: { attempted: true, status: "failed", message: "Worker restart failed after runtime config was cleared." },
    });

    const { root } = await renderSettings(container);

    await act(async () => {
      Array.from(container.querySelectorAll("button"))
        .find((button) => button.textContent === "Status")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    await act(async () => {
      Array.from(container.querySelectorAll("button"))
        .find((button) => button.textContent === "Clear Runtime Config")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
    expect(container.textContent).toContain("Runtime config cleared, but worker restart failed");

    mockRouteParams.pluginId = "plugin-2";
    await act(async () => {
      root.render(
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <PluginSettings />
        </QueryClientProvider>,
      );
    });
    await flushReact();

    expect(container.textContent).not.toContain("Runtime config cleared, but worker restart failed");

    await act(async () => {
      root.unmount();
    });
  });

  it("ignores runtime config restart warnings from stale clear requests", async () => {
    mockPluginsApi.get.mockImplementation(async (pluginId: string) => basePlugin({
      id: pluginId,
      packageName: `@paperclipai/${pluginId}`,
      manifestJson: {
        displayName: pluginId,
        version: "0.1.0",
        description: "Runtime config plugin.",
        author: "Paperclip",
        capabilities: [],
      },
    }));
    mockPluginsApi.getRuntimeConfig.mockResolvedValue({
      values: { mode: "paused" },
      revision: "7",
    });
    mockAccessApi.getCurrentBoardAccess.mockResolvedValue({
      isInstanceAdmin: true,
      userId: "user-1",
      boardUserId: "board-user-1",
      source: "session",
    });
    let resolveClear: ((value: Awaited<ReturnType<typeof mockPluginsApi.clearRuntimeConfig>>) => void) | null = null;
    mockPluginsApi.clearRuntimeConfig.mockImplementation(
      () => new Promise((resolve) => {
        resolveClear = resolve;
      }),
    );

    const { root } = await renderSettings(container);

    await act(async () => {
      Array.from(container.querySelectorAll("button"))
        .find((button) => button.textContent === "Status")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    await act(async () => {
      Array.from(container.querySelectorAll("button"))
        .find((button) => button.textContent === "Clear Runtime Config")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    mockRouteParams.pluginId = "plugin-2";
    await act(async () => {
      root.render(
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <PluginSettings />
        </QueryClientProvider>,
      );
    });
    await flushReact();

    await act(async () => {
      resolveClear?.({
        cleared: true,
        restart: { attempted: true, status: "failed", message: "Worker restart failed after runtime config was cleared." },
      });
    });
    await flushReact();

    expect(container.textContent).not.toContain("Runtime config cleared, but worker restart failed");

    await act(async () => {
      root.unmount();
    });
  });

  it("routes environment-provider plugins to company environments when they have no instance config", async () => {
    const { root } = await renderSettings(container);

    expect(container.textContent).toContain("Configure this plugin from Company Environments.");
    expect(container.textContent).toContain("company-scoped instead of instance-global");
    const link = container.querySelector('a[href="/company/settings/environments"]');
    expect(link?.textContent).toContain("Open Company Environments");

    await act(async () => {
      root.unmount();
    });
  });

  it("renders unconfigured manifest local folders with required paths", async () => {
    const declaration = wikiFolderDeclaration();
    mockPluginsApi.get.mockResolvedValue(basePlugin({
      pluginKey: "paperclipai.plugin-llm-wiki",
      packageName: "@paperclipai/plugin-llm-wiki",
      status: "ready",
      manifestJson: {
        displayName: "LLM Wiki",
        version: "0.1.0",
        description: "Local-file LLM Wiki plugin.",
        author: "Paperclip",
        capabilities: ["local.folders"],
        localFolders: [declaration],
      },
    }));
    mockPluginsApi.listLocalFolders.mockResolvedValue({
      pluginId: "plugin-1",
      companyId: "company-1",
      declarations: [declaration],
      folders: [folderStatus()],
    });

    const { root } = await renderSettings(container);

    expect(container.textContent).toContain("Local folders");
    expect(container.textContent).toContain("Wiki root");
    expect(container.textContent).toContain("Needs attention");
    expect(container.textContent).toContain("No local folder path is configured.");
    expect(container.textContent).toContain("Missing directories: raw, wiki");
    expect(container.textContent).toContain("Missing files: WIKI.md, index.md");

    await act(async () => {
      root.unmount();
    });
  });

  it("renders invalid configured folders with validation problems", async () => {
    const declaration = wikiFolderDeclaration();
    mockPluginsApi.get.mockResolvedValue(basePlugin({
      manifestJson: {
        displayName: "LLM Wiki",
        version: "0.1.0",
        description: "Local-file LLM Wiki plugin.",
        author: "Paperclip",
        capabilities: ["local.folders"],
        localFolders: [declaration],
      },
    }));
    mockPluginsApi.listLocalFolders.mockResolvedValue({
      pluginId: "plugin-1",
      companyId: "company-1",
      declarations: [declaration],
      folders: [folderStatus({
        configured: true,
        path: "/tmp/wiki",
        realPath: "/tmp/wiki",
        readable: true,
        writable: true,
        missingDirectories: [],
        missingFiles: ["WIKI.md"],
        problems: [{ code: "missing_file", message: "Required file is missing.", path: "WIKI.md" }],
      })],
    });

    const { root } = await renderSettings(container);

    expect(container.textContent).toContain("/tmp/wiki");
    expect(container.textContent).toContain("ReadableYes");
    expect(container.textContent).toContain("WritableYes");
    expect(container.textContent).toContain("Validation problems");
    expect(container.textContent).toContain("Required file is missing.");
    expect(container.textContent).toContain("Missing files: WIKI.md");

    await act(async () => {
      root.unmount();
    });
  });

  it("does not render required paths as present when the configured root cannot be inspected", async () => {
    const declaration = wikiFolderDeclaration();
    mockPluginsApi.get.mockResolvedValue(basePlugin({
      manifestJson: {
        displayName: "LLM Wiki",
        version: "0.1.0",
        description: "Local-file LLM Wiki plugin.",
        author: "Paperclip",
        capabilities: ["local.folders"],
        localFolders: [declaration],
      },
    }));
    mockPluginsApi.listLocalFolders.mockResolvedValue({
      pluginId: "plugin-1",
      companyId: "company-1",
      declarations: [declaration],
      folders: [folderStatus({
        configured: true,
        path: "/tmp/wiki-missing",
        readable: false,
        writable: false,
        missingDirectories: [],
        missingFiles: [],
        problems: [{ code: "missing", message: "Configured local folder cannot be inspected.", path: "/tmp/wiki-missing" }],
      })],
    });

    const { root } = await renderSettings(container);

    expect(container.textContent).toContain("Configured local folder cannot be inspected.");
    expect(container.textContent).toContain("Not inspected");
    expect(container.textContent).toContain("Configured root was not inspected.");
    expect(container.textContent).not.toContain("Present");

    await act(async () => {
      root.unmount();
    });
  });

  it("renders healthy folders without validation problems", async () => {
    const declaration = wikiFolderDeclaration();
    mockPluginsApi.get.mockResolvedValue(basePlugin({
      manifestJson: {
        displayName: "LLM Wiki",
        version: "0.1.0",
        description: "Local-file LLM Wiki plugin.",
        author: "Paperclip",
        capabilities: ["local.folders"],
        localFolders: [declaration],
      },
    }));
    mockPluginsApi.listLocalFolders.mockResolvedValue({
      pluginId: "plugin-1",
      companyId: "company-1",
      declarations: [declaration],
      folders: [folderStatus({
        configured: true,
        path: "/tmp/wiki",
        realPath: "/private/tmp/wiki",
        readable: true,
        writable: true,
        missingDirectories: [],
        missingFiles: [],
        healthy: true,
        problems: [],
      })],
    });

    const { root } = await renderSettings(container);

    expect(container.textContent).toContain("Healthy");
    expect(container.textContent).toContain("Configured path");
    expect(container.textContent).toContain("/tmp/wiki");
    expect(container.textContent).toContain("ReadableYes");
    expect(container.textContent).toContain("WritableYes");
    expect(container.textContent).toContain("Present");
    expect(container.textContent).not.toContain("Validation problems");

    await act(async () => {
      root.unmount();
    });
  });

  it("shows operator runtime config even when plugin.config.write is not declared", async () => {
    mockPluginsApi.get.mockResolvedValue(basePlugin({
      status: "ready",
      manifestJson: {
        displayName: "Runtime Plugin",
        version: "0.1.0",
        description: "Runtime config plugin.",
        author: "Paperclip",
        capabilities: [],
      },
    }));
    mockPluginsApi.getRuntimeConfig.mockResolvedValue({
      values: { mode: "paused" },
      revision: "7",
    });

    const { root } = await renderSettings(container);

    await act(async () => {
      Array.from(container.querySelectorAll("button"))
        .find((button) => button.textContent === "Status")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(mockPluginsApi.getRuntimeConfig).toHaveBeenCalledWith("plugin-1");
    expect(container.textContent).toContain("Runtime Config");
    expect(container.textContent).toContain("Revision 7");
    expect(container.textContent).toContain('"mode": "paused"');

    await act(async () => {
      root.unmount();
    });
  });

  it("allows local implicit operators to clear runtime config", async () => {
    mockPluginsApi.get.mockResolvedValue(basePlugin({
      status: "ready",
      manifestJson: {
        displayName: "Runtime Plugin",
        version: "0.1.0",
        description: "Runtime config plugin.",
        author: "Paperclip",
        capabilities: [],
      },
    }));
    mockPluginsApi.getRuntimeConfig.mockResolvedValue({
      values: { mode: "paused" },
      revision: "7",
    });
    mockAccessApi.getCurrentBoardAccess.mockResolvedValue({
      isInstanceAdmin: false,
      userId: "user-1",
      boardUserId: "board-user-1",
      localBoard: true,
      source: "local_implicit",
    });

    const { root } = await renderSettings(container);

    await act(async () => {
      Array.from(container.querySelectorAll("button"))
        .find((button) => button.textContent === "Status")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    const clearButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent === "Clear Runtime Config");
    expect(clearButton).toBeTruthy();

    await act(async () => {
      clearButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(mockPluginsApi.clearRuntimeConfig).toHaveBeenCalledWith("plugin-1");

    await act(async () => {
      root.unmount();
    });
  });

  it("surfaces runtime config clear failures and restart warnings", async () => {
    mockPluginsApi.get.mockResolvedValue(basePlugin({
      status: "ready",
      manifestJson: {
        displayName: "Runtime Plugin",
        version: "0.1.0",
        description: "Runtime config plugin.",
        author: "Paperclip",
        capabilities: [],
      },
    }));
    mockPluginsApi.getRuntimeConfig.mockResolvedValue({
      values: { mode: "paused" },
      revision: "7",
    });
    mockAccessApi.getCurrentBoardAccess.mockResolvedValue({
      isInstanceAdmin: true,
      userId: "user-1",
      boardUserId: "board-user-1",
      source: "session",
    });
    mockPluginsApi.clearRuntimeConfig.mockResolvedValue({
      cleared: true,
      restart: { attempted: true, status: "failed", message: "Worker restart failed after runtime config was cleared." },
    });

    const { root, queryClient } = await renderSettings(container);

    await act(async () => {
      Array.from(container.querySelectorAll("button"))
        .find((button) => button.textContent === "Status")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    const clearButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent === "Clear Runtime Config");
    await act(async () => {
      clearButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(container.textContent).toContain("Runtime config cleared, but worker restart failed: Worker restart failed after runtime config was cleared.");

    mockPluginsApi.getRuntimeConfig.mockResolvedValue({
      values: {},
      revision: "8",
    });
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ["plugins", "plugin-1", "runtime-config"] });
    });
    await flushReact();

    expect(container.textContent).toContain("No runtime config stored.");
    expect(container.textContent).toContain("Runtime config cleared, but worker restart failed: Worker restart failed after runtime config was cleared.");

    await act(async () => {
      root.unmount();
    });
  });

  it("shows runtime config fetch errors instead of the empty state", async () => {
    mockPluginsApi.get.mockResolvedValue(basePlugin({
      status: "ready",
      manifestJson: {
        displayName: "Runtime Plugin",
        version: "0.1.0",
        description: "Runtime config plugin.",
        author: "Paperclip",
        capabilities: [],
      },
    }));
    mockPluginsApi.getRuntimeConfig.mockRejectedValue(new Error("forbidden"));

    const { root } = await renderSettings(container);

    await act(async () => {
      Array.from(container.querySelectorAll("button"))
        .find((button) => button.textContent === "Status")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(container.textContent).toContain("Failed to load runtime config: forbidden");
    expect(container.textContent).not.toContain("No runtime config stored.");

    await act(async () => {
      root.unmount();
    });
  });
});
