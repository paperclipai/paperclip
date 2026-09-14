// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { RuntimeService, RuntimeServiceStorageView } from "@paperclipai/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RuntimeServiceStorage } from "./RuntimeServiceStorage";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const api = vi.hoisted(() => ({ storage: vi.fn(), refreshStorage: vi.fn() }));
vi.mock("../api/runtime-services", () => ({ runtimeServicesApi: api }));
vi.mock("../lib/router", () => ({ Link: ({ to, children, ...props }: ComponentProps<"a"> & { to: string }) => <a href={to} {...props}>{children}</a> }));
const service = { id: "service", companyId: "company", retention: { state: "retained", error: null, compute: "stopped" } } as RuntimeService;
const key = ["runtime-service-storage", service.companyId, service.id];
const initial: RuntimeServiceStorageView = { allocationId: "allocation", serviceCount: 2,
  services: [{ id: "service", name: "App", state: "stopped" }, { id: "sibling", name: "Worker", state: "stopped" }],
  usage: { status: "ready", bytes: 4096, checkedAt: "2026-09-13T00:00:00.000Z", measuredAt: "2026-09-13T00:00:00.000Z", reason: null } };
let root: Root, node: HTMLDivElement, client: QueryClient;
async function settle() { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); }); }
async function mount(value = initial, canManage = true, expiration?: RuntimeService["retention"]["expiration"]) {
  api.storage.mockResolvedValue(value);
  node = document.createElement("div"); document.body.appendChild(node); root = createRoot(node);
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
  await act(async () => { root.render(<QueryClientProvider client={client}><RuntimeServiceStorage service={{ ...service, retention: { ...service.retention, expiration } }} canManage={canManage} /></QueryClientProvider>); }); await settle();
}
afterEach(async () => { await act(async () => root?.unmount()); node?.remove(); client?.clear(); vi.resetAllMocks(); });
describe("shared workspace storage feedback", () => {
  it("shows expiration and the reason shared data is protected without implying it will be deleted", async () => {
    await mount(initial, false, { policyRevision: 2, retainedDataSeconds: 86400, state: "protected", expiresAt: "2026-09-15T00:00:00.000Z", checkedAt: "2026-09-13T00:00:00.000Z", blockers: ["Complete or cancel every linked task before deleting its workspace data."] });
    expect(node.textContent).toContain("Unused data retention: 1 day");
    expect(node.textContent).toContain("Data is protected from automatic deletion");
    expect(node.textContent).toContain("Complete or cancel every linked task");
    expect(node.textContent).not.toContain("Eligible for permanent deletion after");
  });
  it("shows the default retain-until-deleted policy", async () => {
    await mount(initial, false, { policyRevision: 0, retainedDataSeconds: null, state: "disabled", expiresAt: null, checkedAt: null, blockers: [] });
    expect(node.textContent).toContain("Files are kept until explicitly deleted");
  });
  it("shows measurements to viewers without a measurement control", async () => {
    await mount(initial, false); expect(node.textContent).toContain("4 KiB"); expect(node.querySelector("button")).toBeNull();
  });
  it("shows the last measurement and explains stopped compute without presenting zero or starting it", async () => {
    await mount({ ...initial, usage: { ...initial.usage, status: "unavailable", reason: "compute_stopped" } });
    expect(node.textContent).toContain("4 KiB"); expect(node.textContent).toContain("does not start it");
    expect(node.textContent).toContain("shared by 2 services"); expect(node.querySelector('a[href="/runtime-services/sibling"]')?.textContent).toBe("Worker");
    expect(api.refreshStorage).not.toHaveBeenCalled();
  });
  it("prevents repeat checks, publishes new measurements and rejects a stale poll", async () => {
    await mount(); let resolve!: (value: RuntimeServiceStorageView) => void;
    api.refreshStorage.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    await act(async () => { node.querySelector("button")!.click(); node.querySelector("button")!.click(); });
    await settle();
    expect(api.refreshStorage).toHaveBeenCalledTimes(1); expect(node.querySelector("button")!.disabled).toBe(true);
    const fresh = { ...initial, usage: { ...initial.usage, bytes: 8192, checkedAt: "2026-09-13T00:01:00.000Z" } };
    await act(async () => resolve(fresh)); await settle();
    expect(node.textContent).toContain("8 KiB");
    await act(async () => { await client.refetchQueries({ queryKey: key }); });
    expect(node.textContent).toContain("8 KiB");
  });
  it("clears a lost-response error only after a newer authoritative measurement arrives", async () => {
    await mount(); api.refreshStorage.mockRejectedValueOnce(new Error("Response lost"));
    await act(async () => node.querySelector("button")!.click()); await settle();
    expect(node.querySelector('[role="alert"]')).not.toBeNull();
    const fresh = { ...initial, usage: { ...initial.usage, checkedAt: "2026-09-13T00:01:00.000Z" } };
    await act(async () => client.setQueryData(key, fresh)); await settle();
    expect(node.querySelector('[role="alert"]')).toBeNull();
  });
});
