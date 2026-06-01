// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginRecord } from "@paperclipai/shared";

const mockPluginsApi = vi.hoisted(() => ({
  list: vi.fn(),
}));

vi.mock("@/api/plugins", () => ({
  pluginsApi: mockPluginsApi,
}));

vi.mock("@/lib/router", () => ({
  NavLink: ({
    children,
    to,
    className,
  }: {
    children: ReactNode | ((arg: { isActive: boolean }) => ReactNode);
    to: string;
    state?: unknown;
    end?: boolean;
    onClick?: () => void;
    className?: string | ((arg: { isActive: boolean }) => string);
  }) => {
    const resolvedClass =
      typeof className === "function" ? className({ isActive: false }) : className;
    const content = typeof children === "function" ? children({ isActive: false }) : children;
    return (
      <a href={to} className={resolvedClass}>
        {content}
      </a>
    );
  },
}));

vi.mock("../context/SidebarContext", () => ({
  useSidebar: () => ({ isMobile: false, setSidebarOpen: vi.fn() }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

import { InstanceSidebar } from "./InstanceSidebar";

function makePlugin(overrides: Partial<PluginRecord> & { manifestJson: PluginRecord["manifestJson"] }): PluginRecord {
  return {
    id: overrides.id ?? "plugin-id",
    pluginKey: overrides.pluginKey ?? "plugin-key",
    packageName: overrides.packageName ?? "@scope/pkg",
    version: overrides.version ?? "1.0.0",
    apiVersion: overrides.apiVersion ?? 1,
    categories: overrides.categories ?? [],
    manifestJson: overrides.manifestJson,
    status: overrides.status ?? "ready",
    installOrder: overrides.installOrder ?? 0,
    packagePath: overrides.packagePath ?? null,
    lastError: overrides.lastError ?? null,
    installedAt: overrides.installedAt ?? new Date(0),
    updatedAt: overrides.updatedAt ?? new Date(0),
  };
}

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

async function findPluginLinks(container: HTMLElement, expectedCount: number) {
  await act(async () => {
    await vi.waitFor(() => {
      expect(container.querySelectorAll('a[href^="/instance/settings/plugins/"]')).toHaveLength(expectedCount);
    });
  });
  return Array.from(container.querySelectorAll<HTMLAnchorElement>('a[href^="/instance/settings/plugins/"]'));
}

function renderSidebar(container: HTMLElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const root = createRoot(container);
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <InstanceSidebar />
      </QueryClientProvider>,
    );
  });
  return { root, queryClient };
}

describe("InstanceSidebar", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot> | null;
  let queryClient: QueryClient | null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = null;
    queryClient = null;
    mockPluginsApi.list.mockReset();
  });

  afterEach(async () => {
    if (root) {
      const currentRoot = root;
      await act(async () => {
        currentRoot.unmount();
      });
    }
    queryClient?.clear();
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("filters out sandbox-provider-only plugins from the sidebar", async () => {
    const sandboxPlugin = makePlugin({
      id: "e2b",
      packageName: "@paperclipai/plugin-e2b",
      manifestJson: {
        id: "e2b",
        name: "E2B Sandbox Provider",
        displayName: "E2B Sandbox Provider",
        version: "1.0.0",
        apiVersion: 1,
        environmentDrivers: [
          {
            driverKey: "e2b",
            kind: "sandbox_provider",
            displayName: "E2B",
            configSchema: { type: "object" },
          },
        ],
      } as unknown as PluginRecord["manifestJson"],
    });
    const regularPlugin = makePlugin({
      id: "linear",
      packageName: "@paperclipai/plugin-linear",
      manifestJson: {
        id: "linear",
        name: "Linear",
        displayName: "Linear",
        version: "1.0.0",
        apiVersion: 1,
      } as unknown as PluginRecord["manifestJson"],
    });
    mockPluginsApi.list.mockResolvedValue([sandboxPlugin, regularPlugin]);

    const rendered = renderSidebar(container);
    root = rendered.root;
    queryClient = rendered.queryClient;
    await flushReact();

    const pluginLinks = await findPluginLinks(container, 1);
    expect(pluginLinks[0]?.getAttribute("href")).toBe("/instance/settings/plugins/linear");
    expect(pluginLinks[0]?.textContent).toBe("Linear");
  });

  it("keeps plugins that mix sandbox-provider with other contributions", async () => {
    const hybridPlugin = makePlugin({
      id: "hybrid",
      packageName: "@example/plugin-hybrid",
      manifestJson: {
        id: "hybrid",
        name: "Hybrid",
        displayName: "Hybrid",
        version: "1.0.0",
        apiVersion: 1,
        environmentDrivers: [
          {
            driverKey: "sb",
            kind: "sandbox_provider",
            displayName: "SB",
            configSchema: { type: "object" },
          },
          {
            driverKey: "env",
            kind: "environment_driver",
            displayName: "Env",
            configSchema: { type: "object" },
          },
        ],
      } as unknown as PluginRecord["manifestJson"],
    });
    mockPluginsApi.list.mockResolvedValue([hybridPlugin]);

    const rendered = renderSidebar(container);
    root = rendered.root;
    queryClient = rendered.queryClient;
    await flushReact();

    const pluginLinks = await findPluginLinks(container, 1);
    expect(pluginLinks[0]?.getAttribute("href")).toBe("/instance/settings/plugins/hybrid");
  });

  it("renders the indented plugin list between the Plugins and Adapters rows", async () => {
    mockPluginsApi.list.mockResolvedValue([
      makePlugin({
        id: "linear",
        packageName: "@paperclipai/plugin-linear",
        manifestJson: {
          id: "linear",
          name: "Linear",
          displayName: "Linear",
          version: "1.0.0",
          apiVersion: 1,
        } as unknown as PluginRecord["manifestJson"],
      }),
    ]);

    const rendered = renderSidebar(container);
    root = rendered.root;
    queryClient = rendered.queryClient;
    await flushReact();
    await findPluginLinks(container, 1);

    await vi.waitFor(() => {
      const links = Array.from(
        container.querySelectorAll<HTMLAnchorElement>('a[href^="/instance/settings/"]'),
      );
      expect(links.some((a) => a.getAttribute("href") === "/instance/settings/plugins/linear")).toBe(true);
    });

    const topLevelLinks = Array.from(container.querySelectorAll<HTMLAnchorElement>('a[href^="/instance/settings/"]'));
    const hrefs = topLevelLinks.map((a) => a.getAttribute("href"));

    const pluginsIndex = hrefs.indexOf("/instance/settings/plugins");
    const adaptersIndex = hrefs.indexOf("/instance/settings/adapters");
    const linearIndex = hrefs.indexOf("/instance/settings/plugins/linear");

    expect(pluginsIndex).toBeGreaterThanOrEqual(0);
    expect(adaptersIndex).toBeGreaterThan(pluginsIndex);
    expect(linearIndex).toBeGreaterThan(pluginsIndex);
    expect(linearIndex).toBeLessThan(adaptersIndex);
  });

  it("does not render the indented group when every plugin is filtered out", async () => {
    mockPluginsApi.list.mockResolvedValue([
      makePlugin({
        id: "e2b",
        packageName: "@paperclipai/plugin-e2b",
        manifestJson: {
          id: "e2b",
          name: "E2B",
          displayName: "E2B",
          version: "1.0.0",
          apiVersion: 1,
          environmentDrivers: [
            {
              driverKey: "e2b",
              kind: "sandbox_provider",
              displayName: "E2B",
              configSchema: { type: "object" },
            },
          ],
        } as unknown as PluginRecord["manifestJson"],
      }),
    ]);

    const rendered = renderSidebar(container);
    root = rendered.root;
    queryClient = rendered.queryClient;
    await flushReact();

    await vi.waitFor(() => {
      expect(mockPluginsApi.list).toHaveBeenCalled();
    });
    const pluginLinks = Array.from(container.querySelectorAll('a[href^="/instance/settings/plugins/"]'));
    expect(pluginLinks).toHaveLength(0);
  });
});
