// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import { queryKeys } from "../lib/queryKeys";
import { PluginSettings } from "./PluginSettings";

const api = vi.hoisted(() => ({
  get: vi.fn(),
  dashboard: vi.fn(),
  getConfig: vi.fn(),
  saveConfig: vi.fn(),
}));
const setBreadcrumbs = vi.hoisted(() => vi.fn());

vi.mock("@/api/plugins", () => ({ pluginsApi: api }));
vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs }),
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
vi.mock("@/components/PageTabBar", () => ({ PageTabBar: () => null }));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

it("keeps unchanged defaults unsaveable after persistence while config refetch is pending", async () => {
  const saved = { configJson: { label: "Default" } };
  let finishRefetch!: (value: typeof saved) => void;
  api.get.mockResolvedValue({
    id: "plugin-1",
    packageName: "default-plugin",
    status: "error",
    categories: [],
    manifestJson: {
      displayName: "Default configuration",
      instanceConfigSchema: {
        type: "object",
        properties: { label: { type: "string", default: "Default" } },
      },
    },
  });
  api.dashboard.mockResolvedValue(null);
  api.getConfig.mockResolvedValueOnce(null).mockImplementation(
    () => new Promise<typeof saved>((resolve) => { finishRefetch = resolve; }),
  );
  api.saveConfig.mockResolvedValue(saved);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(queryKeys.instance.experimentalSettings, {});
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(<QueryClientProvider client={client}><PluginSettings /></QueryClientProvider>);
    });
    await flushReact();
    await flushReact();
    const button = Array.from(container.querySelectorAll("button")).find(
      (item) => item.textContent === "Save Configuration",
    )!;
    expect(button).toBeDefined();
    expect(button.disabled).toBe(false);
    await act(async () => { button.click(); });
    await flushReact();
    await flushReact();
    expect(api.saveConfig).toHaveBeenCalledExactlyOnceWith("plugin-1", "company-1", { label: "Default" });
    expect(api.getConfig).toHaveBeenCalledTimes(2);
    expect(client.getQueryState(queryKeys.plugins.config("plugin-1", "company-1"))?.fetchStatus).toBe("fetching");
    expect(container.textContent).toContain("Configuration saved.");
    expect(button.disabled, "Persisted unchanged defaults must stay disabled during refetch").toBe(true);
  } finally {
    await act(async () => {
      finishRefetch?.(saved);
      root.unmount();
    });
    client.clear();
    container.remove();
    vi.clearAllMocks();
  }
});
