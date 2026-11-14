// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Agent } from "@paperclipai/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentReportingManager, invalidManagerIds } from "./AgentReportingManager";
import { queryKeys } from "@/lib/queryKeys";

const api = vi.hoisted(() => ({ list: vi.fn(), update: vi.fn() }));
vi.mock("@/api/agents", () => ({ agentsApi: api }));
vi.mock("@/lib/router", () => ({ Link: ({ to, children, ...props }: any) => <a href={to} {...props}>{children}</a> }));

const agent = (id: string, reportsTo: string | null = null) => ({ id, companyId: "company", name: id, urlKey: id, reportsTo, status: "idle", role: "general" }) as Agent;
const directory = [agent("Alex"), agent("Report", "Alex"), agent("Nested", "Report"), agent("Morgan")];
let root: Root | undefined;
let host: HTMLDivElement;
afterEach(async () => { if (root) await act(() => root!.unmount()); host?.remove(); vi.clearAllMocks(); });
const flush = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
async function mount(value = directory[0]) {
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
  client.setQueryData(queryKeys.agents.list("company"), directory);
  api.list.mockResolvedValue(directory);
  await act(() => root!.render(<QueryClientProvider client={client}><AgentReportingManager agent={value} /></QueryClientProvider>));
  return client;
}

describe("Agent reporting manager", () => {
  it("blocks self and descendants, even when the directory is unordered", () => {
    expect(new Set(invalidManagerIds("Alex", [...directory].reverse()))).toEqual(new Set(["Alex", "Report", "Nested"]));
  });
  it("saves a selected manager in the current company and disables reporting loops", async () => {
    api.update.mockResolvedValue({ ...directory[0], reportsTo: "Morgan" });
    await mount();
    expect(host.textContent).toContain("No manager");
    await act(() => (host.querySelector('[aria-label="Choose manager"]') as HTMLButtonElement).click());
    const popup = document.querySelector('[data-slot="popover-content"]')!;
    const buttons = Array.from(popup.querySelectorAll("button"));
    expect(buttons.filter(button => button.disabled)).toHaveLength(3);
    await act(() => buttons.find(button => button.textContent?.startsWith("Morgan"))!.click());
    await flush();
    expect(api.update).toHaveBeenCalledWith("Alex", { reportsTo: "Morgan" }, "company");
  });
  it("keeps the cached manager and picker available after a transient directory failure", async () => {
    const client = await mount({ ...directory[0], reportsTo: "Morgan" });
    api.list.mockRejectedValue(new TypeError("Failed to fetch"));
    await act(async () => { await client.invalidateQueries({ queryKey: queryKeys.agents.list("company") }); });
    await flush();
    expect(host.querySelector("a")?.textContent).toBe("Morgan");
    expect((host.querySelector('[aria-label="Change manager"]') as HTMLButtonElement).disabled).toBe(false);
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });
  it("links the current manager and reports failed changes without hiding them", async () => {
    api.update.mockRejectedValue(new Error("Could not save manager"));
    await mount({ ...directory[0], reportsTo: "Morgan" });
    expect(host.querySelector("a")?.getAttribute("href")).toBe("/agents/Morgan/overview");
    await act(() => (host.querySelector('[aria-label="Change manager"]') as HTMLButtonElement).click());
    const clear = Array.from(document.querySelectorAll('[data-slot="popover-content"] button')).find(button => button.textContent === "No manager") as HTMLButtonElement;
    await act(() => clear.click()); await flush(); await flush();
    expect(api.update).toHaveBeenCalledWith("Alex", { reportsTo: null }, "company");
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Could not save manager");
    expect(host.querySelector("a")?.textContent).toBe("Morgan");
  });
});
