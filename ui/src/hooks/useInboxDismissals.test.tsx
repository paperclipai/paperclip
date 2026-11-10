// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { InboxDismissal } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { list } = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock("../api/inboxDismissals", () => ({ inboxDismissalsApi: { list, dismiss: vi.fn(), snooze: vi.fn(), restore: vi.fn() } }));
import { ApiError } from "../api/client";
import { useInboxDismissals } from "./useInboxBadge";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const saved = [{ id: "d-1", companyId: "company-1", userId: "user-1", itemKey: "approval:a-1", dismissedAt: new Date(1_000) }] as unknown as InboxDismissal[];
type Result = ReturnType<typeof useInboxDismissals>;

describe("useInboxDismissals fallback", () => {
  let root: Root;
  let client: QueryClient;
  let latest: Result | null = null;
  beforeEach(() => {
    list.mockReset();
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    root = createRoot(document.createElement("div"));
  });
  afterEach(async () => { await act(async () => root.unmount()); client.clear(); });

  async function render(fallback: InboxDismissal[] | null) {
    function Probe() { latest = useInboxDismissals("company-1", { fallback }); return null; }
    await act(async () => root.render(<QueryClientProvider client={client}><Probe /></QueryClientProvider>));
  }

  it("stands in while the read is pending and yields to the server answer", async () => {
    let resolve!: (value: InboxDismissal[]) => void;
    list.mockReturnValue(new Promise(r => { resolve = r; }));
    await render(saved);
    expect(latest).toMatchObject({ isLoading: false, hasServerData: false });
    expect(latest!.dismissedAtByKey.get("approval:a-1")).toBe(1_000);
    await act(async () => resolve([]));
    await vi.waitFor(() => expect(latest).toMatchObject({ isLoading: false, hasServerData: true }));
    expect(latest!.dismissedAtByKey.size).toBe(0);
  });

  it("keeps the saved list after a transient failure and drops it after a refusal", async () => {
    list.mockRejectedValue(new ApiError("Busy", 503, null));
    await render(saved);
    await vi.waitFor(() => expect(latest!.error).toBeTruthy());
    expect(latest!.dismissedAtByKey.get("approval:a-1")).toBe(1_000);
    list.mockRejectedValue(new ApiError("No access", 403, null));
    await act(async () => { await client.refetchQueries(); });
    await vi.waitFor(() => expect(latest!.dismissedAtByKey.size).toBe(0));
  });

  it("waits as before without a saved list", async () => {
    list.mockReturnValue(new Promise(() => {}));
    await render(null);
    expect(latest).toMatchObject({ isLoading: true, hasServerData: false });
  });
});
