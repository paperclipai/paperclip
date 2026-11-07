// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import { queryKeys } from "../lib/queryKeys";
import { PluginSettings } from "./PluginSettings";

const state = vi.hoisted(() => ({ companyId: "company-1", pluginId: "plugin-1" }));
const api = vi.hoisted(() => ({ get: vi.fn(), dashboard: vi.fn(), getConfig: vi.fn(), saveConfig: vi.fn() }));
const setBreadcrumbs = vi.hoisted(() => vi.fn());
vi.mock("@/api/plugins", () => ({ pluginsApi: api }));
vi.mock("@/context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs }) }));
vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompany: { id: state.companyId, name: "Paperclip", issuePrefix: "PAP" },
    selectedCompanyId: state.companyId,
  }),
}));
vi.mock("@/lib/router", () => ({
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => <a href={to}>{children}</a>,
  Navigate: () => null,
  useParams: () => ({ companyPrefix: "PAP", pluginId: state.pluginId }),
}));
vi.mock("@/plugins/slots", () => ({ PluginSlotMount: () => null, usePluginSlots: () => ({ slots: [] }) }));
vi.mock("@/components/PageTabBar", () => ({ PageTabBar: () => null }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

it.each(["company", "plugin"])("keeps a pending save scoped to its original %s", async (selection) => {
  state.companyId = "company-1";
  state.pluginId = "plugin-1";
  const manifestJson = {
    displayName: "Defaults",
    instanceConfigSchema: { type: "object", properties: { label: { type: "string", default: "Default" } } },
  };
  api.get.mockImplementation(async (id: string) => ({ id, packageName: "defaults", status: "error", categories: [], manifestJson }));
  api.dashboard.mockResolvedValue(null);
  api.getConfig.mockResolvedValue(null);
  const saved = { configJson: { label: "Default" } };
  let finishSave!: (value: typeof saved) => void;
  api.saveConfig.mockImplementation(() => new Promise((resolve) => { finishSave = resolve; }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(queryKeys.instance.experimentalSettings, {});
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const render = async () => {
    await act(async () => { root.render(<QueryClientProvider client={client}><PluginSettings /></QueryClientProvider>); });
    await flushReact();
    await flushReact();
  };
  const saveButton = () => Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Save Configuration")!;
  try {
    await render();
    expect(saveButton().disabled).toBe(false);
    await act(async () => { saveButton().click(); });
    expect(api.saveConfig).toHaveBeenCalledExactlyOnceWith("plugin-1", "company-1", { label: "Default" });
    if (selection === "company") state.companyId = "company-2";
    else state.pluginId = "plugin-2";
    await render();
    api.getConfig.mockImplementation(() => new Promise(() => {}));
    await act(async () => { finishSave(saved); });
    await flushReact();
    await flushReact();
    expect(client.getQueryData(queryKeys.plugins.config(state.pluginId, state.companyId))).toBeNull();
    expect(client.getQueryData(queryKeys.plugins.config("plugin-1", "company-1"))).toEqual(saved);
    expect(saveButton().disabled).toBe(false);
    expect(container.querySelector("input")?.value).toBe("Default");
  } finally {
    await act(async () => { root.unmount(); });
    client.clear();
    container.remove();
    vi.clearAllMocks();
  }
});
