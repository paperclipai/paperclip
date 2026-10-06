// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { IssueWorkProduct } from "@paperclipai/shared";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { queryKeys } from "@/lib/queryKeys";
import { useIssueWorkProducts } from "./useIssueWorkProducts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function response(products: IssueWorkProduct[]) {
  return { ok: true, status: 200, json: async () => products } as Response;
}

function product(id: string, overrides: Partial<IssueWorkProduct> = {}): IssueWorkProduct {
  return {
    id, type: "pull_request", provider: "github", title: id,
    url: "https://github.com/example/repo/pull/42", metadata: {},
    status: "ready_for_review", reviewState: "needs_board_review",
    updatedAt: new Date("2026-10-06T12:00:00Z"), ...overrides,
  } as IssueWorkProduct;
}

let client: QueryClient;
let root: Root;
let host: HTMLDivElement;
let issueId: string;
let observed: ReturnType<typeof useIssueWorkProducts>;
let saved: IssueWorkProduct[];
let requests: Array<{ path: string; signal: AbortSignal; resolve: (products: IssueWorkProduct[]) => void }>;
let stallSaved: boolean;

function Harness() { observed = useIssueWorkProducts(issueId); return null; }
async function render() {
  await act(async () => root.render(<QueryClientProvider client={client}><Harness /></QueryClientProvider>));
}
async function waitFor(assertion: () => void) {
  await vi.waitFor(async () => {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    assertion();
  });
}
async function liveUpdate() {
  await act(async () => { void client.invalidateQueries({ queryKey: queryKeys.issues.workProducts(issueId) }); });
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  host = document.createElement("div");
  root = createRoot(host);
  issueId = "work-product-race";
  saved = [product("pr")];
  requests = [];
  stallSaved = false;
  // Keep the real API client, including GET coalescing and abort handling.
  vi.stubGlobal("fetch", vi.fn((path: string, init: RequestInit) => {
    if (!stallSaved && !path.includes("refreshPullRequests=true")) return Promise.resolve(response(saved));
    return new Promise<Response>((resolve) => {
      requests.push({ path, signal: init.signal as AbortSignal, resolve: (products) => resolve(response(products)) });
    });
  }));
});
afterEach(async () => {
  await act(async () => { root.unmount(); client.clear(); requests.forEach((request) => request.resolve([])); });
  host.remove();
  vi.unstubAllGlobals();
});

it("shows a newly saved artifact during GitHub refresh and keeps it after the old response", async () => {
  const pr = saved[0];
  await render();
  await waitFor(() => expect(requests).toHaveLength(1));
  saved = [pr, product("new-artifact", { type: "artifact" })];
  await liveUpdate();
  await waitFor(() => expect(observed.data?.map((row) => row.id)).toEqual(["pr", "new-artifact"]));
  // An artifact arrival does not cancel or restart the unrelated provider request.
  expect(requests).toHaveLength(1);
  await act(async () => requests[0].resolve([{ ...pr, metadata: { state: "merged" } }]));
  await waitFor(() => expect(observed.data?.[0].metadata?.state).toBe("merged"));
  expect(observed.data?.map((row) => row.id)).toEqual(["pr", "new-artifact"]);
});

it("keeps a changed review request when an older provider response arrives last", async () => {
  const original = saved[0];
  await render();
  await waitFor(() => expect(requests).toHaveLength(1));
  saved = [{ ...original, status: "changes_requested", reviewState: "changes_requested", updatedAt: new Date("2026-10-06T12:01:00Z") }];
  await liveUpdate();
  await waitFor(() => {
    expect(observed.data?.[0].reviewState).toBe("changes_requested");
    expect(requests).toHaveLength(2);
  });
  await act(async () => requests[1].resolve([{ ...saved[0], metadata: { state: "open" } }]));
  await waitFor(() => expect(observed.data?.[0].metadata?.state).toBe("open"));
  await act(async () => requests[0].resolve([{ ...original, metadata: { state: "merged" } }]));
  expect(observed.data?.[0].reviewState).toBe("changes_requested");
  expect(observed.data?.[0].metadata?.state).toBe("open");
});

it("starts a fresh stored read when a live update invalidates an in-flight read", async () => {
  const old = product("old", { type: "artifact" });
  client.setQueryData(queryKeys.issues.workProducts(issueId), [old]);
  stallSaved = true;
  await render();
  await waitFor(() => expect(requests).toHaveLength(1));
  await liveUpdate();
  await waitFor(() => expect(requests).toHaveLength(2));
  expect(requests[0].signal.aborted).toBe(true);
  const added = product("new", { type: "artifact" });
  await act(async () => requests[1].resolve([old, added]));
  await waitFor(() => expect(observed.data?.map((row) => row.id)).toEqual(["old", "new"]));
  await act(async () => requests[0].resolve([old]));
  expect(observed.data?.map((row) => row.id)).toEqual(["old", "new"]);
});

it("does not show an old task's provider response after navigating", async () => {
  const original = saved[0];
  await render();
  await waitFor(() => expect(requests).toHaveLength(1));
  issueId = "another-task";
  saved = [product("another-artifact", { type: "artifact" })];
  await render();
  await waitFor(() => expect(observed.data?.[0].id).toBe("another-artifact"));
  await act(async () => requests[0].resolve([{ ...original, metadata: { state: "merged" } }]));
  expect(observed.data?.map((row) => row.id)).toEqual(["another-artifact"]);
});
