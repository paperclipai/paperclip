// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hasPendingWrites, subscribePendingWrites } from "@/lib/reload-safety";
import { startServiceWorkerUpdates } from "@/lib/service-worker-updates";
import { ApiError } from "@/api/client";
import { authApi } from "@/api/auth";
import { useSignOut } from "./useSignOut";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { queryKeys } from "@/lib/queryKeys";
import { markCachedSession } from "@/lib/cached-session";
import { startPersistedQueryCache } from "@/lib/persisted-query-cache";
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

  it("defers a hidden-tab update across online autosave retries until the document is saved", async () => {
    let reject!: (error: unknown) => void;
    const save = vi.fn().mockImplementationOnce(() => new Promise((_, no) => { reject = no; }))
      .mockRejectedValueOnce(new ApiError("Try again", 429, null)).mockResolvedValue(undefined);
    render({ save });
    let pending!: ReturnType<typeof current.run>;
    act(() => { pending = current.run("Keep this document"); });
    const worker = Object.assign(new EventTarget(), { controller: {}, register: vi.fn().mockResolvedValue({ update: vi.fn() }) });
    const doc = Object.assign(new EventTarget(), { visibilityState: "hidden" });
    const reload = vi.fn();
    const stop = startServiceWorkerUpdates({ container: worker as unknown as ServiceWorkerContainer,
      documentRef: doc as unknown as Document, reload,
      canReload: () => store.getSnapshot().pendingWrites === 0 && !hasPendingWrites(),
      subscribeReloadSafety: listener => {
        const cleanups = [store.subscribe(listener), subscribePendingWrites(listener)];
        return () => cleanups.forEach(cleanup => cleanup());
      } });
    try {
      worker.dispatchEvent(new Event("controllerchange"));
      await act(async () => { reject(new ApiError("Try again", 429, null)); await pending; });
      expect(store.getSnapshot().status).toBe("online");
      expect(reload).not.toHaveBeenCalled();
      await advance(1_000);
      expect(save).toHaveBeenCalledTimes(2);
      expect(reload).not.toHaveBeenCalled();
      await advance(2_000);
      expect(save).toHaveBeenCalledTimes(3);
      expect(current.status).toBe("saved");
      expect(reload).toHaveBeenCalledOnce();
    } finally { stop(); }
  });

  it("cancels a restored write if the account changes during its fresh-base check", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, enabled: false } } });
    client.setQueryData(queryKeys.auth.session, { user: { id: "user-1" } });
    let finish!: () => void;
    const beforeSave = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const save = vi.fn().mockResolvedValue(undefined);
    act(() => root.render(<QueryClientProvider client={client}><ConnectivityProvider store={store}><Harness sourceId="base-check" save={save} /></ConnectivityProvider></QueryClientProvider>));
    let pending!: ReturnType<typeof current.run>;
    act(() => { pending = current.run("Old account draft", { beforeSave }); });
    expect(beforeSave).toHaveBeenCalledOnce();
    await act(async () => { client.setQueryData(queryKeys.auth.session, { user: { id: "user-2" } }); finish(); await pending; });
    expect(save).not.toHaveBeenCalled();
    client.clear();
  });

  it("rechecks the saved base before retrying a restored write", async () => {
    const beforeSave = vi.fn<() => Promise<void>>().mockResolvedValueOnce(undefined).mockRejectedValue(conflict());
    const save = vi.fn().mockRejectedValue(outage());
    render({ save });
    await act(async () => { expect(await current.run("Restored draft", { beforeSave })).toEqual({ kind: "waiting" }); });
    await advance(1_000);
    expect(beforeSave).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenCalledOnce();
    expect(current.status).toBe("error");
  });

  it("blocks background reload during debounce and until the newest edit is saved", async () => {
    let complete!: () => void;
    const save = vi.fn().mockImplementationOnce(() => new Promise<void>(resolve => { complete = resolve; })).mockResolvedValue(undefined);
    render({ save });
    act(() => current.markDirty());
    expect(hasPendingWrites()).toBe(true);
    let saving!: ReturnType<typeof current.run>;
    act(() => { saving = current.run("First draft"); });
    act(() => current.markDirty());
    await act(async () => { complete(); await saving; });
    expect(hasPendingWrites()).toBe(true);
    await act(async () => { await current.run("Second draft"); });
    expect(hasPendingWrites()).toBe(false);
    act(() => current.markDirty());
    act(() => current.reset());
    expect(hasPendingWrites()).toBe(false);
  });

  it.each(["draft", "saving", "waiting"] as const)("releases a departed target's dirty token while preserving %s work", async mode => {
    let finish!: () => void;
    const save = vi.fn<() => Promise<void>>();
    if (mode === "saving") save.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    else if (mode === "waiting") save.mockRejectedValueOnce(outage());
    save.mockResolvedValue(undefined);
    render({ targetKey: "task-a:description", save });
    act(() => current.markDirty());
    let pending: ReturnType<typeof current.run> | undefined;
    if (mode === "saving") act(() => { pending = current.run("Admitted A draft"); });
    if (mode === "waiting") await act(async () => { await current.run("Admitted A draft"); });
    render({ targetKey: "task-b:description", save });
    expect(current.status).toBe("idle");
    expect(hasPendingWrites()).toBe(mode === "saving");
    expect(store.getSnapshot().pendingWrites).toBe(mode === "draft" ? 0 : 1);
    if (mode === "saving") await act(async () => { finish(); await pending; });
    if (mode === "waiting") await act(async () => { current.resendNow(); });
    expect(hasPendingWrites()).toBe(false);
    expect(store.getSnapshot().pendingWrites).toBe(0);
    expect(current.status).toBe("idle");
    expect(save).toHaveBeenCalledTimes(mode === "draft" ? 0 : mode === "saving" ? 1 : 2);
    if (mode !== "draft") expect(save).toHaveBeenCalledWith("Admitted A draft");
  });

  it.each(["user-1", "user-2"])("verifies a restored identity before a mounted plain autosave (%s)", async verifiedUser => {
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false, enabled: false } } });
    client.setQueryData(queryKeys.auth.session, { user: { id: "user-1" } });
    const cache = startPersistedQueryCache(client, { storage: null, buildId: "test", eventTarget: null });
    markCachedSession(client);
    let complete!: (id: string) => void;
    const lookup = vi.spyOn(authApi, "getSession").mockReturnValue(new Promise(resolve => {
      complete = id => resolve({ user: { id } } as never);
    }));
    const save = vi.fn().mockResolvedValue(undefined);
    try {
      act(() => root.render(<QueryClientProvider client={client}><ConnectivityProvider store={store}>
        <Harness sourceId="cached-document" save={save} />
      </ConnectivityProvider></QueryClientProvider>));
      let saving!: ReturnType<typeof current.run>;
      act(() => { saving = current.run("Private text"); });
      expect(lookup).toHaveBeenCalled();
      expect(save).not.toHaveBeenCalled();
      await act(async () => { complete(verifiedUser); await saving; });
      expect(save).toHaveBeenCalledTimes(verifiedUser === "user-1" ? 1 : 0);
    } finally {
      act(() => root.unmount()); root = createRoot(container);
      cache.dispose(); client.clear(); lookup.mockRestore();
    }
  });

  it("shows waiting after restored-session verification fails without sending the edit", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false, enabled: false } } });
    client.setQueryData(queryKeys.auth.session, { user: { id: "user-1" } });
    const cache = startPersistedQueryCache(client, { storage: null, buildId: "test", eventTarget: null });
    markCachedSession(client);
    const lookup = vi.spyOn(authApi, "getSession").mockRejectedValue(new ApiError("session_lookup_failed", 500, null));
    const save = vi.fn().mockResolvedValue(undefined);
    try {
      act(() => root.render(<QueryClientProvider client={client}><ConnectivityProvider store={store}>
        <Harness sourceId="waiting-for-session" save={save} />
      </ConnectivityProvider></QueryClientProvider>));
      let saving!: ReturnType<typeof current.run>;
      act(() => { saving = current.run("Retained edit"); });
      await advance(750);
      await act(async () => { expect(await saving).toEqual({ kind: "waiting" }); });
      await advance(200);
      expect(current.status).toBe("waiting");
      expect(current.label).toBe("Will save when reconnected");
      expect(save).not.toHaveBeenCalled();
      lookup.mockResolvedValue({ user: { id: "user-1" } } as never);
      await advance(2_000);
      expect(save).toHaveBeenCalledExactlyOnceWith("Retained edit");
    } finally {
      act(() => root.unmount()); root = createRoot(container);
      cache.dispose(); client.clear(); lookup.mockRestore();
    }
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

  it.each(["same-target", "different-target"])("preserves newer completed saves across first identity resolution (%s)", async target => {
    let server = "Original";
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false, enabled: false } } });
    const oldSave = vi.fn().mockRejectedValueOnce(outage()).mockImplementation(async value => { server = value; });
    const show = (sourceId: string, targetKey: string, save: (value: string) => Promise<unknown>) => act(() => {
      root.render(<QueryClientProvider client={client}><ConnectivityProvider store={store}>
        <Harness sourceId={sourceId} targetKey={targetKey} save={save} />
      </ConnectivityProvider></QueryClientProvider>);
    });
    show("old-startup-editor", "task-a:title", oldSave);
    await act(async () => { expect(await current.run("Older title")).toEqual({ kind: "waiting" }); });
    act(() => { root.unmount(); root = createRoot(container); });
    act(() => client.setQueryData(queryKeys.auth.session, { user: { id: "user-1" } }));
    const newSave = vi.fn(async value => { if (target === "same-target") server = value; });
    show("new-known-editor", target === "same-target" ? "task-a:title" : "task-b:title", newSave);
    await act(async () => { expect(await current.run("Newer title")).toEqual({ kind: "saved" }); });
    expect(newSave).toHaveBeenCalledExactlyOnceWith("Newer title");
    // The newer save has finished and released its registry entry before the
    // detached startup job gets its first chance to adopt the account.
    await advance(30_000);
    expect(server).toBe(target === "same-target" ? "Newer title" : "Older title");
    expect(oldSave).toHaveBeenCalledTimes(target === "same-target" ? 1 : 2);
    expect(store.getSnapshot().pendingWrites).toBe(0);
    client.clear();
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

  it.each([false, true])("keeps an unowned startup edit when identity and unmount race (identityFirst=%s)", async identityFirst => {
    store.setBrowserOnline(false);
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false, enabled: false } } });
    const save = vi.fn().mockResolvedValue(undefined);
    act(() => root.render(<QueryClientProvider client={client}><ConnectivityProvider store={store}>
      <Harness sourceId="startup-remount" targetKey="task-a:title" save={save} />
    </ConnectivityProvider></QueryClientProvider>));
    await act(async () => { await current.run("Retained startup title"); });
    expect(current.status).toBe("waiting");
    act(() => {
      if (identityFirst) client.setQueryData(queryKeys.auth.session, { user: { id: "user-1" } });
      root.unmount(); root = createRoot(container);
      if (!identityFirst) client.setQueryData(queryKeys.auth.session, { user: { id: "user-1" } });
    });
    await act(async () => { store.setBrowserOnline(true); store.reportSuccess(); });
    await advance(2_000);
    expect(save).toHaveBeenCalledExactlyOnceWith("Retained startup title");
    expect(store.getSnapshot().pendingWrites).toBe(0);
    client.clear();
  });

  it.each(["different-account", "round-trip", "removed-session", "signed-out"])(
    "does not adopt a later identity for a detached startup edit (%s)", async transition => {
      store.setBrowserOnline(false);
      const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false, enabled: false } } });
      const save = vi.fn().mockResolvedValue(undefined);
      act(() => root.render(<QueryClientProvider client={client}><ConnectivityProvider store={store}>
        <Harness sourceId="private-startup" targetKey="private-title" save={save} />
      </ConnectivityProvider></QueryClientProvider>));
      await act(async () => { await current.run("Private startup title"); });
      act(() => { root.unmount(); root = createRoot(container); });
      act(() => {
        if (transition === "removed-session") client.removeQueries({ queryKey: queryKeys.auth.session });
        else client.setQueryData(queryKeys.auth.session, transition === "signed-out" ? null : { user: { id: "user-1" } });
        if (transition === "round-trip") client.setQueryData(queryKeys.auth.session, { user: { id: "user-2" } });
        client.setQueryData(queryKeys.auth.session, { user: { id: transition === "different-account" ? "user-2" : "user-1" } });
      });
      await act(async () => { store.setBrowserOnline(true); store.reportSuccess(); });
      await advance(2_000);
      expect(save).not.toHaveBeenCalled();
      expect(store.getSnapshot().pendingWrites).toBe(0);
      client.clear();
    },
  );

  it("invalidates an unknown-account detached draft through the real sign-out reset", async () => {
    store.setBrowserOnline(false);
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false, enabled: false } } });
    client.setQueryData(queryKeys.health, { status: "ok", deploymentMode: "authenticated" });
    const lookup = vi.spyOn(authApi, "getSession").mockReturnValue(new Promise(() => {}));
    const signOutApi = vi.spyOn(authApi, "signOut").mockResolvedValue({ success: true });
    const save = vi.fn().mockResolvedValue(undefined);
    let signOut!: ReturnType<typeof useSignOut>;
    function SignOut() { signOut = useSignOut(); return null; }
    try {
      act(() => root.render(<QueryClientProvider client={client}><ConnectivityProvider store={store}>
        <Harness sourceId="unknown-account-draft" save={save} />
      </ConnectivityProvider></QueryClientProvider>));
      await act(async () => { await current.run("Private title before sign-out"); });
      act(() => { root.unmount(); root = createRoot(container); });
      act(() => root.render(<QueryClientProvider client={client}><SignOut /></QueryClientProvider>));
      await act(async () => { await signOut.mutateAsync(); });
      expect(signOutApi).toHaveBeenCalledOnce();
      expect(client.getQueryData(queryKeys.auth.session)).toBeUndefined();
      act(() => client.setQueryData(queryKeys.auth.session, { user: { id: "next-account" } }));
      await act(async () => { store.setBrowserOnline(true); store.reportSuccess(); });
      await advance(2_000);
      expect(save).not.toHaveBeenCalled();
      expect(store.getSnapshot().pendingWrites).toBe(0);
    } finally { client.clear(); lookup.mockRestore(); signOutApi.mockRestore(); }
  });

  it.each([403, 404])("retains detached startup work after a definitive session lookup error (%s)", async status => {
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false, enabled: false } } });
    const lookup = vi.spyOn(authApi, "getSession").mockRejectedValue(new ApiError("Session lookup unavailable", status, {}));
    const save = vi.fn().mockRejectedValueOnce(outage()).mockResolvedValue(undefined);
    try {
      act(() => root.render(<QueryClientProvider client={client}><ConnectivityProvider store={store}>
        <Harness sourceId="startup-lookup-error" save={save} />
      </ConnectivityProvider></QueryClientProvider>));
      await act(async () => { await current.run("Retained title"); });
      act(() => { root.unmount(); root = createRoot(container); });
      await advance(0);
      expect(lookup).toHaveBeenCalled();
      expect(save).toHaveBeenCalledTimes(1);
      expect(store.getSnapshot().pendingWrites).toBe(1);
      act(() => client.setQueryData(queryKeys.auth.session, { user: { id: "first-account" } }));
      await advance(30_000);
      expect(save).toHaveBeenCalledTimes(2);
      expect(save).toHaveBeenLastCalledWith("Retained title");
      expect(store.getSnapshot().pendingWrites).toBe(0);
    } finally { client.clear(); lookup.mockRestore(); }
  });

  it("bounds detached session discovery when the first identity never becomes available", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false, enabled: false } } });
    const lookup = vi.spyOn(authApi, "getSession").mockRejectedValue(new ApiError("Session unavailable", 403, {}));
    const save = vi.fn().mockRejectedValue(outage());
    try {
      act(() => root.render(<QueryClientProvider client={client}><ConnectivityProvider store={store}>
        <Harness sourceId="bounded-startup-lookup" save={save} />
      </ConnectivityProvider></QueryClientProvider>));
      await act(async () => { await current.run("Retained title"); });
      act(() => { root.unmount(); root = createRoot(container); });
      for (let attempt = 0; attempt < 10; attempt++) await advance(30_000);
      expect(lookup.mock.calls.length).toBeGreaterThan(1);
      expect(lookup.mock.calls.length).toBeLessThanOrEqual(9);
      expect(save).toHaveBeenCalledTimes(1);
      expect(store.getSnapshot().pendingWrites).toBe(0);
    } finally { client.clear(); lookup.mockRestore(); }
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
