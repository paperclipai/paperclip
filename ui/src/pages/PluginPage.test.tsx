// @vitest-environment jsdom

import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PluginPage } from "./PluginPage";

const mockPluginsApi = vi.hoisted(() => ({
  listUiContributions: vi.fn(),
}));

const mockSetBreadcrumbs = vi.hoisted(() => vi.fn());
const mockParams = vi.hoisted(() => ({
  companyPrefix: "PAP" as string | undefined,
  pluginId: undefined as string | undefined,
  pluginRoutePath: undefined as string | undefined,
  "*": undefined as string | undefined,
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
  useCompany: () => ({
    companies: [{ id: "company-1", name: "Paperclip", issuePrefix: "PAP" }],
    selectedCompanyId: "company-1",
  }),
}));

vi.mock("@/lib/router", () => ({
  Link: ({ to, children }: { to: string; children: ReactNode }) => <a href={to}>{children}</a>,
  Navigate: () => null,
  useParams: () => mockParams,
}));

vi.mock("@/plugins/slots", async () => {
  const actual = await vi.importActual<typeof import("@/plugins/slots")>("@/plugins/slots");
  return {
    resolveRouteSidebarSlot: actual.resolveRouteSidebarSlot,
    PluginSlotMount: ({ slot }: { slot: { displayName: string } }) => (
      <div data-testid="plugin-slot-mount">{slot.displayName}</div>
    ),
  };
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
}

function pageContribution(overrides: Partial<{ pluginId: string; pluginKey: string; displayName: string; slots: unknown[] }> = {}) {
  return {
    pluginId: "plugin-wiki",
    pluginKey: "paperclipai.plugin-llm-wiki",
    displayName: "LLM Wiki",
    version: "0.1.0",
    uiEntryFile: "ui.js",
    slots: [
      {
        type: "page",
        id: "wiki-page",
        displayName: "Wiki",
        exportName: "WikiPage",
        routePath: "wiki",
      },
    ],
    launchers: [],
    ...overrides,
  };
}

async function renderPage(container: HTMLDivElement) {
  const root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  root.render(
    <QueryClientProvider client={queryClient}>
      <PluginPage />
    </QueryClientProvider>,
  );
  await flushReact();
  await flushReact();
  return root;
}

describe("PluginPage", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockParams.companyPrefix = "PAP";
    mockParams.pluginId = undefined;
    mockParams.pluginRoutePath = undefined;
    mockParams["*"] = undefined;
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("renders the breadcrumb and Back button on a legacy plugin route (no routeSidebar)", async () => {
    mockParams.pluginRoutePath = "wiki";
    mockPluginsApi.listUiContributions.mockResolvedValue([pageContribution()]);

    const root = await renderPage(container);

    expect(mockSetBreadcrumbs).toHaveBeenCalledWith([
      { label: "Plugins", href: "/instance/settings/plugins" },
      { label: "LLM Wiki" },
    ]);
    expect(container.textContent).toContain("Back");
    expect(container.querySelector('a[href="/PAP/dashboard"]')).not.toBeNull();
    expect(container.querySelector('a[href="/instance/settings/plugins/plugin-wiki"]')).not.toBeNull();

    root.unmount();
    await flushReact();
  });

  it("uses a route title and hides the Back button when a routeSidebar matches the active route", async () => {
    mockParams.pluginRoutePath = "wiki";
    mockPluginsApi.listUiContributions.mockResolvedValue([
      pageContribution({
        slots: [
          {
            type: "page",
            id: "wiki-page",
            displayName: "Wiki",
            exportName: "WikiPage",
            routePath: "wiki",
          },
          {
            type: "routeSidebar",
            id: "wiki-sidebar",
            displayName: "Wiki Sidebar",
            exportName: "WikiRouteSidebar",
            routePath: "wiki",
          },
        ],
      }),
    ]);

    const root = await renderPage(container);

    expect(mockSetBreadcrumbs).toHaveBeenCalledWith([{ label: "Wiki" }]);
    expect(container.textContent).not.toContain("Back");
    expect(container.querySelector('a[href="/PAP/dashboard"]')).toBeNull();
    // Page slot itself still renders.
    expect(container.querySelector('[data-testid="plugin-slot-mount"]')?.textContent).toBe("Wiki");

    root.unmount();
    await flushReact();
  });

  it("hides the host Back and settings buttons for the Briefs dashboard", async () => {
    mockParams.pluginRoutePath = "briefs";
    mockPluginsApi.listUiContributions.mockResolvedValue([
      pageContribution({
        pluginId: "plugin-briefs",
        pluginKey: "paperclipai.plugin-briefs",
        displayName: "Briefs",
        slots: [
          {
            type: "page",
            id: "briefs-page",
            displayName: "Briefs",
            exportName: "BriefingPage",
            routePath: "briefs",
          },
        ],
      }),
    ]);

    const root = await renderPage(container);

    expect(container.textContent).not.toContain("Back");
    expect(container.querySelector('a[href="/PAP/dashboard"]')).toBeNull();
    expect(container.querySelector('a[href="/instance/settings/plugins/plugin-briefs"]')).toBeNull();

    root.unmount();
    await flushReact();
  });

  it("uses the selected plugin page path as the route-sidebar title", async () => {
    mockParams.pluginRoutePath = "wiki";
    mockParams["*"] = "page/templates%3A%3Aindex.md";
    mockPluginsApi.listUiContributions.mockResolvedValue([
      pageContribution({
        slots: [
          {
            type: "page",
            id: "wiki-page",
            displayName: "Wiki",
            exportName: "WikiPage",
            routePath: "wiki",
          },
          {
            type: "routeSidebar",
            id: "wiki-sidebar",
            displayName: "Wiki Sidebar",
            exportName: "WikiRouteSidebar",
            routePath: "wiki",
          },
        ],
      }),
    ]);

    const root = await renderPage(container);

    expect(mockSetBreadcrumbs).toHaveBeenCalledWith([{ label: "index" }]);

    root.unmount();
    await flushReact();
  });
});
