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

const { get, cancel, grokStop, actor } = vi.hoisted(() => ({ get: vi.fn(), cancel: vi.fn(), grokStop: vi.fn(), actor: { id: "operator-1" } }));
vi.mock("../api/heartbeats", async importOriginal => ({ heartbeatsApi: { ...(await importOriginal<typeof import("../api/heartbeats")>()).heartbeatsApi,
  get, events: async () => [], workspaceOperations: async () => [] } }));
vi.mock("../api/grokBot", () => ({ grokBotApi: { stop: grokStop } }));
vi.mock("../api/client", () => ({ api: { get: async () => [], post: cancel }, detachInflightGet: vi.fn() }));
vi.mock("../api/access", () => ({ accessApi: { getCurrentBoardAccess: async () => ({ userId: actor.id, source: "authenticated", companyIds: ["company-1"], memberships: [] }) } }));
vi.mock("../context/SidebarContext", () => ({ useSidebar: () => ({ isMobile: false }) }));
vi.mock("../context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company-1", selectedCompany: { id: "company-1", issuePrefix: "TEST" }, companies: [] }) }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => { get.mockReset(); cancel.mockReset(); grokStop.mockReset(); actor.id = "operator-1"; sessionStorage.clear(); vi.unstubAllGlobals(); });

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
  { status: "failed", eligibility: true, label: "Stop", unchanged: true },
  { status: "failed", eligibility: true, label: "Stop", pending: true },
  { status: "failed", eligibility: true, label: "Stop", pending: true, wrongIntent: "run" },
  { status: "failed", eligibility: true, label: "Stop", pending: true, wrongIntent: "request" },
  { status: "failed", eligibility: true, label: "Stop", uncertain: true },
  { status: "failed", eligibility: true, label: "Stop", uncertain: true, remount: true },
  { status: "failed", eligibility: true, label: "Stop", uncertain: true, remount: true, canonical: true },
  { status: "failed", eligibility: true, label: "Stop", uncertain: true, remount: true, canonical: true, actorChanged: true },
  { status: "failed", eligibility: true, label: "Stop", uncertain: true, remount: true, canonical: true, wrongRun: true },
  { status: "failed", eligibility: true, label: "Stop", http: true },
  { status: "failed", eligibility: true, label: "Stop", existingClaim: true },
  { status: "failed", eligibility: true, label: null, driverKind: "grok_bot_mcp" },
  { status: "running", eligibility: undefined, label: "Cancel", driverKind: "grok_bot_mcp" },
  { status: "queued", eligibility: undefined, label: "Cancel", driverKind: "grok_bot_mcp" },
];
it.each([RunsTab, ProductionRunsTab].flatMap(Tab => states.map(state => ({ Tab, ...state }))))("renders and submits only eligible run cancellation (%#)", async ({ Tab, status, eligibility, label, ...state }) => {
  const run = { id: "failed-native-run", companyId: "company-1", agentId: "agent-1", issueId: "issue-1", status, driverKind: state.driverKind, invocationSource: "manual",
    createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", usageJson: null, resultJson: null,
    contextSnapshot: null, exitCode: 1, error: "Runner ingress unavailable", logRef: null, startedAt: null, finishedAt: null,
    execution: { canStop: eligibility, phase: "reconnecting", label: "Reconnecting", recoveryOwner: "agent", retryAt: "2026-01-01T00:00:01Z" },
  } as unknown as HeartbeatRun;
  const existingRequestId = "11111111-1111-4111-8111-111111111111";
  if (state.existingClaim) run.resultJson = { startupCancellation: { cancellationRequestId: existingRequestId,
    requestedBy: { type: "board", userId: "operator-1" } } };
  get.mockResolvedValue(run);
  if (state.http) vi.stubGlobal("crypto", { getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto) });
  cancel.mockImplementation(async (_path, body) => {
    if (state.denial) throw new Error("Native retry changed; Stop was not accepted");
    if (state.uncertain && cancel.mock.calls.length === 1) {
      if (state.canonical) get.mockResolvedValue({ ...run, resultJson: { startupCancellation: {
        cancellationRequestId: body.cancellationRequestId, requestedBy: { type: "board", userId: "operator-1" },
      } } });
      throw new Error("Stop outcome is unknown");
    }
    if (state.unchanged) {
      const unchanged = { ...run, execution: { ...run.execution, canStop: false } };
      get.mockResolvedValue(unchanged);
      return unchanged;
    }
    if (state.pending || state.uncertain) {
      const pending = { ...run, execution: { ...run.execution, canStop: false }, resultJson: { nativeCancellation: {
        schema: "paperclip.native-cancellation.v1", runId: state.wrongIntent === "run" ? "another-run" : run.id, companyId: run.companyId, issueId: run.issueId,
        intentId: `native-cancellation:${state.wrongIntent === "request" ? "another-request" : body.cancellationRequestId}`, scope: "run", dispatchState: "pending", dispatched: false, intentAuditId: "recorded-intent",
      } } };
      get.mockResolvedValue(pending);
      return pending;
    }
    const stopped = { ...run, status: "cancelled", execution: { ...run.execution, canStop: false } };
    get.mockResolvedValue(stopped);
    return stopped;
  });
  grokStop.mockImplementation(async () => {
    get.mockResolvedValue({ ...run, status: "cancelled", execution: { ...run.execution, canStop: false } });
    return { stopped: true, remoteTerminationConfirmed: false };
  });
  const usesGrokStop = Tab === RunsTab && state.driverKind === "grok_bot_mcp";
  const expectedLabel = label && usesGrokStop ? "Stop Paperclip work" : label;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const element = document.createElement("div"); document.body.append(element);
  let root = createRoot(element);
  const render = () => root.render(<QueryClientProvider client={client}><MemoryRouter><PanelProvider><ToastProvider>
    <Tab runs={[]} companyId="company-1" agentId="agent-1" agentRouteId="agent-1" selectedRunId="failed-native-run" adapterType="paperclip_runner" adapterConfig={{}} />
  </ToastProvider></PanelProvider></MemoryRouter></QueryClientProvider>);
  try {
    await act(async () => render());
    await vi.waitFor(async () => { await act(async () => {}); expect(element.textContent).toContain(status); });
    const control = () => Array.from(element.querySelectorAll("button")).find(candidate => ["Stop", "Cancel", "Stop Paperclip work"].includes(candidate.textContent ?? ""));
    if (label) {
      expect(control()?.textContent).toBe(expectedLabel);
      await act(async () => control()!.click());
      await vi.waitFor(() => usesGrokStop
        ? expect(grokStop).toHaveBeenCalledExactlyOnceWith("company-1", "agent-1", "failed-native-run")
        : expect(cancel).toHaveBeenCalledExactlyOnceWith("/heartbeat-runs/failed-native-run/cancel",
          status === "failed" ? { cancellationRequestId: expect.stringMatching(/^[a-f0-9-]{36}$/) } : {}));
      expect(usesGrokStop ? cancel : grokStop).not.toHaveBeenCalled();
      if (state.existingClaim) expect(cancel.mock.calls[0][1]).toEqual({ cancellationRequestId: existingRequestId });
      if (state.uncertain) {
        await vi.waitFor(async () => {
          await act(async () => {});
          expect(element.querySelector('[role="alert"]')?.textContent).toContain("Stop outcome is unknown");
          expect(control()?.textContent).toBe(expectedLabel);
        });
        const firstRequest = cancel.mock.calls[0][1];
        if (state.remount) {
          await act(async () => root.unmount());
          client.clear();
          if (state.canonical) sessionStorage.clear();
          if (state.actorChanged) actor.id = "operator-2";
          root = createRoot(element);
          await act(async () => render());
          await vi.waitFor(async () => { await act(async () => {}); expect(control()?.textContent).toBe(expectedLabel); });
          if (state.wrongRun) get.mockResolvedValue({ ...run, id: "another-run", resultJson: { startupCancellation: {
            cancellationRequestId: firstRequest.cancellationRequestId, requestedBy: { type: "board", userId: "operator-1" },
          } } });
        }
        await act(async () => control()!.click());
        if (state.actorChanged || state.wrongRun) {
          await vi.waitFor(async () => {
            await act(async () => {});
            expect(element.querySelector('[role="alert"]')?.textContent).toContain(state.actorChanged ? "another operator" : "unavailable for this agent");
          });
          expect(cancel).toHaveBeenCalledTimes(1);
          return;
        }
        await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(2));
        expect(cancel.mock.calls[1][1]).toEqual(firstRequest);
      }
      await vi.waitFor(async () => {
        await act(async () => {});
        if (state.denial || state.unchanged || state.wrongIntent) {
          expect(element.querySelector('[role="alert"]')?.textContent).toContain("Stop was not accepted");
          if (state.denial) expect(control()?.textContent).toBe(expectedLabel);
        } else {
          expect(control()).toBeUndefined();
          expect(element.textContent).toContain(state.pending || state.uncertain ? "failed" : "cancelled");
          expect(element.querySelector('[role="alert"]')).toBeNull();
        }
      });
    } else {
      expect(control()).toBeUndefined();
      expect(cancel).not.toHaveBeenCalled();
      expect(grokStop).not.toHaveBeenCalled();
    }
  } finally { await act(async () => root.unmount()); client.clear(); element.remove(); }
});
