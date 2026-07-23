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
  triggerJob: vi.fn(),
  logs: vi.fn(),
  getConfig: vi.fn(),
  listLocalFolders: vi.fn(),
  configureLocalFolder: vi.fn(),
}));

const mockSetBreadcrumbs = vi.hoisted(() => vi.fn());
const mockPushToast = vi.hoisted(() => vi.fn());

vi.mock("@/api/plugins", () => ({
  pluginsApi: mockPluginsApi,
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

vi.mock("@/context/ToastContext", () => ({
  useToastActions: () => ({ pushToast: mockPushToast }),
}));

vi.mock("@/lib/router", () => ({
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => <a href={to}>{children}</a>,
  Navigate: () => null,
  useParams: () => ({ companyPrefix: "PAP", pluginId: "plugin-1" }),
}));

vi.mock("@/plugins/slots", () => ({
  PluginSlotMount: () => null,
  usePluginSlots: () => ({ slots: [] }),
}));

vi.mock("@/components/PageTabBar", () => ({
  PageTabBar: ({
    items,
    value,
    onValueChange,
  }: {
    items: Array<{ value: string; label: React.ReactNode }>;
    value?: string;
    onValueChange?: (value: string) => void;
  }) => (
    <div data-testid="page-tab-bar">
      {items.map((item) => (
        <button
          key={item.value}
          type="button"
          aria-pressed={value === item.value}
          onClick={() => onValueChange?.(item.value)}
        >
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
  return root;
}

describe("PluginSettings", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);

    mockPluginsApi.get.mockResolvedValue(basePlugin());
    mockPluginsApi.dashboard.mockResolvedValue(null);
    mockPluginsApi.triggerJob.mockResolvedValue({ runId: "run-1", jobId: "job-1" });
    mockPluginsApi.health.mockResolvedValue({ pluginId: "plugin-1", status: "ready", healthy: true, checks: [] });
    mockPluginsApi.logs.mockResolvedValue([]);
    mockPluginsApi.listLocalFolders.mockResolvedValue({
      pluginId: "plugin-1",
      companyId: "company-1",
      declarations: [],
      folders: [],
    });
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("routes environment-provider plugins to instance environments when they have no instance config", async () => {
    const root = await renderSettings(container);

    expect(container.textContent).toContain("Configure this plugin from Instance Settings → Environments.");
    expect(container.textContent).toContain("secret bindings still resolve through the selected company context");
    const link = container.querySelector('a[href="/company/settings/instance/environments"]');
    expect(link?.textContent).toContain("Open Environments");

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

    const root = await renderSettings(container);

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

    const root = await renderSettings(container);

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

    const root = await renderSettings(container);

    expect(container.textContent).toContain("Configured local folder cannot be inspected.");
    expect(container.textContent).toContain("Not inspected");
    expect(container.textContent).toContain("Configured root was not inspected.");
    expect(container.textContent).not.toContain("Present");

    await act(async () => {
      root.unmount();
    });
  });

  it("keeps the permissions list collapsed until explicitly expanded", async () => {
    mockPluginsApi.get.mockResolvedValue(basePlugin({
      status: "ready",
      manifestJson: {
        displayName: "LLM Wiki",
        version: "0.1.0",
        description: "Local-file LLM Wiki plugin.",
        author: "Paperclip",
        capabilities: ["local.folders", "filesystem.read", "filesystem.write"],
      },
    }));

    const root = await renderSettings(container);

    const statusTab = Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Status");
    expect(statusTab).toBeTruthy();

    await act(async () => {
      statusTab?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(container.textContent).toContain("Runtime Dashboard");
    expect(container.textContent).toContain("Permissions");
    expect(container.textContent).toContain("Show details");

    const details = container.querySelector("details");
    expect(details).toBeTruthy();
    expect(details?.open).toBe(false);

    const summary = container.querySelector("summary");
    expect(summary).toBeTruthy();

    await act(async () => {
      summary?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(container.textContent).toContain("Hide details");
    expect(details?.open).toBe(true);
    expect(container.textContent).toContain("filesystem.read");
    expect(container.textContent).toContain("filesystem.write");

    await act(async () => {
      root.unmount();
    });
  });

  it("separates current job reliability from older failure history", async () => {
    mockPluginsApi.get.mockResolvedValue(basePlugin({ status: "ready" }));
    mockPluginsApi.dashboard.mockResolvedValue({
      pluginId: "plugin-1",
      worker: {
        status: "running",
        pid: 123,
        uptime: 60_000,
        consecutiveCrashes: 0,
        totalCrashes: 0,
        pendingRequests: 0,
        lastCrashAt: null,
        nextRestartAt: null,
      },
      recentJobRuns: [],
      jobRunHealth: {
        last24Hours: {
          total: 431,
          succeeded: 431,
          failed: 0,
          pending: 0,
          queued: 0,
          running: 0,
          cancelled: 0,
        },
        last7Days: {
          total: 2700,
          succeeded: 2666,
          failed: 34,
          pending: 0,
          queued: 0,
          running: 0,
          cancelled: 0,
        },
        latestFailure: {
          jobKey: "ck.b2b-mail-sync",
          createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
        },
      },
      recentWebhookDeliveries: [],
      health: { pluginId: "plugin-1", status: "ready", healthy: true, checks: [] },
      checkedAt: new Date().toISOString(),
    });

    const root = await renderSettings(container);
    const statusTab = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Status",
    );

    await act(async () => {
      statusTab?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(container.textContent).toContain("24-hour reliability");
    expect(container.textContent).toContain("431 succeeded · 0 failed");
    expect(container.textContent).toContain("7 days: 2666 succeeded · 34 failed");
    expect(container.textContent).toContain("Last failure: ck.b2b-mail-sync");

    await act(async () => {
      root.unmount();
    });
  });

  it("shows every scheduled job and guards manual dispatch with a side-effect warning", async () => {
    const now = Date.now();
    mockPluginsApi.get.mockResolvedValue(basePlugin({ status: "ready" }));
    mockPluginsApi.dashboard.mockResolvedValue({
      pluginId: "plugin-1",
      worker: null,
      recentJobRuns: [],
      jobRunHealth: null,
      scheduledJobs: [
        {
          id: "job-1",
          jobKey: "paperclip.safe-watchdog",
          schedule: "*/15 * * * *",
          status: "active",
          lastRunAt: new Date(now - 15 * 60 * 1000).toISOString(),
          nextRunAt: new Date(now + 15 * 60 * 1000).toISOString(),
        },
        {
          id: "job-2",
          jobKey: "paperclip.daily-digest",
          schedule: "0 9 * * *",
          status: "paused",
          lastRunAt: null,
          nextRunAt: null,
        },
      ],
      recentWebhookDeliveries: [],
      health: { pluginId: "plugin-1", status: "ready", healthy: true, checks: [] },
      checkedAt: new Date(now).toISOString(),
    });

    const root = await renderSettings(container);
    const statusTab = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Status",
    );
    await act(async () => {
      statusTab?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(container.textContent).toContain("Scheduled Jobs");
    expect(container.textContent).toContain("2 configured");
    expect(container.textContent).toContain("paperclip.safe-watchdog");
    expect(container.textContent).toContain("paperclip.daily-digest");
    expect(container.querySelector('span[title="active"]')?.className).toContain("bg-green-500");
    expect(container.querySelector('span[title="paused"]')?.className).toContain("bg-gray-400");
    const pausedButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Run paperclip.daily-digest now"]',
    );
    expect(pausedButton?.disabled).toBe(true);

    const runButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Run paperclip.safe-watchdog now"]',
    );
    await act(async () => {
      runButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(document.body.textContent).toContain("Run scheduled job now?");
    expect(document.body.textContent).toContain("may write data, contact connected systems");
    const confirmButton = Array.from(document.body.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Run job"),
    );
    await act(async () => {
      confirmButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(mockPluginsApi.triggerJob).toHaveBeenCalledWith("plugin-1", "job-1");

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

    const root = await renderSettings(container);

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
});
