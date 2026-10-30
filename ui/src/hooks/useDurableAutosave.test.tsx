// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { queryKeys } from "@/lib/queryKeys";
import {
  ConnectivityProvider,
  createConnectivityStore,
  type ConnectivityStore,
  type ProbeResult,
} from "@/lib/connectivity";
import { autosaveLabel, useDurableAutosave, type DurableAutosave, type DurableAutosaveOptions } from "./useDurableAutosave";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const outage = () => new ApiError("Paperclip is restarting", 503, { error: "tenant_app_unavailable" });
const conflict = () => new ApiError("Document was updated by someone else", 409, { error: "Document was updated by someone else" });

describe("useDurableAutosave", () => {
  let container: HTMLDivElement;
  let root: Root;
  let store: ConnectivityStore;
  let probe: ReturnType<typeof vi.fn<() => Promise<ProbeResult>>>;
  let current: DurableAutosave<string>;

  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    probe = vi.fn<() => Promise<ProbeResult>>().mockResolvedValue({ reachable: false, retryAfterMs: null });
    store = createConnectivityStore({ probe, browserOnline: true });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    store.dispose();
    vi.useRealTimers();
  });

  function Harness(props: DurableAutosaveOptions<string>) {
    current = useDurableAutosave(props);
    return null;
  }

  function render(options: Partial<DurableAutosaveOptions<string>> & Pick<DurableAutosaveOptions<string>, "save">) {
    act(() => {
      root.render(
        <ConnectivityProvider store={store}>
          <Harness sourceId="doc" action="save the document" {...options} />
        </ConnectivityProvider>,
      );
    });
  }

  const advance = (ms: number) => act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

  it("keeps a conflict verification read pending through an outage", async () => {
    const save = vi.fn().mockRejectedValue(conflict());
    const matchesServer = vi.fn().mockRejectedValueOnce(outage()).mockResolvedValue(true);
    render({ save, matchesServer });
    await act(async () => { expect(await current.run("Accepted text")).toEqual({ kind: "waiting" }); });
    await advance(2_000);
    expect(matchesServer).toHaveBeenCalledTimes(2);
    expect(current.status).toBe("saved");
  });

  it("retains queued writes for two targets while disconnected", async () => {
    store.setBrowserOnline(false);
    const first = vi.fn().mockResolvedValue(undefined), second = vi.fn().mockResolvedValue(undefined);
    render({ sourceId: "task-a", save: first });
    await act(async () => { await current.run("A title"); });
    render({ sourceId: "task-b", save: second });
    await act(async () => { await current.run("B title"); });
    expect(store.getSnapshot().pendingWrites).toBe(2);
    await act(async () => { store.setBrowserOnline(true); store.reportSuccess(); });
    await advance(2_000);
    expect(first).toHaveBeenCalledWith("A title");
    expect(second).toHaveBeenCalledWith("B title");
  });

  it("finishes an admitted offline edit after its editor unmounts", async () => {
    store.setBrowserOnline(false);
    const first = vi.fn().mockResolvedValue(undefined), second = vi.fn().mockResolvedValue(undefined);
    render({ sourceId: "task-a", save: first });
    await act(async () => { await current.run("A title"); });
    act(() => root.unmount());
    root = createRoot(container);
    render({ sourceId: "task-b", save: second });
    await act(async () => { await current.run("B title"); });
    await act(async () => { store.setBrowserOnline(true); store.reportSuccess(); });
    await advance(2_000);
    expect(first).toHaveBeenCalledWith("A title");
    expect(second).toHaveBeenCalledWith("B title");
    expect(store.getSnapshot().pendingWrites).toBe(0);
  });
  it("never lets an old detached retry overwrite a newer edit after reopening the same target", async () => {
    let server = "Original";
    const oldSave = vi.fn().mockRejectedValueOnce(outage()).mockRejectedValueOnce(outage())
      .mockImplementation(async value => { server = value; });
    render({ sourceId: "editor-old", targetKey: "task-a:title", save: oldSave });
    await act(async () => { await current.run("Older title"); });
    act(() => root.unmount()); root = createRoot(container);
    await advance(0);
    expect(oldSave).toHaveBeenCalledTimes(2);
    const newSave = vi.fn(async value => { server = value; });
    render({ sourceId: "editor-new", targetKey: "task-a:title", save: newSave });
    await act(async () => { await current.run("Newer title"); });
    expect(server).toBe("Newer title");
    await advance(30_000);
    expect(server).toBe("Newer title");
    expect(oldSave).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot().pendingWrites).toBe(0);
  });

  it("keeps a detached edit when a reopened editor resets only its local state and storage is unavailable", async () => {
    const storage = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Storage unavailable"); });
    try {
      store.setBrowserOnline(false);
      const save = vi.fn().mockResolvedValue(undefined);
      render({ sourceId: "old-editor", targetKey: "task-a:description", storageKey: "draft:a", save });
      await act(async () => { current.persistDraft("Only remaining copy"); await current.run("Only remaining copy"); });
      act(() => root.unmount()); root = createRoot(container);
      render({ sourceId: "new-editor", targetKey: "task-a:description", storageKey: "draft:a", save });
      act(() => current.reset());
      await act(async () => { store.setBrowserOnline(true); store.reportSuccess(); });
      await advance(2_000);
      expect(save).toHaveBeenCalledExactlyOnceWith("Only remaining copy");
    } finally { storage.mockRestore(); }
  });

  it("does not send a detached editor's private draft after an account switch", async () => {
    store.setBrowserOnline(false);
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
    client.setQueryData(queryKeys.auth.session, { user: { id: "user-1" } });
    const save = vi.fn().mockResolvedValue(undefined);
    act(() => root.render(<QueryClientProvider client={client}><ConnectivityProvider store={store}>
      <Harness sourceId="private-document" storageKey="user-1:document" save={save} />
    </ConnectivityProvider></QueryClientProvider>));
    await act(async () => { current.persistDraft("Private text"); await current.run("Private text"); });
    act(() => root.unmount()); root = createRoot(container);
    client.setQueryData(queryKeys.auth.session, { user: { id: "user-2" } });
    await act(async () => { store.setBrowserOnline(true); store.reportSuccess(); });
    await advance(2_000);
    expect(save).not.toHaveBeenCalled();
    expect(localStorage.getItem("user-1:document")).toContain("Private text");
    expect(store.getSnapshot().pendingWrites).toBe(0);
    client.clear();
  });

  it("keeps an admitted startup save through the first account lookup", async () => {
    store.setBrowserOnline(false);
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false, enabled: false } } });
    const save = vi.fn().mockResolvedValue(undefined);
    act(() => root.render(<QueryClientProvider client={client}><ConnectivityProvider store={store}>
      <Harness sourceId="startup-title" save={save} />
    </ConnectivityProvider></QueryClientProvider>));
    await act(async () => { await current.run("Startup title"); });
    expect(current.status).toBe("waiting");
    act(() => client.setQueryData(queryKeys.auth.session, { user: { id: "user-1" } }));
    await advance(0);
    await act(async () => { store.setBrowserOnline(true); store.reportSuccess(); });
    await advance(2_000);
    expect(save).toHaveBeenCalledExactlyOnceWith("Startup title");
    expect(store.getSnapshot().pendingWrites).toBe(0);
    client.clear();
  });

  it("bounds retries after an editor unmounts", async () => {
    const save = vi.fn().mockRejectedValue(outage());
    render({ save });
    await act(async () => { await current.run("Pending text"); });
    act(() => root.unmount()); root = createRoot(container);
    for (let attempt = 0; attempt < 10; attempt++) await advance(30_000);
    expect(save).toHaveBeenCalledTimes(9);
    expect(store.getSnapshot().pendingWrites).toBe(0);
  });

  it("exposes a manual retry when automatic autosaves stop", async () => {
    const save = vi.fn().mockRejectedValue(outage());
    render({ save });
    await act(async () => { await current.run("Pending text"); });
    for (let attempt = 0; attempt < 10; attempt++) await advance(30_000);
    expect(current.status).toBe("stalled");
    const before = save.mock.calls.length;
    await act(async () => { current.resendNow(); });
    expect(save.mock.calls.length).toBe(before + 1);
  });

  it("treats a 409 whose server copy equals the draft as saved", async () => {
    // The first save landed but its response was lost; the retry's base
    // revision is stale, so the server answers 409 with our own text.
    let serverBody = "Old text";
    const save = vi.fn(async (draft: string) => {
      if (save.mock.calls.length === 1) {
        serverBody = draft;
        throw outage();
      }
      if (serverBody === draft) throw conflict();
      serverBody = draft;
    });
    const matchesServer = vi.fn(async (_error: unknown, draft: string) => serverBody === draft);
    render({ save, matchesServer });

    let result: Awaited<ReturnType<typeof current.run>> | undefined;
    await act(async () => {
      result = await current.run("New text");
    });
    expect(result).toEqual({ kind: "waiting" });
    expect(current.status).toBe("waiting");
    expect(current.label).toBe("Will save when reconnected");
    expect(store.getSnapshot().pendingWrites).toBe(1);

    await advance(1_000);
    expect(save).toHaveBeenCalledTimes(2);
    expect(matchesServer).toHaveBeenCalledWith(expect.any(ApiError), "New text");
    expect(current.status).toBe("saved");
    expect(current.label).toBe("Saved");
    expect(store.getSnapshot().pendingWrites).toBe(0);
  });

  it("reports a 409 for different server text as a failure for the caller's conflict view", async () => {
    const save = vi.fn().mockRejectedValue(conflict());
    render({ save, matchesServer: () => false });
    let result: Awaited<ReturnType<typeof current.run>> | undefined;
    await act(async () => {
      result = await current.run("Mine");
    });
    expect(result).toMatchObject({ kind: "failed" });
    expect(current.status).toBe("error");
    expect(current.label).toBe("Couldn't save (Document was updated by someone else)");
  });

  it("holds the draft during an outage and saves the newest one after recovery", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    render({ save });
    store.reportError(outage());
    await advance(0);
    expect(store.getSnapshot().status).toBe("reconnecting");

    await act(async () => {
      await current.run("First edit");
    });
    await act(async () => {
      await current.run("First edit, then more");
    });
    // Nothing is sent into the outage.
    expect(save).not.toHaveBeenCalled();
    expect(current.label).toBe("Will save when reconnected");

    probe.mockResolvedValue({ reachable: true });
    await act(async () => {
      store.probeNow();
      await vi.advanceTimersByTimeAsync(0);
    });
    await advance(0);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith("First edit, then more");
    expect(current.status).toBe("saved");
  });

  it("saves a queued draft with the save function it was queued with", async () => {
    // The editor stays mounted while the user opens another record; the
    // waiting edit still belongs to the first one.
    const saveFirst = vi.fn().mockResolvedValue(undefined);
    const saveSecond = vi.fn().mockResolvedValue(undefined);
    render({ save: saveFirst });
    store.reportError(outage());
    await advance(0);
    await act(async () => {
      await current.run("Title for the first task");
    });
    expect(current.status).toBe("waiting");

    render({ save: saveSecond });
    probe.mockResolvedValue({ reachable: true });
    await act(async () => {
      store.probeNow();
      await vi.advanceTimersByTimeAsync(0);
    });
    await advance(0);
    expect(saveFirst).toHaveBeenCalledTimes(1);
    expect(saveFirst).toHaveBeenCalledWith("Title for the first task");
    expect(saveSecond).not.toHaveBeenCalled();
  });

  it("hands a definitive failure of a background retry to the job's caller", async () => {
    const save = vi.fn()
      .mockRejectedValueOnce(outage())
      .mockRejectedValueOnce(conflict());
    const onRetryFailed = vi.fn();
    render({ save: vi.fn() });
    await act(async () => {
      await current.run("Mine", { save, onRetryFailed });
    });
    expect(current.status).toBe("waiting");
    expect(onRetryFailed).not.toHaveBeenCalled();

    await advance(1_000);
    expect(save).toHaveBeenCalledTimes(2);
    expect(current.status).toBe("error");
    expect(onRetryFailed).toHaveBeenCalledTimes(1);
    expect(onRetryFailed).toHaveBeenCalledWith(expect.objectContaining({ status: 409 }));
  });

  it("never rejects and shows readable copy for a definitive failure", async () => {
    const save = vi.fn().mockRejectedValue(new ApiError("tenant_access_denied", 403, { error: "tenant_access_denied" }));
    render({ save });
    await expect(current.run("Text")).resolves.toMatchObject({ kind: "failed" });
    await advance(0);
    expect(current.status).toBe("error");
    expect(current.label).toBe("Couldn't save (You don’t have permission to do that)");
    await advance(60_000);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("keeps a stored draft until that exact text is saved", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    render({ save, storageKey: "draft:doc" });
    act(() => current.persistDraft("Unsaved words"));
    expect(current.readStoredDraft()).toBe("Unsaved words");
    await act(async () => {
      await current.run("Older words");
    });
    expect(current.readStoredDraft()).toBe("Unsaved words");
    await act(async () => {
      await current.run("Unsaved words");
    });
    expect(current.readStoredDraft()).toBeNull();
  });

  it("labels each state", () => {
    expect(autosaveLabel("idle", null)).toBeNull();
    expect(autosaveLabel("saving", null)).toBe("Saving…");
    expect(autosaveLabel("saved", null)).toBe("Saved");
    expect(autosaveLabel("waiting", null)).toBe("Will save when reconnected");
    expect(autosaveLabel("error", { title: "x", body: "Not allowed.", retryable: false })).toBe("Couldn't save (Not allowed)");
  });
});
