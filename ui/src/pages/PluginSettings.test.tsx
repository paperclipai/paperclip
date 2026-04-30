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
}));

const mockSetBreadcrumbs = vi.hoisted(() => vi.fn());

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
  PageTabBar: () => null,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

describe("PluginSettings", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);

    mockPluginsApi.get.mockResolvedValue({
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
    });
    mockPluginsApi.dashboard.mockResolvedValue(null);
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("routes environment-provider plugins to company environments when they have no instance config", async () => {
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

    expect(container.textContent).toContain("Configure this plugin from Company Environments.");
    expect(container.textContent).toContain("company-scoped instead of instance-global");
    const link = container.querySelector('a[href="/company/settings/environments"]');
    expect(link?.textContent).toContain("Open Company Environments");

    await act(async () => {
      root.unmount();
    });
  });
});
