// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ConnectivityProvider, createConnectivityStore } from "@/lib/connectivity";
import { pendingSendKeyFor } from "@/lib/pending-send";
import { DETACHED_DRAFT_OWNER } from "./useDraftOwner";
import { useBackgroundSubmitQueue } from "./useBackgroundSubmitQueue";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Payload = { body: string };
const isPayload = (value: unknown): value is Payload =>
  !!value && typeof value === "object" && typeof (value as Payload).body === "string";
const KEY = "test:background-send";
const stores: Array<ReturnType<typeof createConnectivityStore>> = [];
const roots = new Set<Root>();

beforeEach(() => localStorage.clear());
afterEach(() => {
  act(() => { for (const root of roots) root.unmount(); });
  roots.clear();
  for (const store of stores) store.dispose();
  stores.length = 0;
  document.body.innerHTML = "";
});

function mountTab(send: (payload: Payload, key: string) => Promise<string>) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.add(root);
  const store = createConnectivityStore({ browserOnline: true, probe: async () => ({ reachable: true, retryAfterMs: null }) });
  stores.push(store);
  let current!: ReturnType<typeof useBackgroundSubmitQueue<Payload, string>>;
  function Harness() {
    current = useBackgroundSubmitQueue({ sourceId: `tab-${stores.indexOf(store)}`, storageKey: KEY, isPayload, send, onAttention: () => {} });
    return null;
  }
  act(() => root.render(<ConnectivityProvider store={store}><Harness /></ConnectivityProvider>));
  return {
    get queue() { return current; },
    unmount() { act(() => root.unmount()); roots.delete(root); },
  };
}

it("retains another tab's queued tasks through submission, completion, and reload", async () => {
  const firstSend = vi.fn<(payload: Payload, key: string) => Promise<string>>().mockImplementation(() => new Promise(() => {}));
  let finishOther!: (result: string) => void;
  const otherSend = vi.fn<(payload: Payload, key: string) => Promise<string>>()
    .mockImplementation(() => new Promise(resolve => { finishOther = resolve; }));
  const first = mountTab(firstSend);
  const other = mountTab(otherSend);
  await act(async () => {
    first.queue.enqueue({ body: "First slow save" }, "first-key");
    first.queue.enqueue({ body: "Second waiting task" }, "second-key");
  });
  expect(firstSend).toHaveBeenCalledOnce();
  await act(async () => { other.queue.enqueue({ body: "Other tab's task" }, "other-key"); });
  await act(async () => { finishOther("saved"); });
  first.unmount();
  other.unmount();

  const reloadedSend = vi.fn<(payload: Payload, key: string) => Promise<string>>().mockResolvedValue("saved");
  await act(async () => { mountTab(reloadedSend); });
  expect(reloadedSend.mock.calls.map(([payload, key]) => [payload.body, key])).toEqual([
    ["First slow save", "first-key"], ["Second waiting task", "second-key"],
  ]);
});

it("migrates the previous queue format and restores rejected requests without sending them", async () => {
  const storageKey = pendingSendKeyFor(`${KEY}:queue`, DETACHED_DRAFT_OWNER);
  const rejection = { title: "Task failed", body: "Fix the saved request.", retryable: false };
  localStorage.setItem(storageKey, JSON.stringify([
    { payload: { body: "Legacy rejected task" }, idempotencyKey: "legacy-key", createdAt: 1, rejection },
  ]));
  const send = vi.fn<(payload: Payload, key: string) => Promise<string>>().mockResolvedValue("saved");
  const first = mountTab(send);
  expect(first.queue.rejected[0]).toMatchObject({ idempotencyKey: "legacy-key", rejection });
  expect(send).not.toHaveBeenCalled();
  first.unmount();
  const reloaded = mountTab(send);
  expect(reloaded.queue.rejected[0]).toMatchObject({ idempotencyKey: "legacy-key", rejection });
  await act(async () => { reloaded.queue.enqueue({ body: "Legacy rejected task" }, "legacy-key"); });
  expect(send).toHaveBeenCalledWith({ body: "Legacy rejected task" }, "legacy-key");
  reloaded.unmount();
  const afterReceipt = mountTab(send);
  expect(afterReceipt.queue.rejected).toEqual([]);
  expect(send).toHaveBeenCalledOnce();
});
