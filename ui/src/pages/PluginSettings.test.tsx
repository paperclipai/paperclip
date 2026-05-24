// @vitest-environment jsdom

import { flushSync } from "react-dom";
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
  listLocalFolders: vi.fn(),
  configureLocalFolder: vi.fn(),
}));

const mockSetBreadcrumbs = vi.hoisted(() => vi.fn());
const mockPluginSlots = vi.hoisted(() => ({
  slots: [] as Array<{
    pluginId: string;
    pluginKey: string;
    displayName: string;
    type: string;
  }>,
}));
const mockRouteParams = vi.hoisted(() => ({
  pluginId: "plugin-1" as string,
  companyPrefix: "PAP" as string | undefined,
}));
const mockCompanyState = vi.hoisted(() => ({
  companies: [{ id: "company-1", name: "Paperclip", issuePrefix: "PAP" }] as Array<{
    id: string;
    name: string;
    issuePrefix: string;
  }>,
  selectedCompany: { id: "company-1", name: "Paperclip", issuePrefix: "PAP" } as {
    id: string;
    name: string;
    issuePrefix: string;
  } | null,
  selectedCompanyId: "company-1" as string | null,
}));

vi.mock("@/api/plugins", () => ({
  pluginsApi: mockPluginsApi,
}));

vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({
    setBreadcrumbs: mockSetBreadcrumbs,
  }),
}));

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => mockCompanyState,
}));

vi.mock("@/lib/router", () => ({
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => <a href={to}>{children}</a>,
  Navigate: () => null,
  useParams: () => ({ companyPrefix: mockRouteParams.companyPrefix, pluginId: mockRouteParams.pluginId }),
}));

vi.mock("@/plugins/slots", () => ({
  PluginSlotMount: ({ slot, context }: { slot: { displayName: string }; context: { companyId?: string | null; companyPrefix?: string | null } }) => (
    <div data-testid="plugin-slot-mount" data-company-id={context.companyId ?? ""} data-company-prefix={context.companyPrefix ?? ""}>
      {slot.displayName}
    </div>
  ),
  usePluginSlots: () => ({ slots: mockPluginSlots.slots }),
}));

vi.mock("@/components/PageTabBar", () => ({
  PageTabBar: () => null,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
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

  flushSync(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <PluginSettings />
      </QueryClientProvider>,
    );
  });
  await flushReact();
  await flushReact();
  return root;
}

describe("PluginSettings", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);

    mockPluginsApi.get.mockResolvedValue(basePlugin());
    mockPluginsApi.dashboard.mockResolvedValue(null);
    mockPluginsApi.health.mockResolvedValue({ pluginId: "plugin-1", status: "ready", healthy: true, checks: [] });
    mockPluginsApi.logs.mockResolvedValue([]);
    mockPluginsApi.listLocalFolders.mockResolvedValue({
      pluginId: "plugin-1",
      companyId: "company-1",
      declarations: [],
      folders: [],
    });
    mockPluginSlots.slots = [];
    mockRouteParams.pluginId = "plugin-1";
    mockRouteParams.companyPrefix = "PAP";
    mockCompanyState.companies = [{ id: "company-1", name: "Paperclip", issuePrefix: "PAP" }];
    mockCompanyState.selectedCompany = { id: "company-1", name: "Paperclip", issuePrefix: "PAP" };
    mockCompanyState.selectedCompanyId = "company-1";
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("routes environment-provider plugins to company environments when they have no instance config", async () => {
    const root = await renderSettings(container);

    expect(container.textContent).toContain("Configure this plugin from Company Environments.");
    expect(container.textContent).toContain("company-scoped instead of instance-global");
    const link = container.querySelector('a[href="/company/settings/environments"]');
    expect(link?.textContent).toContain("Open Company Environments");

    flushSync(() => root.unmount());
    await flushReact();
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

    const root = await renderSettings(container);

    expect(container.textContent).toContain("Local folders");
    expect(container.textContent).toContain("Wiki root");
    expect(container.textContent).toContain("Needs attention");
    expect(container.textContent).toContain("No local folder path is configured.");
    expect(container.textContent).toContain("Missing directories: raw, wiki");
    expect(container.textContent).toContain("Missing files: WIKI.md, index.md");

    flushSync(() => root.unmount());
    await flushReact();
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

    const root = await renderSettings(container);

    expect(container.textContent).toContain("/tmp/wiki");
    expect(container.textContent).toContain("ReadableYes");
    expect(container.textContent).toContain("WritableYes");
    expect(container.textContent).toContain("Validation problems");
    expect(container.textContent).toContain("Required file is missing.");
    expect(container.textContent).toContain("Missing files: WIKI.md");

    flushSync(() => root.unmount());
    await flushReact();
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

    const root = await renderSettings(container);

    expect(container.textContent).toContain("Configured local folder cannot be inspected.");
    expect(container.textContent).toContain("Not inspected");
    expect(container.textContent).toContain("Configured root was not inspected.");
    expect(container.textContent).not.toContain("Present");

    flushSync(() => root.unmount());
    await flushReact();
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

    const root = await renderSettings(container);

    expect(container.textContent).toContain("Healthy");
    expect(container.textContent).toContain("Configured path");
    expect(container.textContent).toContain("/tmp/wiki");
    expect(container.textContent).toContain("ReadableYes");
    expect(container.textContent).toContain("WritableYes");
    expect(container.textContent).toContain("Present");
    expect(container.textContent).not.toContain("Validation problems");

    flushSync(() => root.unmount());
    await flushReact();
  });

  it("matches custom settings slots when routed by plugin key", async () => {
    mockRouteParams.pluginId = "paperclipai.plugin-briefs";
    mockPluginsApi.get.mockResolvedValue(basePlugin({
      id: "plugin-briefs-uuid",
      pluginKey: "paperclipai.plugin-briefs",
      packageName: "@paperclipai/plugin-briefs",
      status: "ready",
      manifestJson: {
        displayName: "Briefs",
        version: "0.1.0",
        description: "Briefing cards.",
        author: "Paperclip",
        capabilities: [],
      },
    }));
    mockPluginSlots.slots = [{
      pluginId: "plugin-briefs-uuid",
      pluginKey: "paperclipai.plugin-briefs",
      displayName: "Briefing",
      type: "settingsPage",
    }];

    const root = await renderSettings(container);

    expect(container.querySelector('[data-testid="plugin-slot-mount"]')?.textContent).toBe("Briefing");

    flushSync(() => root.unmount());
    await flushReact();
  });

  it("uses the route company for custom settings slots even when another company is selected", async () => {
    mockRouteParams.pluginId = "paperclipai.plugin-briefs";
    mockRouteParams.companyPrefix = "PAP";
    mockCompanyState.companies = [
      { id: "company-pap", name: "Paperclip", issuePrefix: "PAP" },
      { id: "company-fr", name: "Forgotten Runes", issuePrefix: "FR" },
    ];
    mockCompanyState.selectedCompany = { id: "company-fr", name: "Forgotten Runes", issuePrefix: "FR" };
    mockCompanyState.selectedCompanyId = "company-fr";
    mockPluginsApi.get.mockResolvedValue(basePlugin({
      id: "plugin-briefs-uuid",
      pluginKey: "paperclipai.plugin-briefs",
      packageName: "@paperclipai/plugin-briefs",
      status: "ready",
      manifestJson: {
        displayName: "Briefs",
        version: "0.1.0",
        description: "Briefing cards.",
        author: "Paperclip",
        capabilities: [],
      },
    }));
    mockPluginSlots.slots = [{
      pluginId: "plugin-briefs-uuid",
      pluginKey: "paperclipai.plugin-briefs",
      displayName: "Briefing",
      type: "settingsPage",
    }];

    const root = await renderSettings(container);
    const slot = container.querySelector('[data-testid="plugin-slot-mount"]');

    expect(slot?.getAttribute("data-company-id")).toBe("company-pap");
    expect(slot?.getAttribute("data-company-prefix")).toBe("PAP");

    flushSync(() => root.unmount());
    await flushReact();
  });
});
