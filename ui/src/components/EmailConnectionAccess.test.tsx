// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ApiError } from "@/api/client";
import { EmailConnectionAccess } from "./EmailConnectionAccess";

const mocks = vi.hoisted(() => ({ grants: vi.fn(), installs: vi.fn(), save: vi.fn() }));
vi.mock("@/api/tools", () => ({ toolsApi: { listConnectionGrants: mocks.grants, getConnectionInstalls: mocks.installs, putConnectionInstalls: mocks.save } }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, host: HTMLDivElement, client: QueryClient;
let finishInstalls: () => void;
beforeEach(() => {
  vi.clearAllMocks();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  mocks.installs.mockReturnValue(new Promise(resolve => { finishInstalls = () => resolve({ installs: [] }); }));
});
afterEach(async () => {
  await act(async () => root.unmount()); finishInstalls(); client.clear(); host.remove();
});
it.each([403, 500])("shows a known %s before the other access read finishes", async status => {
  mocks.grants.mockRejectedValue(new ApiError("Access lookup failed", status, {}));
  await act(async () => root.render(<QueryClientProvider client={client}><EmailConnectionAccess companyId="company" connectionId="connection" agents={[]} /></QueryClientProvider>));
  await vi.waitFor(() => expect(host.querySelector('[data-query-view="error"]')).not.toBeNull());
  expect(host.textContent).not.toContain("Loading access");
  const retry = [...host.querySelectorAll("button")].find(button => button.textContent?.trim() === "Retry");
  if (status === 403) expect(retry).toBeUndefined();
  else {
    expect(retry).toBeDefined();
    mocks.grants.mockResolvedValue({ grants: [], capabilities: { canConfigure: false } });
    await act(async () => retry!.click());
    await vi.waitFor(() => expect(mocks.grants).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(host.textContent).toContain("Loading access"));
  }
});
