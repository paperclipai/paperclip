// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import { prefetchIssueIdBatches, useIssueIdBatches } from "./useIssueIdBatches";

it("requests metadata only for newly revealed ids and refreshes existing batches on invalidation", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRoot(document.createElement("div"));
  const fetch = vi.fn(async (ids: string[]) => ids.map(id => ({ id })));
  let ids = Array.from({ length: 20 }, (_, index) => String(index));
  let current: ReturnType<typeof useIssueIdBatches<{ id: string }>>;
  function Probe() { current = useIssueIdBatches(["metadata", "chat"], ids, fetch, true); return null; }
  const render = () => act(async () => root.render(<QueryClientProvider client={client}><Probe /></QueryClientProvider>));
  try {
    await render();
    await vi.waitFor(() => expect(current!.data).toHaveLength(20));
    ids = Array.from({ length: 170 }, (_, index) => String(index));
    await render();
    await vi.waitFor(() => expect(current!.data).toHaveLength(170));
    expect(fetch.mock.calls.flatMap(([batch]) => batch)).toHaveLength(170);
    expect(fetch.mock.calls.every(([batch]) => batch.length <= 100)).toBe(true);
    await act(async () => { await client.invalidateQueries({ queryKey: ["metadata", "chat"] }); });
    expect(fetch.mock.calls.flatMap(([batch]) => batch)).toHaveLength(340);
  } finally { await act(async () => root.unmount()); client.clear(); }
});

it("renders prefetched batches from cache on the first render", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRoot(document.createElement("div"));
  const fetch = vi.fn(async (ids: string[]) => ids.map(id => ({ id })));
  const ids = Array.from({ length: 130 }, (_, index) => String(index).padStart(3, "0"));
  await prefetchIssueIdBatches(client, ["metadata", "chat"], ids, fetch, 30_000);
  expect(fetch).toHaveBeenCalledTimes(2);
  const renders: Array<{ isLoading: boolean; size: number }> = [];
  function Probe() {
    const current = useIssueIdBatches(["metadata", "chat"], ids, fetch, true);
    renders.push({ isLoading: current.isLoading, size: current.data.length });
    return null;
  }
  try {
    await act(async () => root.render(<QueryClientProvider client={client}><Probe /></QueryClientProvider>));
    // The first render already has every batch, so nothing gates on a fetch.
    // A background refresh of the stale batches may follow, as for any query.
    expect(renders[0]).toEqual({ isLoading: false, size: 130 });
    expect(fetch.mock.calls.slice(0, 2).map(([batch]) => batch.length)).toEqual([100, 30]);
  } finally { await act(async () => root.unmount()); client.clear(); }
});
