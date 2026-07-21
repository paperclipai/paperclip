// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanySettingsPluginPage } from "./CompanySettingsPluginPage";

const mockSetBreadcrumbs = vi.hoisted(() => vi.fn());
const mockUsePluginSlots = vi.hoisted(() => vi.fn());
const mockParams = vi.hoisted(() => ({
  companyPrefix: "PAP" as string | undefined,
  settingsRoutePath: "permissions" as string | undefined,
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
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => <a href={to}>{children}</a>,
  useLocation: () => ({ pathname: "/PAP/company/settings/permissions", search: "", hash: "" }),
  useParams: () => mockParams,
}));

vi.mock("@/plugins/slots", () => ({
  usePluginSlots: mockUsePluginSlots,
  PluginSlotMount: ({
    slot,
    context,
  }: {
    slot: { displayName: string };
    context: { companyId: string | null; companyPrefix: string | null };
  }) => (
    <div data-testid="plugin-slot-mount">
      {slot.displayName}:{context.companyId}:{context.companyPrefix}
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

async function renderPage(container: HTMLDivElement) {
  const root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <CompanySettingsPluginPage />
      </QueryClientProvider>,
    );
  });
  await flushReact();
  return root;
}

describe("CompanySettingsPluginPage", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockParams.companyPrefix = "PAP";
    mockParams.settingsRoutePath = "permissions";
    mockUsePluginSlots.mockReturnValue({
      slots: [
        {
          type: "companySettingsPage",
          id: "permissions",
          displayName: "Permissions",
          exportName: "PermissionsPage",
          routePath: "permissions",
          pluginId: "plugin-1",
          pluginKey: "permissions-extension",
          pluginDisplayName: "Permissions Extension",
          pluginVersion: "0.1.0",
        },
      ],
      isLoading: false,
      errorMessage: null,
    });
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("mounts the matching company settings slot with company context", async () => {
    const root = await renderPage(container);

    expect(container.querySelector('[data-testid="plugin-slot-mount"]')?.textContent).toBe(
      "Permissions:company-1:PAP",
    );
    expect(mockSetBreadcrumbs).toHaveBeenCalledWith([
      { label: "Settings", href: "/company/settings" },
      { label: "Permissions" },
    ]);

    await act(async () => {
      root.unmount();
    });
  });

  it("fails closed when no ready plugin declares the route", async () => {
    mockUsePluginSlots.mockReturnValue({
      slots: [],
      isLoading: false,
      errorMessage: null,
    });
    const root = await renderPage(container);

    expect(container.textContent).toContain("Page not found");

    await act(async () => {
      root.unmount();
    });
  });
});
