// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PluginManager } from "./PluginManager";

const mockSetBreadcrumbs = vi.hoisted(() => vi.fn());
const mockPushToast = vi.hoisted(() => vi.fn());
const mockPluginsApi = vi.hoisted(() => ({
  list: vi.fn(),
  listBundled: vi.fn(),
  install: vi.fn(),
  uninstall: vi.fn(),
  enable: vi.fn(),
  disable: vi.fn(),
}));

vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: mockSetBreadcrumbs }),
}));

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompany: { id: "company-1", name: "CK IT Solutions" },
    selectedCompanyId: "company-1",
  }),
}));

vi.mock("@/context/ToastContext", () => ({
  useToastActions: () => ({ pushToast: mockPushToast }),
}));

vi.mock("@/api/plugins", () => ({ pluginsApi: mockPluginsApi }));

vi.mock("@/lib/router", () => ({
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => <a href={to}>{children}</a>,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

function makeInstalledPlugin() {
  return {
    id: "plugin-installed-1",
    pluginKey: "deepseek-provider",
    packageName: "@paperclipai/plugin-deepseek",
    packagePath: "/work/ui/plugins/deepseek",
    status: "ready",
    version: "1.0.0",
    categories: ["provider"],
    lastError: null,
    manifestJson: {
      displayName: "DeepSeek Provider",
      version: "1.0.0",
      author: "Paperclip",
      description: "Provider plugin for DeepSeek models.",
      categories: ["provider"],
      capabilities: [],
      environmentDrivers: [],
      localFolders: [],
    },
  };
}

function makeBundledPlugin() {
  return {
    packageName: "@paperclipai/plugin-deepseek",
    localPath: "@paperclipai/plugin-deepseek",
    displayName: "DeepSeek Provider",
    description: "Provider plugin for DeepSeek models.",
    tag: "first-party",
    experimental: false,
    hasBuiltEntrypoints: true,
  };
}

describe("PluginManager", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockSetBreadcrumbs.mockReset();
    mockPushToast.mockReset();
    mockPluginsApi.list.mockResolvedValue([makeInstalledPlugin()]);
    mockPluginsApi.listBundled.mockResolvedValue([makeBundledPlugin()]);
    mockPluginsApi.install.mockResolvedValue({});
    mockPluginsApi.uninstall.mockResolvedValue({});
    mockPluginsApi.enable.mockResolvedValue({});
    mockPluginsApi.disable.mockResolvedValue({});
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("renders installed plugins before the bundled catalog", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <PluginManager />
        </QueryClientProvider>,
      );
    });
    await flushReact();

    const headings = Array.from(container.querySelectorAll("h2")).map((node) => node.textContent?.trim());
    expect(headings.slice(0, 2)).toEqual(["Installed Plugins", "Available Plugins"]);
    expect(container.textContent).toContain("All bundled plugins in this checkout are already installed above.");
    expect(container.textContent).not.toContain("Open Settings");
    expect(container.querySelector('[aria-label="Disable DeepSeek Provider"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Uninstall DeepSeek Provider"]')).not.toBeNull();

    await act(async () => {
      root.unmount();
    });
  });
});
