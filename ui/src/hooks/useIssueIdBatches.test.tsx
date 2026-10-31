// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import { useIssueIdBatches } from "./useIssueIdBatches";

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
