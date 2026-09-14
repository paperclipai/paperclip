// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import type { RuntimeService } from "@paperclipai/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client";
import { newestService, publishRuntimeService, serviceKeys } from "../hooks/useRuntimeServices";
import { RuntimeServiceControls, RuntimeServicePolicyEditor } from "./RuntimeServiceControls";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({ control: vi.fn(), logs: vi.fn(), updatePolicy: vi.fn() }));
vi.mock("../api/runtime-services", () => ({ runtimeServicesApi: api }));
vi.mock("../lib/router", () => ({
  Link: ({ to, children, ...props }: ComponentProps<"a"> & { to: string }) => <a href={to} {...props}>{children}</a>,
}));

const initial: RuntimeService = {
  id: "service-1", companyId: "company-1", name: "React preview", purpose: "preview", provider: "local",
  issueId: "task-1", startedByRunId: "run-1", createdByAgentId: "agent-1", executionWorkspaceId: null,
  allocationId: "allocation-1", retention: { state: "retained", error: null, compute: "stopped" },
  state: "stopped", desiredState: "stopped", revision: 1,
  policy: { idleSeconds: 3600, maxRunningSeconds: null, keepRunningUntil: null, restartAttempts: 3, readinessTimeoutSeconds: 60 },
  endpoints: [], lastActivityAt: "2026-09-12T00:00:00Z", startedAt: null, stoppedAt: "2026-09-12T00:00:00Z",
  restartCount: 0, error: null, stopReason: "manual", detailPath: "/runtime-services/service-1",
  createdAt: "2026-09-12T00:00:00Z", updatedAt: "2026-09-12T00:00:00Z",
};
const running: RuntimeService = { ...initial, revision: 3, state: "ready", desiredState: "running", endpoints: [{ name: "web", port: 4000, url: "https://preview.example.test/", health: "ready", status: "ready", error: null, verifiedAt: "2026-09-12T00:00:00Z" }] };
let root: Root | undefined;
let node: HTMLDivElement;
let client: QueryClient;

async function mount(options: { service?: RuntimeService; canManage?: boolean; copies?: number; policy?: boolean; compact?: boolean } = {}) {
  node = document.createElement("div"); document.body.appendChild(node);
  root = createRoot(node);
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
  function Surface() {
    const { data } = useQuery({ queryKey: serviceKeys.detail(initial.companyId, initial.id), queryFn: async () => initial, initialData: options.service ?? initial, enabled: false });
    return <>{Array.from({ length: options.copies ?? 1 }, (_, index) => <RuntimeServiceControls key={index} service={data} canManage={options.canManage ?? true} compact={options.compact} />)}{options.policy && <RuntimeServicePolicyEditor service={data} />}</>;
  }
  await act(async () => { root!.render(<QueryClientProvider client={client}><Surface /></QueryClientProvider>); });
}
function button(text: string, index = 0) { return Array.from(node.querySelectorAll("button")).filter((item) => item.textContent === text)[index]!; }
async function click(text: string, index = 0) { await act(async () => { button(text, index).click(); }); }
async function settle() { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); }); }
afterEach(async () => { await act(async () => { root?.unmount(); }); node?.remove(); client?.clear(); vi.clearAllMocks(); });

describe("runtime service controls under failures and concurrent use", () => {
  it("keeps task controls compact and exposes keyboard-accessible logs without granting viewer mutations", async () => {
    api.logs.mockResolvedValueOnce({ text: "Application started\n" });
    await mount({ canManage: false, service: running, compact: true });
    expect(node.querySelector('a[target="_blank"]')?.getAttribute("href")).toBe("https://preview.example.test/");
    expect(button("Restart")).toBeUndefined();
    expect(button("Stop")).toBeUndefined();
    const trigger = node.querySelector<HTMLButtonElement>('button[aria-label="More actions for React preview"]')!;
    await act(async () => { trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    await settle();
    const items = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'));
    expect(items.map((item) => item.textContent)).not.toContain("Restart");
    expect(items.map((item) => item.textContent)).toContain("Copy web URL");
    await act(async () => { items.find((item) => item.textContent === "Logs")!.click(); });
    await settle();
    expect(node.querySelector("pre")?.textContent).toContain("Application started");
    expect(button("Hide logs").getAttribute("aria-expanded")).toBe("true");
    expect(api.control).not.toHaveBeenCalled();
  });

  it("keeps deletion progress independently of service revisions and hides obsolete controls", async () => {
    const pending = { id: "deletion", state: "pending" as const, attempts: 0, error: null, requestedAt: "2026-09-13T00:00:00.000Z", updatedAt: "2026-09-13T00:00:00.000Z", completedAt: null, retryAt: null };
    const complete = { ...pending, state: "deleted" as const, attempts: 1, updatedAt: "2026-09-13T00:00:01.000Z", completedAt: "2026-09-13T00:00:01.000Z" };
    const current = { ...running, dataDeletion: complete };
    expect(newestService(current, { ...running, revision: 4, dataDeletion: pending })).toMatchObject({ revision: 4, dataDeletion: complete });
    expect(newestService(current, running).dataDeletion).toEqual(complete);
    expect(newestService({ ...running, dataDeletion: pending }, current).dataDeletion).toEqual(complete);
    await mount({ service: current });
    expect(node.textContent).toContain("Data deleted");
    expect(button("Start")).toBeUndefined(); expect(button("Stop")).toBeUndefined(); expect(button("Restart")).toBeUndefined();
    expect(node.querySelector('a[target="_blank"]')).toBeNull();
    expect(node.textContent).not.toContain("Sleeps after"); expect(button("Logs")).toBeDefined();
  });

  it.each([1, 30, 90])("can edit a saved %s-second lifetime without changing its duration", async (seconds) => {
    await mount({ service: { ...initial, policy: { ...initial.policy, idleSeconds: seconds, maxRunningSeconds: seconds } }, policy: true });
    await click("Edit lifetime");
    const inputs = Array.from(node.querySelectorAll<HTMLInputElement>('input[type="number"]'));
    expect(inputs).toHaveLength(2);
    expect(inputs.every((input) => input.checkValidity())).toBe(true);
    api.updatePolicy.mockResolvedValueOnce({ ...initial, revision: 2 });
    await click("Save lifetime"); await settle();
    expect(api.updatePolicy.mock.calls[0]![2]).toMatchObject({ policy: { idleSeconds: seconds, maxRunningSeconds: seconds } });
  });

  it("explains the handoff and keeps Stop available until the original command has exited", async () => {
    await mount({ service: { ...initial, state: "pending", desiredState: "running", handoff: { mode: "relaunch", phase: "pending" } } });
    expect(node.textContent).toContain("Moving the existing command to service supervision");
    expect(button("Stop").disabled).toBe(false);
    expect(node.querySelector('a[target="_blank"]')).toBeNull();
    await act(async () => { publishRuntimeService(client, { ...initial, revision: 2, state: "starting", desiredState: "running", handoff: { mode: "relaunch", phase: "stopped" } }); });
    await settle();
    expect(node.textContent).toContain("The original command is stopped");
    await act(async () => { publishRuntimeService(client, { ...running, handoff: { mode: "relaunch", phase: "complete" } }); });
    await settle();
    expect(node.textContent).not.toContain("Moving the existing command");
    expect(node.querySelector('a[target="_blank"]')?.getAttribute("href")).toBe("https://preview.example.test/");
  });

  it("merges service and company revisions independently so stale polls cannot restore a removed cap", () => {
    const capped = { ...initial, companyPolicyRevision: 3, companyMaxRunningSeconds: 60 };
    const oldCompany = { ...running, companyPolicyRevision: 2, companyMaxRunningSeconds: 120 };
    expect(newestService(capped, oldCompany)).toMatchObject({ revision: 3, state: "ready", companyPolicyRevision: 3, effectivePolicy: { maxRunningSeconds: 60 } });
    const uncapped = { ...initial, companyPolicyRevision: 4, companyMaxRunningSeconds: null };
    expect(newestService(oldCompany, uncapped)).toMatchObject({ revision: 3, state: "ready", companyPolicyRevision: 4, effectivePolicy: { maxRunningSeconds: null } });
  });

  it("shows the effective company ceiling and why an operator's lowered limit stopped a service", async () => {
    await mount({ service: { ...initial, policy: { ...initial.policy, idleSeconds: null }, effectivePolicy: { ...initial.policy, idleSeconds: null, maxRunningSeconds: 30 }, companyMaxRunningSeconds: 30, stopReason: "company_running_limit" } });
    expect(node.textContent).toContain("Maximum 30 seconds per start");
    expect(node.textContent).toContain("Set by company policy");
    expect(node.textContent).toContain("Stopped because the company running-service limit was lowered");
    expect(node.textContent).not.toContain("Runs until stopped");
  });

  it("lets an operator stop a failed start so its allocation no longer requests running compute", async () => {
    api.control.mockResolvedValueOnce({ ...initial, state: "stopping", revision: 4 });
    await mount({ service: { ...running, state: "failed", error: "Allocation unavailable" } });
    expect(button("Start").disabled).toBe(false);
    expect(button("Stop").disabled).toBe(false);
    await click("Stop"); await settle();
    expect(api.control.mock.calls[0]![2]).toMatchObject({ action: "stop", expectedRevision: running.revision });
  });

  it("offers Retry stop when termination failed after a company-enforced stop", async () => {
    api.control.mockResolvedValueOnce({ ...initial, state: "stopping", revision: 4 });
    await mount({ service: { ...initial, state: "failed", stopReason: "company_maximum_lifetime", error: "Stop could not be confirmed" } });
    expect(button("Retry stop").disabled).toBe(false);
    await click("Retry stop"); await settle();
    expect(api.control.mock.calls[0]![2]).toMatchObject({ action: "stop", expectedRevision: initial.revision });
  });

  it("shows request feedback immediately, suppresses duplicate clicks across surfaces, and waits for readiness", async () => {
    let accept!: (value: RuntimeService) => void;
    api.control.mockImplementationOnce(() => new Promise((resolve) => { accept = resolve; }));
    await mount({ copies: 2 });
    await act(async () => { button("Start").click(); button("Start", 1).click(); });
    await settle();
    expect(api.control).toHaveBeenCalledTimes(1);
    expect(node.textContent).toContain("Requesting start…");
    expect(button("Start").disabled).toBe(true);
    expect(button("Start", 1).disabled).toBe(true);
    await act(async () => { accept({ ...initial, revision: 2, desiredState: "running", state: "pending" }); });
    await settle();
    expect(node.textContent).toContain("Start queued");
    expect(node.querySelector('a[target="_blank"]')).toBeNull();
    await act(async () => { publishRuntimeService(client, running); });
    await settle();
    expect(node.textContent).toContain("Running");
    expect(node.querySelector('a[target="_blank"]')?.getAttribute("href")).toBe("https://preview.example.test/");
    expect(button("Stop").disabled).toBe(false);
  });

  it("keeps the last authoritative state and refreshes after a stale revision rejection", async () => {
    const invalidate = vi.spyOn(QueryClient.prototype, "invalidateQueries");
    api.control.mockRejectedValueOnce(new ApiError("Service changed; refresh before retrying", 409, {}));
    await mount({ service: running });
    await click("Stop"); await settle();
    expect(node.textContent).toContain("Service changed; refresh before retrying");
    expect(node.textContent).toContain("Running");
    expect(node.textContent).not.toContain("Stopped");
    expect(invalidate).toHaveBeenCalledWith({ queryKey: serviceKeys.company(initial.companyId) });
    invalidate.mockRestore();
  });

  it("retries the identical request after a lost response", async () => {
    api.control.mockRejectedValueOnce(new TypeError("Network failed")).mockResolvedValueOnce({ ...initial, revision: 2, state: "pending", desiredState: "running" });
    await mount();
    await click("Start"); await settle();
    expect(node.textContent).toContain("Checking the service’s current state");
    const original = api.control.mock.calls[0]![2];
    await click("Retry same request"); await settle();
    expect(api.control.mock.calls[1]![2]).toEqual(original);
    expect(node.textContent).toContain("Start queued");
  });

  it("shows exposure failure separately, fetches logs only on demand, and leaves viewer controls read-only", async () => {
    api.logs.mockResolvedValueOnce({ text: "Application started\n" });
    await mount({ canManage: false, service: { ...running, endpoints: [{ ...running.endpoints[0]!, url: null, status: "failed", error: "Preview is unavailable" }] } });
    expect(api.logs).not.toHaveBeenCalled();
    expect(button("Stop")).toBeUndefined();
    expect(button("Start")).toBeUndefined();
    expect(node.textContent).toContain("Running");
    expect(node.textContent).toContain("Preview is unavailable");
    expect(node.querySelector('a[target="_blank"]')).toBeNull();
    await click("Logs"); await settle();
    expect(api.logs).toHaveBeenCalledOnce();
    expect(node.querySelector("pre")?.textContent).toContain("Application started");
    expect(button("Hide logs").getAttribute("aria-expanded")).toBe("true");
    expect(node.querySelector("pre")?.tabIndex).toBe(0);
  });

  it("keeps an open lifetime edit bound to the policy and revision the user actually edited", async () => {
    api.updatePolicy.mockRejectedValueOnce(new ApiError("Service changed; refresh before retrying", 409, {}));
    await mount({ policy: true });
    await click("Edit lifetime");
    await act(async () => { publishRuntimeService(client, { ...initial, revision: 2, policy: { ...initial.policy, idleSeconds: 7200 } }); });
    await settle();
    await click("Save lifetime"); await settle();
    expect(api.updatePolicy.mock.calls[0]![2]).toMatchObject({ expectedRevision: 1, expectedPolicy: initial.policy, policy: { idleSeconds: 3600 } });
    expect(node.textContent).toContain("Service changed");
    await click("Load current lifetime");
    expect(node.querySelector<HTMLInputElement>('input[type="number"]')?.value).toBe("120");
  });

  it("preserves a keep-running deadline through uncertain saves and lets the user clear it after recovery", async () => {
    const until = new Date(Date.now() + 7200_123).toISOString();
    const held = { ...initial, policy: { ...initial.policy, keepRunningUntil: until } };
    api.updatePolicy.mockRejectedValueOnce(new TypeError("Response lost"))
      .mockResolvedValueOnce({ ...held, revision: 2 })
      .mockResolvedValueOnce({ ...initial, revision: 3 });
    await mount({ policy: true, service: held });
    await click("Edit lifetime");
    expect(node.textContent).toContain("Idle sleep paused until");
    expect(node.textContent).toContain("Maximum running time and Stop still apply");
    await click("Save lifetime"); await settle();
    expect(api.updatePolicy.mock.calls[0]![2].policy.keepRunningUntil).toBe(until);
    expect(node.querySelector("fieldset")?.disabled).toBe(true);
    await click("Retry same request"); await settle();
    expect(api.updatePolicy.mock.calls[1]![2]).toEqual(api.updatePolicy.mock.calls[0]![2]);
    expect(node.querySelector("fieldset")?.disabled).toBe(false);
    const input = node.querySelector<HTMLInputElement>('input[type="datetime-local"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click("Save lifetime"); await settle();
    expect(api.updatePolicy.mock.calls[2]![2]).toMatchObject({ expectedRevision: 2, policy: { keepRunningUntil: null } });
    expect(node.textContent).not.toContain("Idle sleep paused until");
  });

  it("never lets a stale poll replace a newer action, including in cached task lists", async () => {
    await mount();
    client.setQueryData(serviceKeys.list(initial.companyId, initial.issueId!), [running]);
    publishRuntimeService(client, running);
    publishRuntimeService(client, { ...initial, revision: 2 });
    expect(client.getQueryData<RuntimeService>(serviceKeys.detail(initial.companyId, initial.id))?.revision).toBe(3);
    expect(client.getQueryData<RuntimeService[]>(serviceKeys.list(initial.companyId, initial.issueId!))?.[0]?.revision).toBe(3);
    expect(newestService(running, initial)).toBe(running);
    expect(newestService(running, { ...initial, companyId: "company-2" }).companyId).toBe("company-2");
  });
});
