// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import type { HeartbeatRun } from "@paperclipai/shared";
import { afterEach, expect, it, vi } from "vitest";
import { RunsTab } from "./AgentDetail";
import { RunsTab as ProductionRunsTab } from "./AgentDetail.production";
import { ToastProvider } from "../context/ToastContext";
import { PanelProvider } from "../context/PanelContext";

const { get, mobile } = vi.hoisted(() => ({ get: vi.fn(), mobile: { value: false } }));
vi.mock("../api/heartbeats", () => ({ heartbeatsApi: { get, events: async () => [], workspaceOperations: async () => [] } }));
vi.mock("../api/client", () => ({ api: { get: async () => [] } }));
vi.mock("../api/access", () => ({ accessApi: { getCurrentBoardAccess: async () => ({ companyIds: ["company-1"], memberships: [] }) } }));
vi.mock("../context/SidebarContext", () => ({ useSidebar: () => ({ isMobile: mobile.value }) }));
vi.mock("../context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company-1", selectedCompany: { id: "company-1", issuePrefix: "TEST" }, companies: [] }) }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => { get.mockReset(); });

it.each([
  { Tab: RunsTab, isMobile: false }, { Tab: ProductionRunsTab, isMobile: false },
  { Tab: RunsTab, isMobile: true }, { Tab: ProductionRunsTab, isMobile: true },
])("renders an older selected run when history is empty (%#)", async ({ Tab, isMobile }) => {
  mobile.value = isMobile;
  const run = { id: "older-run", companyId: "company-1", agentId: "agent-1", status: "succeeded", invocationSource: "manual",
    createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", usageJson: null, resultJson: null,
    contextSnapshot: null, exitCode: 0, error: null, logRef: null, startedAt: null, finishedAt: null } as unknown as HeartbeatRun;
  get.mockResolvedValue(run);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const element = document.createElement("div"); document.body.append(element);
  const root = createRoot(element);
  try {
    await act(async () => root.render(<QueryClientProvider client={client}><MemoryRouter><PanelProvider><ToastProvider>
      <Tab runs={[]} companyId="company-1" agentId="agent-1" agentRouteId="agent-1" selectedRunId="older-run" adapterType="codex_local" adapterConfig={{}} />
    </ToastProvider></PanelProvider></MemoryRouter></QueryClientProvider>));
    await vi.waitFor(async () => { await act(async () => {}); expect(element.textContent).toContain("succeeded"); });
    expect(element.textContent).not.toContain("No runs yet.");
    expect(get).toHaveBeenCalledWith("older-run");
  } finally { await act(async () => root.unmount()); client.clear(); element.remove(); }
});
