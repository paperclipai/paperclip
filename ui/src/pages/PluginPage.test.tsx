import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PluginPage } from "./PluginPage";
import { pluginsApi } from "@/api/plugins";
import type { PluginUiContribution } from "@/api/plugins";

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    companies: [{ id: "c1", issuePrefix: "ACME", name: "Acme" }],
    selectedCompanyId: "c1",
  }),
}));

vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

const mockParams = { companyPrefix: "ACME", pluginId: "plug-1" };
vi.mock("@/lib/router", () => ({
  useParams: () => mockParams,
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => <a href={to}>{children}</a>,
  Navigate: ({ to, replace }: { to: string; replace?: boolean }) => (
    <div data-testid="navigate" data-to={to} data-replace={String(!!replace)} />
  ),
}));

vi.mock("@/api/plugins", () => ({
  pluginsApi: {
    listUiContributions: vi.fn(),
  },
}));

const mockPluginSlotMount = vi.hoisted(() =>
  vi.fn(({ slot }: { slot: { pluginId: string; type: string; displayName: string } }) => (
    <div data-testid="plugin-slot-mount">{slot.displayName}</div>
  ))
);
vi.mock("@/plugins/slots", () => ({
  PluginSlotMount: (props: { slot: { pluginId: string; type: string; displayName: string } }) =>
    mockPluginSlotMount(props),
}));

function renderWithClient(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>
  );
}

describe("PluginPage", () => {
  beforeEach(() => {
    vi.mocked(pluginsApi.listUiContributions).mockResolvedValue([]);
  });

  it("redirects to plugin settings when plugin has no page slot", async () => {
    vi.mocked(pluginsApi.listUiContributions).mockResolvedValue([
      {
        pluginId: "plug-1",
        pluginKey: "acme.test",
        displayName: "Test",
        version: "1.0.0",
        uiEntryFile: "index.js",
        slots: [{ type: "dashboardWidget", id: "w", displayName: "Widget", exportName: "W" }],
        launchers: [],
      } as PluginUiContribution,
    ]);

    renderWithClient(<PluginPage />);

    const navigate = await screen.findByTestId("navigate");
    expect(navigate.getAttribute("data-to")).toBe("/ACME/settings/plugins/plug-1");
    expect(navigate.getAttribute("data-replace")).toBe("true");
    expect(mockPluginSlotMount).not.toHaveBeenCalled();
  });

  it("renders plugin page slot when contribution has page type", async () => {
    vi.mocked(pluginsApi.listUiContributions).mockResolvedValue([
      {
        pluginId: "plug-1",
        pluginKey: "acme.test",
        displayName: "Test Plugin",
        version: "1.0.0",
        uiEntryFile: "index.js",
        slots: [
          {
            type: "page",
            id: "main",
            displayName: "Main",
            exportName: "PluginPage",
          },
        ],
        launchers: [],
      } as PluginUiContribution,
    ]);

    renderWithClient(<PluginPage />);

    await screen.findByTestId("plugin-slot-mount");
    expect(mockPluginSlotMount).toHaveBeenCalled();
    const call = mockPluginSlotMount.mock.calls[0][0];
    expect(call.slot).toBeDefined();
    expect(call.slot.pluginId).toBe("plug-1");
    expect(call.slot.type).toBe("page");
    expect(call.slot.displayName).toBe("Main");
  });
});
