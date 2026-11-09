// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AttentionItem } from "@paperclipai/shared";
import { AttentionRecoveryResolver } from "./AttentionRecoveryResolver";

const api = vi.hoisted(() => ({ read: vi.fn(), resolve: vi.fn(), resolved: vi.fn() }));
vi.mock("@/api/issues", () => ({ issuesApi: { recoveryActions: api.read, resolveRecoveryAction: api.resolve } }));
vi.mock("./IssueRecoveryActionCard", () => ({ IssueRecoveryActionCard: ({ onResolve }: { onResolve: (value: string) => void }) => <button onClick={() => onResolve("todo")}>Try again</button> }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let client: QueryClient;
const item = { subject: { id: "recovery", metadata: { sourceIssueId: "task" } }, relatedIssue: { id: "task" } } as unknown as AttentionItem;
beforeEach(() => {
  vi.resetAllMocks();
  api.read.mockResolvedValue({ actions: [{ id: "recovery", status: "active" }] });
  api.resolve.mockResolvedValue({});
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); });
async function flush() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); }
async function render() {
  await act(async () => root.render(<QueryClientProvider client={client}><AttentionRecoveryResolver item={item} companyId="company" onResolved={api.resolved} /></QueryClientProvider>));
  await flush(); await flush();
}
it("uses the canonical company-scoped recovery action and refreshes after acceptance", async () => {
  await render();
  await act(async () => container.querySelector("button")!.click()); await flush(); await flush();
  expect(api.read).toHaveBeenCalledWith("task");
  expect(api.resolve).toHaveBeenCalledWith("task", { actionId: "recovery", outcome: "restored", sourceIssueStatus: "todo" });
  expect(api.resolved).toHaveBeenCalledOnce();
});
it("keeps a rejected recovery visible with the server's reason", async () => {
  api.resolve.mockRejectedValueOnce(new Error("Recovery ownership changed"));
  await render();
  await act(async () => container.querySelector("button")!.click()); await flush(); await flush();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Recovery ownership changed");
  expect(api.resolved).not.toHaveBeenCalled();
  expect(container.querySelector("button")?.disabled).toBe(false);
});
it("does not offer actions on an already resolved recovery", async () => {
  api.read.mockResolvedValue({ actions: [{ id: "recovery", status: "resolved" }] });
  await render();
  expect(container.textContent).toContain("no longer awaiting");
  expect(container.querySelector("button")).toBeNull();
});
