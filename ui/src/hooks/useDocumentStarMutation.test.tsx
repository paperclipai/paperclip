// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResourceMemberships } from "@paperclipai/shared";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const membershipsApiMock = vi.hoisted(() => ({
  listMine: vi.fn(),
  updateDocument: vi.fn(),
}));

const pushToast = vi.hoisted(() => vi.fn());

vi.mock("../api/resourceMemberships", () => ({
  resourceMembershipsApi: membershipsApiMock,
}));

vi.mock("../context/ToastContext", () => ({
  useToastActions: () => ({ pushToast }),
}));

import { useDocumentStarMutation, useResourceMemberships } from "./useResourceMemberships";
import { queryKeys } from "../lib/queryKeys";

const MINE_KEY = queryKeys.resourceMemberships.mine("company-1");

function emptyMemberships(): ResourceMemberships {
  return {
    projectMemberships: {},
    agentMemberships: {},
    starredProjectIds: [],
    starredAgentIds: [],
    starredDocumentIds: [],
    projectStarredAt: {},
    agentStarredAt: {},
    documentStarredAt: {},
    updatedAt: null,
  };
}

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

async function flush() {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

type HarnessHandle = { mutate: ReturnType<typeof useDocumentStarMutation>["mutate"] };

function Harness({ onReady }: { onReady: (handle: HarnessHandle) => void }) {
  useResourceMemberships("company-1");
  const mutation = useDocumentStarMutation("company-1");
  onReady({ mutate: mutation.mutate });
  return <div data-testid="harness" />;
}

function starredIds(queryClient: QueryClient): string[] {
  return queryClient.getQueryData<ResourceMemberships>(MINE_KEY)?.starredDocumentIds ?? [];
}

describe("useDocumentStarMutation", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot> | null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = null;
    membershipsApiMock.listMine.mockReset();
    membershipsApiMock.updateDocument.mockReset();
    pushToast.mockReset();
  });

  afterEach(async () => {
    if (root) {
      await act(async () => { root?.unmount(); });
    }
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  async function render(onReady: (handle: HarnessHandle) => void) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <Harness onReady={onReady} />
        </QueryClientProvider>,
      );
    });
    // Let the initial memberships query settle into the cache.
    await act(async () => { await flush(); });
    return queryClient;
  }

  it("optimistically stars a document before the server responds and confirms on success", async () => {
    membershipsApiMock.listMine.mockResolvedValue(emptyMemberships());
    let resolveUpdate: (() => void) | null = null;
    membershipsApiMock.updateDocument.mockReturnValue(
      new Promise((resolve) => {
        resolveUpdate = () =>
          resolve({
            resourceType: "document",
            resourceId: "doc-1",
            state: "joined",
            starredAt: new Date(),
            updatedAt: new Date(),
          });
      }),
    );

    let handle: HarnessHandle | null = null;
    const queryClient = await render((h) => { handle = h; });
    expect(starredIds(queryClient)).not.toContain("doc-1");

    await act(async () => {
      handle!.mutate({ documentId: "doc-1", documentName: "Launch Brief", starred: true });
      await flush();
    });

    // Optimistic flip is applied to the cache while the request is still in flight.
    expect(starredIds(queryClient)).toContain("doc-1");
    expect(membershipsApiMock.updateDocument).toHaveBeenCalledWith("company-1", "doc-1", { starred: true });

    // Server truth now reflects the star; the post-settle refetch stays consistent.
    membershipsApiMock.listMine.mockResolvedValue({
      ...emptyMemberships(),
      starredDocumentIds: ["doc-1"],
      documentStarredAt: { "doc-1": new Date().toISOString() },
    });
    await act(async () => {
      resolveUpdate?.();
      await flush();
    });
    // Server confirmation (starredAt set) keeps the star in place.
    expect(starredIds(queryClient)).toContain("doc-1");
  });

  it("invalidates the Artifacts list on settle so an unstarred doc leaves the Starred tab", async () => {
    membershipsApiMock.listMine.mockResolvedValue({
      ...emptyMemberships(),
      starredDocumentIds: ["doc-1"],
      documentStarredAt: { "doc-1": new Date().toISOString() },
    });
    membershipsApiMock.updateDocument.mockResolvedValue({
      resourceType: "document",
      resourceId: "doc-1",
      state: "left",
      starredAt: null,
      updatedAt: new Date(),
    });

    let handle: HarnessHandle | null = null;
    const queryClient = await render((h) => { handle = h; });
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    await act(async () => {
      handle!.mutate({ documentId: "doc-1", documentName: "Launch Brief", starred: false });
      await flush();
    });

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["artifacts"] });
  });

  it("rolls back the optimistic unstar and toasts when the server rejects", async () => {
    membershipsApiMock.listMine.mockResolvedValue({
      ...emptyMemberships(),
      starredDocumentIds: ["doc-1"],
      documentStarredAt: { "doc-1": new Date().toISOString() },
    });
    membershipsApiMock.updateDocument.mockRejectedValue(new Error("nope"));

    let handle: HarnessHandle | null = null;
    const queryClient = await render((h) => { handle = h; });
    expect(starredIds(queryClient)).toContain("doc-1");

    await act(async () => {
      handle!.mutate({ documentId: "doc-1", documentName: "Launch Brief", starred: false });
      await flush();
    });

    // Rolled back to the pre-mutation (starred) snapshot after the rejection.
    expect(starredIds(queryClient)).toContain("doc-1");
    expect(pushToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Couldn't unstar Launch Brief.", tone: "error" }),
    );
  });
});
