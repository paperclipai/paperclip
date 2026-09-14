// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { RuntimeService, RuntimeServiceDataDeletionPlan } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client";
import { RuntimeServiceDataDeletion } from "./RuntimeServiceDataDeletion";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const api = vi.hoisted(() => ({ dataDeletionReview: vi.fn(), deleteData: vi.fn() }));
vi.mock("../api/runtime-services", () => ({ runtimeServicesApi: api }));
vi.mock("../hooks/useRuntimeServices", () => ({ serviceKeys: { detail: (company: string, id: string) => ["runtime-services", company, "detail", id], company: (company: string) => ["runtime-services", company] } }));
vi.mock("../lib/router", () => ({ Link: ({ to, children, ...props }: ComponentProps<"a"> & { to: string }) => <a href={to} {...props}>{children}</a> }));
const service = { id: "service", companyId: "company" } as RuntimeService;
const key = ["runtime-service-data-deletion", "company", "service"];
const initial: RuntimeServiceDataDeletionPlan = { allocationId: "allocation", provider: "daytona", planToken: "a".repeat(64), scope: "independent_allocation", blockers: [],
  services: [{ id: "service", name: "App", state: "stopped" }, { id: "peer", name: "Shared worker", state: "stopped" }], tasks: [], includesHostMirror: true, deletion: null };
const accepted: RuntimeServiceDataDeletionPlan = { ...initial, planToken: "b".repeat(64), deletion: { id: "deletion", state: "pending", attempts: 0, error: null,
  requestedAt: "2026-09-13T00:00:00.000Z", updatedAt: "2026-09-13T00:00:00.000Z", completedAt: null, retryAt: null } };
let root: Root, node: HTMLDivElement, client: QueryClient;
async function settle() { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); }); }
function button(label: string) { return [...node.querySelectorAll("button")].find((element) => element.textContent === label)!; }
async function mount(value = initial, canManage = true, current = service) {
  api.dataDeletionReview.mockResolvedValue(value);
  node = document.createElement("div"); document.body.appendChild(node); root = createRoot(node);
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
  await act(async () => root.render(<QueryClientProvider client={client}><RuntimeServiceDataDeletion service={current} canManage={canManage} /></QueryClientProvider>)); await settle();
}
async function review() { await act(async () => button("Review data deletion").click()); await settle(); }
async function confirm() { await act(async () => (node.querySelector('[role="checkbox"]') as HTMLButtonElement).click()); await settle(); }
beforeEach(() => { vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} }); });
afterEach(async () => { await act(async () => root?.unmount()); node?.remove(); client?.clear(); vi.resetAllMocks(); vi.unstubAllGlobals(); });

describe("permanent workspace deletion review", () => {
  it("requires an explicit review and confirmation listing shared services and the host copy", async () => {
    await mount(); expect(api.dataDeletionReview).not.toHaveBeenCalled(); await review();
    expect(node.textContent).toContain("Shared worker"); expect(node.textContent).toContain("retained host copy");
    expect(button("Delete data permanently").disabled).toBe(true);
    await confirm(); expect(button("Delete data permanently").disabled).toBe(false); expect(api.deleteData).not.toHaveBeenCalled();
  });
  it("describes task workspace deletion and preserved Git history before confirmation", async () => {
    await mount({ ...initial, provider: "local", scope: "task_workspace", includesHostMirror: false,
      workspace: { id: "workspace", name: "App worktree", providerType: "git_worktree", preservesBranchHistory: true },
      tasks: [{ id: "task", title: "Develop app", identifier: "PAP-1" }] }); await review();
    expect(node.textContent).toContain("App worktree"); expect(node.textContent).toContain("Linked tasks");
    expect(node.textContent).toContain("branch history"); expect(node.textContent).toContain("uncommitted");
    expect(button("Delete data permanently").disabled).toBe(true);
  });
  it("shows blockers and prevents confirmation while a task still depends on the workspace", async () => {
    await mount({ ...initial, blockers: ["Detach every attached task before deleting this workspace's data."], tasks: [{ id: "task", title: "Develop app", identifier: "PAP-1" }] }); await review();
    expect(node.querySelector('a[href="/issues/task"]')?.textContent).toBe("PAP-1 · Develop app");
    expect(node.querySelector('[role="checkbox"]')).toBeNull(); expect(button("Delete data permanently").disabled).toBe(true);
  });
  it("reviews each remote sandbox and preserves partial deletion progress alongside its host checkout", async () => {
    await mount({ ...initial, scope: "task_workspace", workspace: { id: "workspace", name: "Remote app checkout", providerType: "git_worktree", preservesBranchHistory: true },
      remoteSandboxes: [{ provider: "daytona", id: "first", name: "App sandbox", deleted: true }, { provider: "daytona", id: "second", name: "Worker sandbox", deleted: false }],
      deletion: { ...accepted.deletion!, state: "failed", error: "The second sandbox needs its provider connection restored." } }); await review();
    expect(node.textContent).toContain("retained local checkout will be deleted"); expect(node.textContent).toContain("App sandbox · daytona · Deletion confirmed");
    expect(node.textContent).toContain("Worker sandbox · daytona"); expect(node.textContent).toContain("provider connection restored");
    expect(button("Retry data deletion").disabled).toBe(true); await confirm(); expect(button("Retry data deletion").disabled).toBe(false);
  });
  it("clears confirmation when an authoritative review changes", async () => {
    await mount(); await review(); await confirm();
    await act(async () => client.setQueryData(key, { ...initial, planToken: "c".repeat(64), services: [...initial.services, { id: "new", name: "New sibling", state: "stopped" }] })); await settle();
    expect(node.textContent).toContain("New sibling"); expect(node.textContent).toContain("workspace changed");
    expect(button("Delete data permanently").disabled).toBe(true);
  });
  it("prevents repeated submissions and recovers a lost response with the same request identity", async () => {
    await mount(); await review(); await confirm();
    let reject!: (error: Error) => void;
    api.deleteData.mockImplementationOnce(() => new Promise((_resolve, no) => { reject = no; })).mockResolvedValueOnce(accepted);
    await act(async () => { button("Delete data permanently").click(); node.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); }); await settle();
    expect(api.deleteData).toHaveBeenCalledTimes(1); expect(button("Requesting deletion…").disabled).toBe(true);
    await act(async () => reject(new Error("Response lost"))); await settle();
    expect(button("Cancel").disabled).toBe(true);
    await act(async () => button("Retry deletion request").click()); await settle();
    expect(api.deleteData.mock.calls[1]!.slice(0, 3)).toEqual(api.deleteData.mock.calls[0]!.slice(0, 3));
    expect(api.deleteData.mock.calls[1]![3].signal).not.toBe(api.deleteData.mock.calls[0]![3].signal);
    expect(node.textContent).toContain("Deleting workspace data…"); expect(node.querySelector('[role="alert"]')).toBeNull();
    await act(async () => client.refetchQueries({ queryKey: key })); await settle();
    expect(node.textContent).toContain("Deleting workspace data…");
  });
  it("clears uncertainty from an authoritative completion and does not regress on an old poll", async () => {
    await mount(); await review(); await confirm(); api.deleteData.mockRejectedValueOnce(new Error("Response lost"));
    await act(async () => button("Delete data permanently").click()); await settle();
    expect(node.querySelector('[role="alert"]')).not.toBeNull();
    const complete = { ...accepted, deletion: { ...accepted.deletion!, state: "deleted" as const, attempts: 1, completedAt: "2026-09-13T00:00:01.000Z", updatedAt: "2026-09-13T00:00:01.000Z" } };
    await act(async () => client.setQueryData(key, complete)); await settle();
    expect(node.textContent).toContain("Workspace data deleted"); expect(node.querySelector('[role="alert"]')).toBeNull();
    await act(async () => client.refetchQueries({ queryKey: key })); await settle();
    expect(node.textContent).toContain("Workspace data deleted"); expect(node.querySelector("form")).toBeNull();
  });
  it("requires a fresh confirmation after a definite conflict rather than replaying a stale plan", async () => {
    await mount(); await review(); await confirm(); api.deleteData.mockRejectedValueOnce(new ApiError("The workspace changed", 409, {}));
    await act(async () => button("Delete data permanently").click()); await settle();
    expect(button("Delete data permanently").disabled).toBe(true); expect(button("Retry deletion request")).toBeUndefined(); expect(button("Cancel").disabled).toBe(false);
  });
  it("lets viewers read deletion progress without offering destructive controls", async () => {
    await mount(accepted, false, { ...service, dataDeletion: accepted.deletion });
    expect(node.textContent).toContain("Deleting workspace data…"); expect(node.querySelector("button")).toBeNull(); expect(api.deleteData).not.toHaveBeenCalled();
  });
});
