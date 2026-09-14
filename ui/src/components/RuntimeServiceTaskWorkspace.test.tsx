// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { RuntimeService } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client";
import { RuntimeServiceTaskWorkspace } from "./RuntimeServiceTaskWorkspace";
import { serviceKeys } from "../hooks/useRuntimeServices";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const api = vi.hoisted(() => ({ attachTask: vi.fn(), detachTask: vi.fn(), list: vi.fn() }));
vi.mock("../api/runtime-services", () => ({ runtimeServicesApi: { attachTask: api.attachTask, detachTask: api.detachTask } }));
vi.mock("../api/issues", () => ({ issuesApi: { list: api.list } }));
vi.mock("../lib/router", () => ({ Link: ({ to, children }: { to: string; children: React.ReactNode }) => <a href={to}>{children}</a> }));
const service = { id: "service", companyId: "company", provider: "daytona", issueId: "task", executionWorkspaceId: null, revision: 4, canAttachTaskWorkspace: true } as RuntimeService;
let root: Root | undefined, node: HTMLDivElement, client: QueryClient;
async function mount(value = service) {
  node = document.createElement("div"); document.body.appendChild(node); root = createRoot(node);
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } } });
  await act(async () => { root!.render(<QueryClientProvider client={client}><RuntimeServiceTaskWorkspace service={value} /></QueryClientProvider>); });
}
const button = (text: string) => Array.from(node.querySelectorAll("button")).find((item) => item.textContent === text)!;
async function click(text: string) { await act(async () => { button(text).click(); }); }
async function settle() { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); }); }
beforeEach(() => { api.list.mockResolvedValue([{ id: "task", identifier: "APP-1", title: "Develop app" }]); });
afterEach(async () => { await act(async () => { root?.unmount(); }); node?.remove(); client?.clear(); vi.resetAllMocks(); });

describe("service workspace attachment feedback", () => {
  it("suppresses repeated activation and retries an uncertain response with the original request", async () => {
    let reject!: (error: Error) => void;
    api.attachTask.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }))
      .mockResolvedValueOnce({ ...service, revision: 5, taskWorkspace: { issueId: "task" } });
    await mount(); await click("Develop in a task"); await settle();
    await act(async () => { const submit = button("Attach task workspace"); submit.click(); submit.click(); });
    await settle();
    expect(api.attachTask).toHaveBeenCalledTimes(1);
    expect(Array.from(node.querySelectorAll("button")).map((item) => item.textContent)).toContain("Attaching…");
    expect(button("Attaching…").disabled).toBe(true);
    expect(node.textContent).toContain("Attaching service workspace");
    await act(async () => reject(new Error("Response lost"))); await settle();
    expect(node.querySelector<HTMLButtonElement>('[role="combobox"]')?.disabled).toBe(true);
    expect(button("Cancel").disabled).toBe(true);
    await click("Retry attachment"); await settle();
    expect(api.attachTask.mock.calls[1]).toEqual(api.attachTask.mock.calls[0]);
    expect(client.getQueryData(serviceKeys.detail("company", "service"))).toMatchObject({ revision: 5, taskWorkspace: { issueId: "task" } });
  });

  it("allows correction after a definitive conflict", async () => {
    api.attachTask.mockRejectedValue(new ApiError("Wait for this task's active run to finish", 409, {}));
    await mount(); await click("Develop in a task"); await settle(); await click("Attach task workspace"); await settle();
    expect(node.textContent).toContain("active run");
    expect(node.querySelector<HTMLButtonElement>('[role="combobox"]')?.disabled).toBe(false);
    expect(button("Cancel").disabled).toBe(false);
  });

  it("shows the bound task without offering a second attachment", async () => {
    await mount({ ...service, taskWorkspace: { issueId: "task" } });
    expect(node.querySelector('a')?.getAttribute("href")).toBe("/issues/task");
    expect(node.textContent).toContain("retained files");
    expect(button("Detach task workspace")).toBeDefined();
    expect(button("Develop in a task")).toBeUndefined();
    expect(api.list).not.toHaveBeenCalled();
  });

  it("pins the task and request identity while detachment is uncertain", async () => {
    let reject!: (error: Error) => void;
    api.detachTask.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }))
      .mockResolvedValueOnce({ ...service, revision: 5, issueId: null, taskWorkspace: null });
    await mount({ ...service, taskWorkspace: { issueId: "task" } });
    await act(async () => { const submit = button("Detach task workspace"); submit.click(); submit.click(); }); await settle();
    expect(api.detachTask).toHaveBeenCalledTimes(1);
    expect(button("Detaching…").disabled).toBe(true);
    await act(async () => reject(new Error("Response lost"))); await settle();
    expect(node.textContent).toContain("Detachment could not be confirmed");
    await click("Retry detachment"); await settle();
    expect(api.detachTask.mock.calls[1]).toEqual(api.detachTask.mock.calls[0]);
    expect(api.detachTask.mock.calls[0]?.[2]).toMatchObject({ issueId: "task", expectedRevision: 4 });
    expect(client.getQueryData(serviceKeys.detail("company", "service"))).toMatchObject({ revision: 5, taskWorkspace: null });
  });
});
