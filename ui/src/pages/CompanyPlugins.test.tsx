// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanyPlugins } from "./CompanyPlugins";
import { ApiError } from "@/api/client";
import type { CompanyPluginCatalogItem } from "@/api/plugins";
import { queryKeys } from "@/lib/queryKeys";

const listCompanyPluginCatalogMock = vi.hoisted(() => vi.fn());
const setCompanyPluginEnabledMock = vi.hoisted(() => vi.fn());
const pushToastMock = vi.hoisted(() => vi.fn());
const setBreadcrumbsMock = vi.hoisted(() => vi.fn());

vi.mock("@/api/plugins", () => ({
  pluginsApi: {
    listCompanyPluginCatalog: (companyId: string) => listCompanyPluginCatalogMock(companyId),
    setCompanyPluginEnabled: (pluginId: string, companyId: string, enabled: boolean) =>
      setCompanyPluginEnabledMock(pluginId, companyId, enabled),
  },
}));

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
    selectedCompany: { id: "company-1", name: "Paperclip", issuePrefix: "PAP" },
  }),
}));

vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: setBreadcrumbsMock }),
}));

vi.mock("@/context/ToastContext", () => ({
  useToastActions: () => ({ pushToast: pushToastMock }),
}));

vi.mock("@/lib/router", () => ({
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => <a href={to}>{children}</a>,
  Navigate: ({ to }: { to: string }) => <div data-testid="navigate" data-to={to} />,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

async function renderPage() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <CompanyPlugins />
      </QueryClientProvider>,
    );
  });
  await flushReact();
  return { container, root, queryClient };
}

function catalogItem(overrides: Partial<CompanyPluginCatalogItem> = {}): CompanyPluginCatalogItem {
  return {
    pluginId: "plugin-1",
    pluginKey: "linear-sync",
    displayName: "Linear Sync",
    version: "1.2.0",
    description: "Sync issues with Linear.",
    capabilities: ["issues.read"],
    enabled: true,
    locked: false,
    defaultEnabled: true,
    hasCompanySettingsPage: false,
    settingsRoutePath: null,
    ...overrides,
  };
}

describe("CompanyPlugins", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  beforeEach(() => {
    setCompanyPluginEnabledMock.mockResolvedValue(catalogItem());
  });

  it("renders one row per catalog item with displayName and version", async () => {
    listCompanyPluginCatalogMock.mockResolvedValue([
      catalogItem({ pluginId: "plugin-1", displayName: "Linear Sync", version: "1.2.0" }),
      catalogItem({ pluginId: "plugin-2", displayName: "Slack Bridge", version: "0.4.1" }),
    ]);

    const { container, root } = await renderPage();

    expect(listCompanyPluginCatalogMock).toHaveBeenCalledWith("company-1");
    expect(container.textContent).toContain("Linear Sync");
    expect(container.textContent).toContain("1.2.0");
    expect(container.textContent).toContain("Slack Bridge");
    expect(container.textContent).toContain("0.4.1");
    // Capability summary (spec §4.5)
    expect(container.textContent).toContain("issues.read");

    await act(async () => {
      root.unmount();
    });
  });

  it("toggles a plugin's enablement and refreshes catalog + ui contributions", async () => {
    const disabled = catalogItem({ pluginId: "plugin-1", displayName: "Linear Sync", enabled: false });
    listCompanyPluginCatalogMock.mockResolvedValueOnce([disabled]);
    listCompanyPluginCatalogMock.mockResolvedValueOnce([{ ...disabled, enabled: true }]);
    setCompanyPluginEnabledMock.mockResolvedValue({ ...disabled, enabled: true });

    const { container, root, queryClient } = await renderPage();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const enableButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Enable",
    );
    expect(enableButton).toBeTruthy();

    await act(async () => {
      enableButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
    await flushReact();

    expect(setCompanyPluginEnabledMock).toHaveBeenCalledWith("plugin-1", "company-1", true);
    expect(listCompanyPluginCatalogMock).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("Disable");
    expect(invalidateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: queryKeys.plugins.companyCatalog("company-1") }),
    );
    expect(invalidateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: queryKeys.plugins.uiContributions }),
    );

    await act(async () => {
      root.unmount();
    });
  });

  it("renders locked plugins as non-interactive, managed-by-instance rows", async () => {
    listCompanyPluginCatalogMock.mockResolvedValue([
      catalogItem({
        pluginId: "plugin-billing",
        displayName: "Billing",
        enabled: true,
        locked: true,
      }),
    ]);

    const { container, root } = await renderPage();

    expect(container.textContent).toContain("Managed by instance");
    const buttons = Array.from(container.querySelectorAll("button")).map(
      (button) => button.textContent?.trim(),
    );
    expect(buttons).not.toContain("Disable");
    expect(buttons).not.toContain("Enable");

    await act(async () => {
      root.unmount();
    });
  });

  it("renders a Settings link only for enabled plugins with a settingsRoutePath", async () => {
    listCompanyPluginCatalogMock.mockResolvedValue([
      catalogItem({
        pluginId: "plugin-1",
        displayName: "Linear Sync",
        enabled: true,
        hasCompanySettingsPage: true,
        settingsRoutePath: "linear-sync",
      }),
      catalogItem({
        pluginId: "plugin-2",
        displayName: "Slack Bridge",
        enabled: false,
        hasCompanySettingsPage: true,
        settingsRoutePath: "slack-bridge",
      }),
      catalogItem({
        pluginId: "plugin-3",
        displayName: "No Settings Plugin",
        enabled: true,
      }),
    ]);

    const { container, root } = await renderPage();

    const links = Array.from(container.querySelectorAll("a"));
    expect(links.some((link) => link.getAttribute("href") === "/company/settings/linear-sync")).toBe(true);
    expect(links.some((link) => link.getAttribute("href") === "/company/settings/slack-bridge")).toBe(false);
    expect(links.length).toBe(1);

    await act(async () => {
      root.unmount();
    });
  });

  it("treats a 403 catalog response as a navigation miss (redirect to settings root)", async () => {
    listCompanyPluginCatalogMock.mockRejectedValue(
      new ApiError("Forbidden", 403, { code: "surface_not_exposed" }),
    );

    const { container, root } = await renderPage();

    const navigate = container.querySelector('[data-testid="navigate"]');
    expect(navigate).not.toBeNull();
    expect(navigate?.getAttribute("data-to")).toBe("/company/settings");

    await act(async () => {
      root.unmount();
    });
  });

  it("renders an empty state mentioning that instance admins install plugins", async () => {
    listCompanyPluginCatalogMock.mockResolvedValue([]);

    const { container, root } = await renderPage();

    expect(container.textContent).toMatch(/instance admin/i);
    expect(container.textContent).toMatch(/install/i);

    await act(async () => {
      root.unmount();
    });
  });
});
