// @vitest-environment jsdom

import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { recognizeLinkPreview } from "@paperclipai/shared";
import { LinkPreviewProvider, useLinkPreviewContext } from "./LinkPreviewContext";
import { queryKeys } from "@/lib/queryKeys";

const target = recognizeLinkPreview("https://github.com/acme/web/pull/42")!;
function MountedLink() {
  const context = useLinkPreviewContext();
  useEffect(() => context?.register?.(target), [context]);
  return <span>Task content is ready</span>;
}
let root: Root | null = null;
afterEach(() => { if (root) act(() => root!.unmount()); root = null; document.body.replaceChildren(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it("aborts a stalled batch GET at its deadline and continues idle enrichment", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(document, "readyState", "get").mockReturnValue("complete");
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  let aborted = false;
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes("/link-previews/cached")) return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => { aborted = true; reject(new DOMException("Aborted", "AbortError")); });
    });
    return Response.json({ preview: { target, title: "Loaded on idle", state: "merged", author: null, updatedAt: null }, maxAgeMs: 60_000 });
  });
  vi.stubGlobal("fetch", fetch);
  vi.stubGlobal("requestIdleCallback", (callback: () => void) => setTimeout(callback, 0));
  vi.stubGlobal("cancelIdleCallback", (id: number) => clearTimeout(id));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const host = document.createElement("div"); document.body.append(host);
  root = createRoot(host);
  await act(async () => { root!.render(<QueryClientProvider client={client}><LinkPreviewProvider companyId="company-a" userId="alice"><MountedLink /></LinkPreviewProvider></QueryClientProvider>); });
  expect(host.textContent).toContain("Task content is ready");
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(fetch).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(6_600); });
  expect(aborted).toBe(true);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(client.getQueryData<{ preview: { state: string } }>(queryKeys.linkPreview("company-a", "alice", target.canonicalUrl))?.preview.state).toBe("merged");
  act(() => root!.unmount()); root = null; client.clear();
});
