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

const { get, cancel } = vi.hoisted(() => ({ get: vi.fn(), cancel: vi.fn() }));
vi.mock("../api/heartbeats", () => ({ heartbeatsApi: { get, cancel, events: async () => [], workspaceOperations: async () => [] } }));
vi.mock("../api/client", () => ({ api: { get: async () => [] } }));
vi.mock("../api/access", () => ({ accessApi: { getCurrentBoardAccess: async () => ({ companyIds: ["company-1"], memberships: [] }) } }));
vi.mock("../context/SidebarContext", () => ({ useSidebar: () => ({ isMobile: false }) }));
vi.mock("../context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company-1", selectedCompany: { id: "company-1", issuePrefix: "TEST" }, companies: [] }) }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => { get.mockReset(); cancel.mockReset(); });

const states = [
  { status: "failed", eligibility: true, label: "Stop" },
  { status: "failed", eligibility: false, label: null },
  { status: "failed", eligibility: undefined, label: null },
  { status: "succeeded", eligibility: false, label: null },
  { status: "cancelled", eligibility: false, label: null },
  { status: "succeeded", eligibility: true, label: null },
  { status: "cancelled", eligibility: true, label: null },
  { status: "running", eligibility: undefined, label: "Cancel" },
  { status: "queued", eligibility: undefined, label: "Cancel" },
  { status: "failed", eligibility: true, label: "Stop", denial: true },
];
it.each([RunsTab, ProductionRunsTab].flatMap(Tab => states.map(state => ({ Tab, ...state }))))("renders and submits only eligible run cancellation (%#)", async ({ Tab, status, eligibility, label, ...state }) => {
  const run = { id: "failed-native-run", companyId: "company-1", agentId: "agent-1", status, invocationSource: "manual",
    createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", usageJson: null, resultJson: null,
    contextSnapshot: null, exitCode: 1, error: "Runner ingress unavailable", logRef: null, startedAt: null, finishedAt: null,
    execution: { canStop: eligibility, phase: "reconnecting", label: "Reconnecting", recoveryOwner: "agent", retryAt: "2026-01-01T00:00:01Z" },
  } as unknown as HeartbeatRun;
  get.mockResolvedValue(run);
  cancel.mockImplementation(async () => {
    if (state.denial) throw new Error("Native retry changed; Stop was not accepted");
    const stopped = { ...run, status: "cancelled", execution: { ...run.execution, canStop: false } };
    get.mockResolvedValue(stopped);
    return stopped;
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const element = document.createElement("div"); document.body.append(element);
  const root = createRoot(element);
  try {
    await act(async () => root.render(<QueryClientProvider client={client}><MemoryRouter><PanelProvider><ToastProvider>
      <Tab runs={[]} companyId="company-1" agentId="agent-1" agentRouteId="agent-1" selectedRunId="failed-native-run" adapterType="paperclip_runner" adapterConfig={{}} />
    </ToastProvider></PanelProvider></MemoryRouter></QueryClientProvider>));
    await vi.waitFor(async () => { await act(async () => {}); expect(element.textContent).toContain(status); });
    const control = () => Array.from(element.querySelectorAll("button")).find(candidate => ["Stop", "Cancel"].includes(candidate.textContent ?? ""));
    if (label) {
      expect(control()?.textContent).toBe(label);
      await act(async () => control()!.click());
      await vi.waitFor(() => expect(cancel).toHaveBeenCalledExactlyOnceWith("failed-native-run"));
      await vi.waitFor(async () => {
        await act(async () => {});
        if (state.denial) {
          expect(element.querySelector('[role="alert"]')?.textContent).toContain("Stop was not accepted");
          expect(control()?.textContent).toBe(label);
        } else {
          expect(control()).toBeUndefined();
          expect(element.textContent).toContain("cancelled");
        }
      });
    } else {
      expect(control()).toBeUndefined();
      expect(cancel).not.toHaveBeenCalled();
    }
  } finally { await act(async () => root.unmount()); client.clear(); element.remove(); }
});
