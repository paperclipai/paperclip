// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api/client";
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
