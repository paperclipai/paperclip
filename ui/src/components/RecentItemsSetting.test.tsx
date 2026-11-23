// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RecentItemsSetting } from "./RecentItemsSetting";
import { queryKeys } from "@/lib/queryKeys";

const mocks = vi.hoisted(() => ({ get: vi.fn(), update: vi.fn() }));
vi.mock("@/api/workspacePreferences", () => ({ workspacePreferencesApi: mocks }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, container: HTMLDivElement, client: QueryClient;
const pref = (userId: string, recentItemsLimit: number) => ({ userId, recentItemsLimit, coordinatorWorkspaceEnabled: true, timeZone: null, updatedAt: null });
async function flush() { await act(async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setTimeout(resolve, 0)); }); }
async function render(userId = "alice") {
  client.setQueryData(queryKeys.auth.session, { user: { id: userId } });
  await act(async () => root.render(<QueryClientProvider client={client}><RecentItemsSetting companyId="company" userId={userId} /></QueryClientProvider>));
  await flush();
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.get.mockResolvedValue(pref("alice", 20));
  mocks.update.mockImplementation(async (_company, update) => pref("alice", update.recentItemsLimit));
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
});
afterEach(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); });
it("saves zero immediately and keeps the choice on remount", async () => {
  await render();
  const select = container.querySelector("select")!;
  expect(select.value).toBe("20");
  expect(Array.from(select.options, option => option.value)).toEqual(["0", "5", "10", "20", "50", "100"]);
  await act(async () => { select.value = "0"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  await flush();
  expect(mocks.update).toHaveBeenCalledWith("company", { recentItemsLimit: 0 });
  expect(client.getQueryData(queryKeys.workspacePreferences.mine("alice"))).toMatchObject({ recentItemsLimit: 0 });
  await render();
  expect(container.querySelector("select")?.value).toBe("0");
});
it("keeps the saved value and shows a failed save", async () => {
  mocks.update.mockRejectedValue(new Error("Save unavailable"));
  await render();
  await act(async () => { const select = container.querySelector("select")!; select.value = "0"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  await flush();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Save unavailable");
  expect(container.querySelector("select")?.value).toBe("20");
});
it("does not reuse another account's choice", async () => {
  await render();
  mocks.get.mockResolvedValue(pref("bob", 5));
  await render("bob");
  expect(container.querySelector("select")?.value).toBe("5");
});
